import { z } from 'zod';
import { AGENT_INSTRUCTIONS, type AgentAuthStatus, type AgentDetection, type AgentEvent, type AgentExecutable, type AgentProvider, type AgentRunOptions } from '@research-studio/ai-core';
import type { AgentCapabilities } from '@research-studio/shared-types';
import { findNpmScript, findOnPath, fromConfiguredPath } from './discovery';
import { runQuick, spawnLines } from './process';
import { finishEvent, relativeTo } from './shared';

// Codex's non-interactive protocol: `codex exec --json` prints JSONL events
// (thread.started, turn.*, item.started/updated/completed, error).
const Item = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  command: z.string().optional(),
  status: z.string().optional(),
  exit_code: z.number().nullable().optional(),
  message: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  query: z.string().optional(),
  changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'delete', 'update']) })).optional(),
});
const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string() }),
  z.object({ type: z.literal('turn.started') }),
  z.object({
    type: z.literal('turn.completed'),
    usage: z.object({ input_tokens: z.number(), cached_input_tokens: z.number().optional(), output_tokens: z.number() }).partial().optional(),
  }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }).optional() }),
  z.object({ type: z.literal('item.started'), item: Item }),
  z.object({ type: z.literal('item.updated'), item: Item }),
  z.object({ type: z.literal('item.completed'), item: Item }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export interface CodexOptions {
  configuredPath?: string | undefined;
  env: Record<string, string | undefined>;
  /** Windows sandbox implementation (`unelevated` needs no admin setup). */
  windowsSandbox?: string;
}

export class CodexAgent implements AgentProvider {
  readonly id = 'codex';
  readonly kind = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly capabilities: AgentCapabilities = {
    // Codex reports whole messages, not token deltas.
    streaming: false,
    cancellation: true,
    resume: true,
    fileEdits: true,
    usageReporting: true,
    modelSelection: true,
    permissionProfiles: ['read', 'write-staged'],
  };
  private detected: Promise<AgentDetection> | null = null;

  constructor(private readonly options: CodexOptions) {}

  detect(): Promise<AgentDetection> {
    this.detected ??= this.doDetect();
    return this.detected;
  }

  private async doDetect(): Promise<AgentDetection> {
    let executable: AgentExecutable | null;
    if (this.options.configuredPath) {
      const configured = await fromConfiguredPath(this.options.configuredPath);
      if ('problem' in configured) return { available: false, executable: null, version: null, problem: `RS_CODEX_PATH: ${configured.problem}` };
      executable = configured;
    } else {
      const native = await findOnPath('codex', this.options.env);
      executable = native ? { command: native, prefixArgs: [] } : await findNpmScript('codex', '@openai/codex', 'bin/codex.js', this.options.env);
    }
    if (!executable) return { available: false, executable: null, version: null, problem: 'Codex CLI (`codex`) was not found on PATH.' };
    const out = await runQuick(executable, ['--version'], this.options.env);
    if (out.exitCode !== 0) return { available: false, executable, version: null, problem: `\`codex --version\` failed: ${out.error ?? out.stderr.trim().slice(0, 200)}` };
    return { available: true, executable, version: out.stdout.trim().replace(/^codex-cli\s+/, '') || null, problem: null };
  }

  async authStatus(): Promise<AgentAuthStatus> {
    const d = await this.detect();
    if (!d.executable) return { state: 'unknown', method: null, detail: d.problem };
    const out = await runQuick(d.executable, ['login', 'status'], this.options.env);
    const text = `${out.stdout}\n${out.stderr}`;
    const m = /Logged in using (.+)/i.exec(text);
    if (out.exitCode === 0 && m) return { state: 'authenticated', method: m[1]!.trim(), detail: null };
    if (/not logged in/i.test(text) || out.exitCode === 1) return { state: 'unauthenticated', method: null, detail: 'Run `codex login` in a terminal.' };
    return { state: 'unknown', method: null, detail: 'Could not read `codex login status`.' };
  }

  args(options: Pick<AgentRunOptions, 'permission' | 'model' | 'resumeSessionId' | 'workingDirectory'>): string[] {
    const sandbox = options.permission === 'write-staged' ? 'workspace-write' : 'read-only';
    const common = [
      '--json',
      '--skip-git-repo-check',
      // Predictable permissions: the user's config.toml (profiles, MCP servers,
      // approval settings) is not loaded. Login still comes from CODEX_HOME.
      '--ignore-user-config',
      '-c', `sandbox_mode="${sandbox}"`,
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
    ];
    if (process.platform === 'win32') common.push('-c', `windows.sandbox="${this.options.windowsSandbox ?? 'unelevated'}"`);
    if (options.model) common.push('--model', options.model);
    if (options.resumeSessionId) return ['exec', 'resume', ...common, options.resumeSessionId, '-'];
    return ['exec', ...common, '--sandbox', sandbox, '--cd', options.workingDirectory, '-'];
  }

  async *run(options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const d = await this.detect();
    if (!d.executable) {
      yield { type: 'done', status: 'failed', result: null, error: d.problem ?? 'Codex is not available.' };
      return;
    }
    const messages: string[] = [];
    let failure: string | null = null;
    let completed = false;
    for await (const e of spawnLines({
      executable: d.executable,
      args: this.args(options),
      cwd: options.workingDirectory,
      env: options.env,
      // Instructions travel with the first prompt; resumed sessions already have them.
      stdin: options.resumeSessionId ? options.prompt : `${AGENT_INSTRUCTIONS}

${options.prompt}`,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (e.type === 'stderr') {
        yield { type: 'log', text: e.text };
        continue;
      }
      if (e.type === 'exit') {
        yield finishEvent(e, completed && !failure, messages.at(-1) ?? null, failure);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(e.line);
      } catch {
        yield { type: 'log', text: e.line };
        continue;
      }
      const parsed = Event.safeParse(data);
      if (!parsed.success) continue; // newer event types are ignored
      const event = parsed.data;
      switch (event.type) {
        case 'thread.started':
          yield { type: 'session', sessionId: event.thread_id, model: options.model };
          break;
        case 'turn.completed':
          completed = true;
          if (event.usage) {
            yield {
              type: 'usage',
              usage: { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null, cachedInputTokens: event.usage.cached_input_tokens ?? null, costUsd: null },
            };
          }
          break;
        case 'turn.failed':
          failure = event.error?.message ?? 'The Codex turn failed.';
          break;
        case 'error':
          failure = event.message;
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = event.item;
          const phase = event.type === 'item.started' ? 'started' : item.status === 'failed' || (item.exit_code ?? 0) !== 0 ? 'failed' : 'completed';
          if (item.type === 'agent_message' && event.type === 'item.completed' && item.text) {
            messages.push(item.text);
            yield { type: 'message', text: item.text };
          } else if (item.type === 'command_execution' && event.type !== 'item.updated') {
            yield { type: 'tool', name: 'command', detail: item.command?.slice(0, 200) ?? null, phase };
          } else if (item.type === 'file_change' && event.type === 'item.completed' && item.status !== 'failed') {
            for (const change of item.changes ?? []) {
              yield { type: 'file-change', path: relativeTo(change.path, options.workingDirectory), change: change.kind };
            }
          } else if ((item.type === 'mcp_tool_call' || item.type === 'web_search') && event.type !== 'item.updated') {
            yield { type: 'tool', name: item.type === 'web_search' ? 'web search' : `${item.server ?? 'mcp'}.${item.tool ?? ''}`, detail: item.query ?? null, phase };
          } else if (item.type === 'error' && item.message) {
            yield { type: 'log', text: item.message };
          }
          break;
        }
        default:
          break;
      }
    }
  }
}
