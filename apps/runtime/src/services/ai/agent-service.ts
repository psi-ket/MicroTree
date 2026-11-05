import { readFile } from 'node:fs/promises';
import { createStreamRedactor, redactSecrets, type AgentProvider, type ModelProvider } from '@research-studio/ai-core';
import {
  buildAgentEnvironment,
  ClaudeCodeAgent,
  CliModelProvider,
  CodexAgent,
  CustomAgent,
  parseAgentsConfig,
  StagingWorkspace,
  type AgentEnvironment,
  type AgentsFile,
  type EnvironmentPolicy,
  type StagingResult,
} from '@research-studio/agent-adapters';
import type { AgentApproval, AiRepositories } from '@research-studio/ai-storage';
import {
  StudioError,
  type AgentActivity,
  type AgentDescriptor,
  type AgentPermissionProfile,
  type AgentRun,
  type AgentRunStatus,
  type CliModelProviderKind,
  type TokenUsage,
} from '@research-studio/shared-types';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeConfig } from '../../config';
import type { EventBus } from '../../events';
import { randomId } from '../../security/tokens';
import type { AuditService } from '../audit-service';
import type { Actor } from '../project-service';
import type { StagingLifecycle } from './staging-lifecycle';

export interface AgentTurnInput {
  projectId: string;
  projectRoot: string;
  conversationId: string;
  messageId: string;
  agentId: string;
  permission: AgentPermissionProfile;
  model: string | null;
  resumeSessionId: string | null;
  prompt: string;
  signal: AbortSignal;
  actor: Actor;
  /** Answer text as it arrives. */
  onText: (text: string) => void;
}

export interface AgentTurnResult {
  run: AgentRun;
  status: AgentRunStatus;
  error: string | null;
  usage: TokenUsage | null;
  sessionId: string | null;
  /** Changes in the staging copy (completed runs only). */
  staged: StagingResult | null;
}

const MAX_ACTIVITY_LOGS = 200;

interface AgentEntry {
  agent: AgentProvider;
  /** The environment this agent runs with, built from its policy. */
  environment: AgentEnvironment;
}

/**
 * Supervises command-line agents. Agents only run in projects the user
 * approved for that agent and permission profile, always in a staging copy of
 * the project (never the project directory), with a filtered environment and
 * a time limit. Their changes come back as proposals for review.
 */
export class AgentService {
  private agents: Promise<Map<string, AgentEntry>> | null = null;

  constructor(
    private readonly repos: AiRepositories,
    private readonly config: RuntimeConfig,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
    private readonly env: Record<string, string | undefined>,
    private readonly staging: StagingLifecycle,
    /** Replaces the built-in registry (tests). */
    private readonly registry?: () => AgentProvider[],
  ) {}

  get enabled(): boolean {
    return this.config.ai.agentsEnabled;
  }

  private load(refresh = false) {
    if (refresh || !this.agents) this.agents = this.build();
    return this.agents;
  }

  /** The operator's agents file: custom agents and environment policies. Invalid files are ignored as a whole. */
  private async agentsFile(): Promise<AgentsFile> {
    const empty: AgentsFile = { agents: [], environment: {} };
    let raw: string;
    try {
      raw = await readFile(this.config.ai.agentsFile, 'utf8');
    } catch {
      return empty; // No agents file.
    }
    try {
      return parseAgentsConfig(JSON.parse(raw));
    } catch (err) {
      this.log.warn({ file: this.config.ai.agentsFile, err: err instanceof Error ? err.message : String(err) }, 'ignoring invalid agents file');
      return empty;
    }
  }

  private async build() {
    const file = await this.agentsFile();
    const policyFor = (agentId: string): EnvironmentPolicy | undefined =>
      agentId === 'claude-code' || agentId === 'codex' ? file.environment[agentId] : file.agents.find((a) => a.id === agentId)?.environment;
    const environment = (agentId: string) => buildAgentEnvironment(this.env, agentId, policyFor(agentId));
    const map = new Map<string, AgentEntry>();
    if (this.registry) {
      for (const agent of this.registry()) map.set(agent.id, { agent, environment: environment(agent.id) });
      return map;
    }
    const claude = environment('claude-code');
    const codex = environment('codex');
    map.set('claude-code', { agent: new ClaudeCodeAgent({ configuredPath: this.config.ai.claudePath, env: claude.env }), environment: claude });
    map.set('codex', {
      agent: new CodexAgent({ configuredPath: this.config.ai.codexPath, env: codex.env, windowsSandbox: this.config.ai.codexWindowsSandbox }),
      environment: codex,
    });
    for (const cfg of file.agents) {
      const env = environment(cfg.id);
      map.set(cfg.id, { agent: new CustomAgent(cfg, env.env), environment: env });
    }
    return map;
  }

  async list(refresh = false): Promise<AgentDescriptor[]> {
    if (!this.enabled) return [];
    const map = await this.load(refresh);
    return Promise.all([...map.values()].map(({ agent }) => this.describe(agent)));
  }

  private async describe(agent: AgentProvider): Promise<AgentDescriptor> {
    const stagingProblem = this.staging.problem();
    const detection = await agent.detect();
    const auth = detection.available ? await agent.authStatus() : { state: 'unknown' as const, method: null, detail: null };
    return {
      id: agent.id,
      kind: agent.kind,
      displayName: agent.displayName,
      available: detection.available && !stagingProblem,
      version: detection.version,
      executable: detection.executable ? [detection.executable.command, ...detection.executable.prefixArgs].join(' ') : null,
      auth,
      capabilities: agent.capabilities,
      problem: stagingProblem ?? detection.problem,
    };
  }

  async get(agentId: string): Promise<AgentProvider> {
    return (await this.entry(agentId)).agent;
  }

  /**
   * Claude Code or Codex as a plain model (`claude-cli` and `codex-cli`
   * providers): the agent's executable and filtered environment, every tool
   * off and an empty working folder. No project approval is involved because
   * nothing in a project is read or written; the caller sends the text.
   */
  async modelProvider(kind: CliModelProviderKind): Promise<ModelProvider> {
    const entry = await this.entry(kind === 'claude-cli' ? 'claude-code' : 'codex');
    const detection = await entry.agent.detect();
    if (!detection.available || !detection.executable) {
      throw new StudioError('NOT_CONFIGURED', detection.problem ?? `${entry.agent.displayName} was not found on this computer.`);
    }
    return new CliModelProvider({
      kind,
      executable: detection.executable,
      env: entry.environment.env,
      secrets: entry.environment.secrets,
      timeoutMs: this.config.ai.requestTimeoutMs,
      windowsSandbox: this.config.ai.codexWindowsSandbox,
    });
  }

  private async entry(agentId: string): Promise<AgentEntry> {
    if (!this.enabled) throw new StudioError('AGENT_UNAVAILABLE', 'CLI agents are disabled on this runtime (RS_AGENTS=off).');
    const entry = (await this.load()).get(agentId);
    if (!entry) throw new StudioError('NOT_FOUND', 'Agent not found', { agentId });
    return entry;
  }

  approvals(projectId: string): AgentApproval[] {
    return this.repos.approvals.list(projectId);
  }

  async setApproval(projectId: string, agentId: string, permission: AgentPermissionProfile, approved: boolean, actor: Actor): Promise<AgentApproval[]> {
    const agent = await this.get(agentId);
    if (approved && !agent.capabilities.permissionProfiles.includes(permission)) {
      throw new StudioError('BAD_REQUEST', `${agent.displayName} does not support the "${permission}" profile.`);
    }
    this.repos.approvals.set(projectId, agentId, permission, approved);
    this.audit.record({
      action: approved ? 'ai.agent.approve' : 'ai.agent.revoke',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: agentId,
      details: { permission },
    });
    return this.approvals(projectId);
  }

  /** Throws unless the agent may run in this project with this profile. */
  async assertRunnable(projectId: string, agentId: string, permission: AgentPermissionProfile, actor: Actor): Promise<AgentProvider> {
    const agent = await this.get(agentId);
    const deny = (message: string, code: 'FORBIDDEN' | 'AGENT_UNAVAILABLE' = 'FORBIDDEN') => {
      this.audit.record({ action: 'ai.agent.start', outcome: 'denied', actor: actor.sessionId, projectId, target: agentId, details: { permission, reason: message } });
      return new StudioError(code, message);
    };
    if (!agent.capabilities.permissionProfiles.includes(permission)) throw deny(`${agent.displayName} does not support the "${permission}" profile.`);
    if (!this.repos.approvals.isApproved(projectId, agentId, permission)) {
      throw deny(`${agent.displayName} is not approved for this project with "${permission}" permissions.`);
    }
    const stagingProblem = this.staging.problem();
    if (stagingProblem) throw deny(stagingProblem, 'AGENT_UNAVAILABLE');
    const detection = await agent.detect();
    if (!detection.available) throw deny(detection.problem ?? `${agent.displayName} is not available.`, 'AGENT_UNAVAILABLE');
    return agent;
  }

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const agent = await this.assertRunnable(input.projectId, input.agentId, input.permission, input.actor);
    const { environment } = await this.entry(agent.id);
    // Credentials the operator chose to forward never reach the UI, the database or the audit log.
    const redact = (text: string) => redactSecrets(text, environment.secrets);
    const textRedactor = createStreamRedactor(environment.secrets);
    let run = this.repos.agentRuns.create({
      id: randomId(8),
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      agentId: agent.id,
      permission: input.permission,
      model: input.model,
    });
    this.audit.record({
      action: 'ai.agent.start',
      outcome: 'success',
      actor: input.actor.sessionId,
      projectId: input.projectId,
      target: agent.id,
      details: { runId: run.id, permission: input.permission, model: input.model, resumed: !!input.resumeSessionId },
    });
    const publish = (activity: Omit<AgentActivity, 'at'> | null) =>
      this.events.publish({
        type: 'ai.agent.event',
        projectId: input.projectId,
        conversationId: input.conversationId,
        run,
        activity: activity
          ? { ...activity, label: redact(activity.label), detail: activity.detail === null ? null : redact(activity.detail), at: new Date().toISOString() }
          : null,
      });

    const copyId = input.conversationId;
    const staging = new StagingWorkspace({ projectRoot: input.projectRoot, stagingRoot: this.staging.root, sessionId: copyId }, this.staging.limitsFor(copyId));
    // Nothing else (e.g. the cleanup sweep) touches this copy until the run is over.
    const releaseCopy = await this.staging.claim(copyId);
    this.staging.activate({ sessionId: copyId, projectId: input.projectId, agentId: agent.id });
    let status: AgentRunStatus = 'failed';
    let error: string | null = null;
    let usage: TokenUsage | null = null;
    let sessionId: string | null = null;
    let staged: StagingResult | null = null;
    const changedByAgent = new Set<string>();
    let logs = 0;
    try {
      const copied = await staging.prepare();
      this.staging.recordSize(copyId, copied);
      run = this.repos.agentRuns.update(run.id, { status: 'running' }) ?? run;
      publish({ kind: 'status', label: 'Started', detail: `${copied.files} project files staged` });
      for await (const event of agent.run({
        prompt: input.prompt,
        workingDirectory: staging.dir,
        permission: input.permission,
        model: input.model,
        resumeSessionId: input.resumeSessionId,
        timeoutMs: this.config.ai.agentTimeoutMs,
        signal: input.signal,
        env: environment.env,
      })) {
        switch (event.type) {
          case 'session':
            sessionId = event.sessionId;
            run = this.repos.agentRuns.update(run.id, { externalSessionId: event.sessionId, model: event.model ?? input.model }) ?? run;
            break;
          case 'text-delta':
            input.onText(textRedactor.push(event.text));
            break;
          case 'message':
            input.onText(textRedactor.push(`${event.text}\n\n`));
            break;
          case 'tool':
            publish({ kind: 'tool', label: `${event.name} ${event.phase}`, detail: event.detail });
            break;
          case 'file-change':
            changedByAgent.add(event.path);
            publish({ kind: 'file-change', label: `${event.change} ${event.path}`, detail: null });
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'log':
            if (logs++ < MAX_ACTIVITY_LOGS) publish({ kind: 'log', label: event.text.slice(0, 500), detail: null });
            break;
          case 'done':
            status = event.status;
            error = event.error === null ? null : redact(event.error);
            break;
        }
      }
      input.onText(textRedactor.flush());
      if (status === 'completed') staged = await staging.diff();
    } catch (err) {
      status = 'failed';
      error = redact(err instanceof Error ? err.message : String(err));
    }
    // The copy has served its purpose (proposals hold the file contents); remove it now.
    const stagingRemoved = await this.staging.remove(copyId, 'run-finished');
    releaseCopy();
    const changedFiles = staged ? staged.changes.map((c) => c.path) : [...changedByAgent];
    run =
      this.repos.agentRuns.update(run.id, { status, error, usage, changedFiles, finishedAt: new Date().toISOString() }) ?? run;
    publish({ kind: 'status', label: status, detail: error });
    this.audit.record({
      action: 'ai.agent.finish',
      outcome: status === 'completed' || status === 'cancelled' ? 'success' : 'error',
      actor: input.actor.sessionId,
      projectId: input.projectId,
      target: agent.id,
      details: { runId: run.id, status, changedFiles: changedFiles.length, ignored: staged?.ignored.length ?? 0, stagingRemoved },
    });
    return { run, status, error, usage, sessionId, staged };
  }

  /** Remove a conversation's staging copy, if one was left behind (waits for a run that still uses it). */
  async discard(conversationId: string): Promise<void> {
    const release = await this.staging.claim(conversationId);
    try {
      await this.staging.remove(conversationId, 'conversation-deleted');
    } finally {
      release();
    }
  }
}
