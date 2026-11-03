import { z } from 'zod';
import { AGENT_INSTRUCTIONS, type AgentAuthStatus, type AgentDetection, type AgentEvent, type AgentExecutable, type AgentProvider, type AgentRunOptions } from '@research-studio/ai-core';
import type { AgentCapabilities, TokenUsage } from '@research-studio/shared-types';
import { findOnPath, fromConfiguredPath } from './discovery';
import { describeTool, finishEvent, relativeTo } from './shared';
import { runQuick, spawnLines } from './process';

// Claude Code's headless protocol: `claude -p --output-format stream-json`
// emits one JSON object per line (system/init, stream_event, assistant, user,
// result). Unknown types and fields are ignored; known ones are validated.
const Init = z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string(), model: z.string().optional() });
const StreamEvent = z.object({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullable().optional(),
  event: z.object({ type: z.string(), delta: z.object({ type: z.string(), text: z.string().optional() }).optional() }),
});
const ContentBlock = z.object({ type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(), is_error: z.boolean().optional(), tool_use_id: z.string().optional() });
const AssistantMsg = z.object({ type: z.literal('assistant'), parent_tool_use_id: z.string().nullable().optional(), message: z.object({ content: z.array(ContentBlock) }) });
const UserMsg = z.object({ type: z.literal('user'), parent_tool_use_id: z.string().nullable().optional(), message: z.object({ content: z.union([z.string(), z.array(ContentBlock)]) }) });
const Result = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional() })
    .optional(),
  permission_denials: z.array(z.object({ tool_name: z.string() })).optional(),
});
const AuthStatus = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional(), apiProvider: z.string().optional() });

/** Built-in tools per permission profile. Shell, web and MCP tools are never enabled. */
export const CLAUDE_TOOLS = {
  read: ['Read', 'Glob', 'Grep'],
  'write-staged': ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
} as const;

export interface ClaudeCodeOptions {
  /** `RS_CLAUDE_PATH`, or found on PATH. */
  configuredPath?: string | undefined;
  env: Record<string, string | undefined>;
}

export class ClaudeCodeAgent implements AgentProvider {
  readonly id = 'claude-code';
  readonly kind = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    cancellation: true,
    resume: true,
    fileEdits: true,
    usageReporting: true,
    modelSelection: true,
    permissionProfiles: ['read', 'write-staged'],
  };
  private detected: Promise<AgentDetection> | null = null;

  constructor(private readonly options: ClaudeCodeOptions) {}

  detect(): Promise<AgentDetection> {
    this.detected ??= this.doDetect();
    return this.detected;
  }

  private async doDetect(): Promise<AgentDetection> {
    let executable: AgentExecutable | null = null;
    if (this.options.configuredPath) {
      const configured = await fromConfiguredPath(this.options.configuredPath);
      if ('problem' in configured) return { available: false, executable: null, version: null, problem: `RS_CLAUDE_PATH: ${configured.problem}` };
      executable = configured;
    } else {
      const found = await findOnPath('claude', this.options.env);
      if (found) executable = { command: found, prefixArgs: [] };
    }
    if (!executable) return { available: false, executable: null, version: null, problem: 'Claude Code (`claude`) was not found on PATH.' };
    const out = await runQuick(executable, ['--version'], this.options.env);
    if (out.exitCode !== 0) return { available: false, executable, version: null, problem: `\`claude --version\` failed: ${out.error ?? out.stderr.trim().slice(0, 200)}` };
    return { available: true, executable, version: out.stdout.trim().split(/\s+/)[0] ?? null, problem: null };
  }

  async authStatus(): Promise<AgentAuthStatus> {
    const d = await this.detect();
    if (!d.executable) return { state: 'unknown', method: null, detail: d.problem };
    const out = await runQuick(d.executable, ['auth', 'status', '--json'], this.options.env);
    try {
      const status = AuthStatus.parse(JSON.parse(out.stdout));
      // Only the method is reported; account details stay out of the runtime's API.
      return status.loggedIn
        ? { state: 'authenticated', method: status.authMethod ?? null, detail: null }
        : { state: 'unauthenticated', method: null, detail: 'Run `claude auth login` in a terminal.' };
    } catch {
      return { state: 'unknown', method: null, detail: 'Could not read `claude auth status`.' };
    }
  }

  /** Command-line arguments for a run (exported for tests and documentation). */
  static args(options: Pick<AgentRunOptions, 'permission' | 'model' | 'resumeSessionId'>): string[] {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // No shell or code-running tools, no WebFetch, no user/project settings or
      // hooks; file tools confined to the working directory.
      '--restricted',
      '--strict-mcp-config',
      '--tools', CLAUDE_TOOLS[options.permission].join(','),
      // Anything that would need a prompt is denied.
      '--permission-mode', options.permission === 'write-staged' ? 'acceptEdits' : 'dontAsk',
      '--permission-prompts', 'none',
      '--append-system-prompt', AGENT_INSTRUCTIONS,
    ];
    if (options.model) args.push('--model', options.model);
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    return args;
  }

  async *run(options: AgentRunOptions): AsyncIterable<AgentEvent> {
    const d = await this.detect();
    if (!d.executable) {
      yield { type: 'done', status: 'failed', result: null, error: d.problem ?? 'Claude Code is not available.' };
      return;
    }
    let result: z.infer<typeof Result> | null = null;
    const pendingTools = new Map<string, string>();
    for await (const e of spawnLines({
      executable: d.executable,
      args: ClaudeCodeAgent.args(options),
      cwd: options.workingDirectory,
      env: options.env,
      stdin: options.prompt,
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (e.type === 'stderr') {
        yield { type: 'log', text: e.text };
        continue;
      }
      if (e.type === 'exit') {
        if (result) {
          const usage: TokenUsage = {
            inputTokens: result.usage ? (result.usage.input_tokens ?? 0) + (result.usage.cache_read_input_tokens ?? 0) + (result.usage.cache_creation_input_tokens ?? 0) : null,
            outputTokens: result.usage?.output_tokens ?? null,
            cachedInputTokens: result.usage?.cache_read_input_tokens ?? null,
            costUsd: result.total_cost_usd ?? null,
          };
          yield { type: 'usage', usage };
        }
        const ok = result !== null && result.subtype === 'success' && !result.is_error;
        const denied = result?.permission_denials?.map((p) => p.tool_name) ?? [];
        yield finishEvent(e, ok, result?.result ?? null, result && !ok ? `Claude Code ended with "${result.subtype}"${result.result ? `: ${result.result.slice(0, 300)}` : ''}` : null, denied);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(e.line);
      } catch {
        yield { type: 'log', text: e.line };
        continue;
      }
      const type = (data as { type?: unknown }).type;
      if (type === 'system') {
        const init = Init.safeParse(data);
        if (init.success) yield { type: 'session', sessionId: init.data.session_id, model: init.data.model ?? null };
      } else if (type === 'stream_event') {
        const s = StreamEvent.safeParse(data);
        // Text from sub-agents (parent_tool_use_id set) is not part of the answer.
        if (s.success && !s.data.parent_tool_use_id && s.data.event.type === 'content_block_delta' && s.data.event.delta?.type === 'text_delta' && s.data.event.delta.text) {
          yield { type: 'text-delta', text: s.data.event.delta.text };
        }
      } else if (type === 'assistant') {
        const a = AssistantMsg.safeParse(data);
        if (!a.success) continue;
        for (const block of a.data.message.content) {
          if (block.type !== 'tool_use' || !block.name) continue;
          const detail = describeTool(block.input, options.workingDirectory);
          if (block.id) pendingTools.set(block.id, block.name);
          yield { type: 'tool', name: block.name, detail, phase: 'started' };
          if ((block.name === 'Edit' || block.name === 'Write') && detail) {
            yield { type: 'file-change', path: relativeTo(detail, options.workingDirectory), change: block.name === 'Write' ? 'add' : 'update' };
          }
        }
      } else if (type === 'user') {
        const u = UserMsg.safeParse(data);
        if (!u.success || typeof u.data.message.content === 'string') continue;
        for (const block of u.data.message.content) {
          if (block.type !== 'tool_result') continue;
          const name = (block.tool_use_id && pendingTools.get(block.tool_use_id)) || 'tool';
          yield { type: 'tool', name, detail: null, phase: block.is_error ? 'failed' : 'completed' };
        }
      } else if (type === 'result') {
        const r = Result.safeParse(data);
        if (r.success) result = r.data;
      }
    }
  }
}
