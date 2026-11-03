import { z } from 'zod';
import { AGENT_INSTRUCTIONS, type AgentAuthStatus, type AgentDetection, type AgentEvent, type AgentProvider, type AgentRunOptions } from '@research-studio/ai-core';
import { AGENT_PERMISSION_PROFILES, type AgentCapabilities } from '@research-studio/shared-types';
import { fromConfiguredPath } from './discovery';
import { runQuick, spawnLines } from './process';
import { EnvironmentPolicySchema } from './environment';
import { finishEvent } from './shared';

/**
 * A custom agent is declared in the runtime's agents file (never by the
 * browser): a fixed executable and fixed arguments. The prompt arrives on
 * stdin; stdout is the answer. `{model}` in an argument is replaced by the
 * selected model, as one whole argument.
 */
export const CustomAgentConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'id must be 2–32 lowercase letters, digits or dashes'),
  displayName: z.string().min(1).max(60),
  command: z.string().min(1),
  args: z.array(z.string().max(500)).max(40).default([]),
  versionArgs: z.array(z.string()).max(5).nullable().default(['--version']),
  permissionProfiles: z.array(z.enum(AGENT_PERMISSION_PROFILES)).min(1).default(['read']),
  /** Prepend Research Studio's agent instructions to the prompt. */
  includeInstructions: z.boolean().default(true),
  /** Extra environment for this agent only (see environment.ts). */
  environment: EnvironmentPolicySchema.default({ allow: [], set: {} }),
});
export type CustomAgentConfig = z.infer<typeof CustomAgentConfigSchema>;

export const AgentsFileSchema = z
  .object({
    agents: z.array(CustomAgentConfigSchema).max(20).default([]),
    /** Environment additions for the built-in agents, keyed by agent id. */
    environment: z
      .object({ 'claude-code': EnvironmentPolicySchema.optional(), codex: EnvironmentPolicySchema.optional() })
      .strict()
      .default({}),
  })
  .strict();
export type AgentsFile = z.infer<typeof AgentsFileSchema>;

const RESERVED_IDS = new Set(['claude-code', 'codex']);

/** Parse and check the runtime's agents file (custom agents plus built-in environment policies). */
export function parseAgentsConfig(data: unknown): AgentsFile {
  const parsed = AgentsFileSchema.parse(data);
  const ids = new Set<string>();
  for (const agent of parsed.agents) {
    if (RESERVED_IDS.has(agent.id)) throw new Error(`Agent id "${agent.id}" is reserved`);
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id "${agent.id}"`);
    ids.add(agent.id);
  }
  return parsed;
}

/** Custom agents declared in the agents file. */
export function parseAgentsFile(data: unknown): CustomAgentConfig[] {
  return parseAgentsConfig(data).agents;
}

export class CustomAgent implements AgentProvider {
  readonly kind = 'custom' as const;
  readonly capabilities: AgentCapabilities;
  private detected: Promise<AgentDetection> | null = null;

  constructor(
    private readonly config: CustomAgentConfig,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.capabilities = {
      streaming: true,
      cancellation: true,
      resume: false,
      fileEdits: config.permissionProfiles.includes('write-staged'),
      usageReporting: false,
      modelSelection: config.args.some((a) => a.includes('{model}')),
      permissionProfiles: config.permissionProfiles,
    };
  }

  get id() {
    return this.config.id;
  }
  get displayName() {
    return this.config.displayName;
  }

  detect(): Promise<AgentDetection> {
    this.detected ??= (async () => {
      const exe = await fromConfiguredPath(this.config.command);
      if ('problem' in exe) return { available: false, executable: null, version: null, problem: exe.problem };
      if (!this.config.versionArgs) return { available: true, executable: exe, version: null, problem: null };
      const out = await runQuick(exe, this.config.versionArgs, this.env);
      return out.exitCode === 0
        ? { available: true, executable: exe, version: out.stdout.trim().split('\n')[0]?.slice(0, 60) ?? null, problem: null }
        : { available: false, executable: exe, version: null, problem: `Version check failed: ${out.error ?? out.stderr.trim().slice(0, 200)}` };
    })();
    return this.detected;
  }

  async authStatus(): Promise<AgentAuthStatus> {
    return { state: 'unknown', method: null, detail: 'Custom agents manage their own credentials.' };
  }

  async *run(options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const d = await this.detect();
    if (!d.executable) {
      yield { type: 'done', status: 'failed', result: null, error: d.problem ?? 'The agent is not available.' };
      return;
    }
    const args = this.config.args.flatMap((a) => (a === '{model}' ? (options.model ? [options.model] : []) : [a.replaceAll('{model}', options.model ?? '')]));
    let output = '';
    for await (const e of spawnLines({
      executable: d.executable,
      args,
      cwd: options.workingDirectory,
      env: options.env,
      stdin: this.config.includeInstructions ? `${AGENT_INSTRUCTIONS}\n\n${options.prompt}` : options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (e.type === 'stdout') {
        const text = `${e.line}\n`;
        output += text;
        yield { type: 'text-delta', text };
      } else if (e.type === 'stderr') {
        yield { type: 'log', text: e.text };
      } else {
        yield finishEvent(e, true, output.trim() || null, null);
        return;
      }
    }
  }
}
