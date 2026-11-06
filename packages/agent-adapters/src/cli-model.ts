import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  PROVIDER_KINDS,
  ProviderError,
  redactValues,
  validateRequestContent,
  type AgentExecutable,
  type ChatTurn,
  type ImageMimeType,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type StructuredOutputSpec,
  type StructuredResult,
} from '@research-studio/ai-core';
import { CLI_DEFAULT_MODEL, type CliModelProviderKind, type ModelCapabilities, type ModelInfo, type TokenUsage } from '@research-studio/shared-types';
import { spawnLines, type ProcessEvent } from './process';

// The Claude Code and Codex CLIs used as plain models: one answer per call,
// with the user's own sign-in. Every tool is disabled and each call runs in a
// new empty folder, so text from a manuscript or a paper cannot make the CLI
// read files, run commands or browse. A tool call is treated as a failure.

export interface CliModelOptions {
  kind: CliModelProviderKind;
  executable: AgentExecutable;
  /** Built with `buildAgentEnvironment` for the agent behind this kind. */
  env: Record<string, string>;
  /** Forwarded credentials, redacted from every error message. */
  secrets: readonly string[];
  timeoutMs: number;
  /** Parent of the per-call folders (default: the OS temporary folder). */
  workRoot?: string;
  /** Windows sandbox implementation for Codex (`unelevated` needs no admin setup). */
  windowsSandbox?: string;
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: CLI_DEFAULT_MODEL, displayName: 'Claude Code default', contextTokens: null },
  { id: 'opus', displayName: 'Opus (latest)', contextTokens: null },
  { id: 'sonnet', displayName: 'Sonnet (latest)', contextTokens: null },
  { id: 'haiku', displayName: 'Haiku (latest)', contextTokens: null },
];
const CODEX_MODELS: ModelInfo[] = [{ id: CLI_DEFAULT_MODEL, displayName: 'Codex default', contextTokens: null }];

/** Codex features that give the model tools; all are turned off for model calls. */
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'plugins', 'in_app_browser', 'view_image', 'code_mode_host'] as const;

const EXTENSION: Record<ImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Claude Code: `claude -p --output-format stream-json` (see claude-code.ts).
const ClaudeDelta = z.object({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullable().optional(),
  event: z.object({ type: z.string(), delta: z.object({ type: z.string(), text: z.string().optional() }).optional() }),
});
const ClaudeAssistant = z.object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.object({ type: z.string(), name: z.string().optional() })) }) });
const ClaudeResult = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional() })
    .optional(),
});

// Codex: `codex exec --json` (see codex.ts).
const CodexEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started') }),
  z.object({ type: z.literal('turn.started') }),
  z.object({
    type: z.literal('turn.completed'),
    usage: z.object({ input_tokens: z.number(), cached_input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
  }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }).optional() }),
  z.object({ type: z.enum(['item.started', 'item.updated', 'item.completed']), item: z.object({ type: z.string(), text: z.string().optional(), message: z.string().optional() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
/** Codex items that mean the model acted instead of answering. */
const CODEX_ACTION_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call']);

interface Image {
  mimeType: ImageMimeType;
  data: Uint8Array;
}

/** One prompt from the conversation: the CLIs take a single user message per call. */
export function renderConversation(messages: readonly ChatTurn[]): { text: string; images: Image[] } {
  const images: Image[] = [];
  const render = (turn: ChatTurn) => {
    if (typeof turn.content === 'string') return turn.content;
    return turn.content
      .map((part) => {
        if (part.type === 'text') return part.text;
        images.push({ mimeType: part.mimeType, data: part.data });
        return `[Image ${images.length}]`;
      })
      .join('\n\n');
  };
  const rendered = messages.map((turn) => ({ role: turn.role, text: render(turn) }));
  if (rendered.length === 1 && rendered[0]!.role === 'user') return { text: rendered[0]!.text, images };
  const last = rendered.at(-1);
  const earlier = last?.role === 'user' ? rendered.slice(0, -1) : rendered;
  const history = earlier.map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`).join('\n\n');
  const text = last?.role === 'user' ? `<earlier_conversation>\n${history}\n</earlier_conversation>\n\n${last.text}` : `<earlier_conversation>\n${history}\n</earlier_conversation>\n\nContinue the conversation.`;
  return { text, images };
}

export class CliModelProvider implements ModelProvider {
  readonly kind: CliModelProviderKind;
  readonly capabilities: ModelCapabilities;
  private readonly label: string;

  constructor(private readonly options: CliModelOptions) {
    this.kind = options.kind;
    this.capabilities = PROVIDER_KINDS[options.kind].capabilities;
    this.label = options.kind === 'claude-cli' ? 'Claude Code' : 'Codex';
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.kind === 'claude-cli' ? CLAUDE_MODELS : CODEX_MODELS);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    validateRequestContent(request, this.capabilities);
    const call = this.kind === 'claude-cli' ? this.claude(request, null) : this.codex(request, null);
    let answer: CallResult | null = null;
    for await (const e of call) {
      if (e.type === 'text-delta') yield e;
      else answer = e;
    }
    if (!answer) throw new ProviderError('bad-response', `${this.label} ended without an answer.`);
    if (!answer.streamed && answer.text) yield { type: 'text-delta', text: answer.text };
    if (answer.usage) yield { type: 'usage', usage: answer.usage };
    yield { type: 'done', stopReason: answer.stopReason, rawReason: answer.rawReason, detail: null };
  }

  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>> {
    validateRequestContent(request, this.capabilities);
    const call = this.kind === 'claude-cli' ? this.claude(request, spec.jsonSchema) : this.codex(request, spec.jsonSchema);
    let answer: CallResult | null = null;
    for await (const e of call) if (e.type === 'result') answer = e;
    if (!answer) throw new ProviderError('bad-response', `${this.label} ended without an answer.`);
    if (answer.stopReason === 'max-tokens') throw new ProviderError('bad-response', 'The structured answer was cut off.');
    let data = answer.structured;
    if (data === undefined) {
      try {
        data = JSON.parse(answer.text);
      } catch {
        throw new ProviderError('bad-response', 'The model did not return valid JSON.');
      }
    }
    try {
      return { value: spec.parse(data), usage: answer.usage };
    } catch {
      throw new ProviderError('bad-response', `The model's answer does not match the expected ${spec.name} format.`);
    }
  }

  // ----------------------------------------------------------------- Claude

  /** Arguments for one call (exported through the class for tests and documentation). */
  static claudeArgs(options: { model: string; systemPromptFile: string; jsonSchema: Record<string, unknown> | null }): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // No tools at all (structured output adds its own answer tool), no MCP
      // servers, no user/project settings, hooks or CLAUDE.md discovery.
      '--restricted',
      '--tools', '',
      '--strict-mcp-config',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      '--system-prompt-file', options.systemPromptFile,
    ];
    if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
    else args.push('--include-partial-messages');
    if (options.model && options.model !== CLI_DEFAULT_MODEL) args.push('--model', options.model);
    return args;
  }

  private async *claude(request: ModelRequest, jsonSchema: Record<string, unknown> | null): AsyncGenerator<CallEvent> {
    const { text, images } = renderConversation(request.messages);
    const content = [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: Buffer.from(img.data).toString('base64') } })),
      { type: 'text', text },
    ];
    const stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    yield* this.withFolder(async function* (this: CliModelProvider, dir: string, cwd: string) {
      const systemPromptFile = path.join(dir, 'system.txt');
      await writeFile(systemPromptFile, request.system || 'You are a helpful assistant.', 'utf8');
      let result: z.infer<typeof ClaudeResult> | null = null;
      let streamed = false;
      const stop = new AbortController();
      let violation: string | null = null;
      for await (const e of this.spawn(CliModelProvider.claudeArgs({ model: request.model, systemPromptFile, jsonSchema }), cwd, stdin, request.signal, stop.signal)) {
        if (e.type === 'exit') {
          if (violation) throw new ProviderError('bad-response', violation);
          this.checkExit(e, result ? null : '');
          break;
        }
        if (violation) continue;
        if (e.type !== 'stdout') continue;
        const data = parseLine(e.line);
        const type = (data as { type?: unknown } | null)?.type;
        if (type === 'stream_event') {
          const s = ClaudeDelta.safeParse(data);
          if (s.success && !s.data.parent_tool_use_id && s.data.event.type === 'content_block_delta' && s.data.event.delta?.type === 'text_delta' && s.data.event.delta.text) {
            streamed = true;
            yield { type: 'text-delta', text: s.data.event.delta.text };
          }
        } else if (type === 'assistant') {
          const a = ClaudeAssistant.safeParse(data);
          const tool = a.success ? a.data.message.content.find((b) => b.type === 'tool_use' && b.name !== 'StructuredOutput') : undefined;
          if (tool) {
            // Stop the CLI and wait for it to exit before failing.
            violation = `Claude Code tried to use a tool (${tool.name ?? 'unknown'}); tools are disabled for model calls.`;
            stop.abort();
          }
        } else if (type === 'result') {
          const r = ClaudeResult.safeParse(data);
          if (r.success) result = r.data;
        }
      }
      if (!result) throw new ProviderError('bad-response', 'Claude Code ended without an answer.');
      if (result.is_error || result.subtype !== 'success') throw this.failure(result.result ?? result.subtype);
      const u = result.usage;
      const usage: TokenUsage | null = u
        ? {
            inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            outputTokens: u.output_tokens ?? null,
            cachedInputTokens: u.cache_read_input_tokens ?? null,
            costUsd: result.total_cost_usd ?? null,
          }
        : null;
      const raw = result.stop_reason ?? null;
      yield {
        type: 'result',
        text: result.result ?? '',
        structured: jsonSchema ? result.structured_output : undefined,
        streamed,
        usage,
        stopReason: raw === 'max_tokens' ? 'max-tokens' : raw === 'refusal' ? 'refusal' : 'end',
        rawReason: raw,
      };
    });
  }

  // ------------------------------------------------------------------ Codex

  /** Arguments for one call (exported through the class for tests and documentation). */
  static codexArgs(options: { model: string; cwd: string; images: string[]; schemaFile: string | null; windowsSandbox: string | null }): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // The user's config.toml (profiles, MCP servers) is not loaded; the login still is.
      '--ignore-user-config',
      '--ephemeral',
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      '--sandbox', 'read-only',
      '--cd', options.cwd,
    ];
    if (options.windowsSandbox) args.push('-c', `windows.sandbox="${options.windowsSandbox}"`);
    for (const image of options.images) args.push('--image', image);
    if (options.schemaFile) args.push('--output-schema', options.schemaFile);
    if (options.model && options.model !== CLI_DEFAULT_MODEL) args.push('--model', options.model);
    args.push('-');
    return args;
  }

  private async *codex(request: ModelRequest, jsonSchema: Record<string, unknown> | null): AsyncGenerator<CallEvent> {
    const { text, images } = renderConversation(request.messages);
    // Codex has no system prompt option; the instructions lead the message.
    const stdin = `<instructions>\n${request.system}\n</instructions>\n\n${text}`;
    yield* this.withFolder(async function* (this: CliModelProvider, dir: string, cwd: string) {
      const files: string[] = [];
      for (const [i, img] of images.entries()) {
        const file = path.join(dir, `image-${i + 1}.${EXTENSION[img.mimeType]}`);
        await writeFile(file, img.data);
        files.push(file);
      }
      let schemaFile: string | null = null;
      if (jsonSchema) {
        schemaFile = path.join(dir, 'schema.json');
        await writeFile(schemaFile, JSON.stringify(jsonSchema), 'utf8');
      }
      const windowsSandbox = process.platform === 'win32' ? (this.options.windowsSandbox ?? 'unelevated') : null;
      let message: string | null = null;
      let turnFailed: string | null = null;
      // `error` events can be notices (a reconnect) in a turn that still answers.
      let lastError: string | null = null;
      let usage: TokenUsage | null = null;
      const stop = new AbortController();
      let violation: string | null = null;
      for await (const e of this.spawn(CliModelProvider.codexArgs({ model: request.model, cwd, images: files, schemaFile, windowsSandbox }), cwd, stdin, request.signal, stop.signal)) {
        if (e.type === 'exit') {
          if (violation) throw new ProviderError('bad-response', violation);
          this.checkExit(e, turnFailed ?? (message === null ? (lastError ?? '') : null));
          break;
        }
        if (violation) continue;
        if (e.type !== 'stdout') continue;
        const parsed = CodexEvent.safeParse(parseLine(e.line));
        if (!parsed.success) continue;
        const event = parsed.data;
        if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          if (CODEX_ACTION_ITEMS.has(event.item.type)) {
            violation = `Codex tried to act (${event.item.type}); tools are disabled for model calls.`;
            stop.abort();
            continue;
          }
          // `error` items are notices (e.g. a disabled feature); failures arrive as turn.failed or error events.
          if (event.type === 'item.completed' && event.item.type === 'agent_message' && event.item.text !== undefined) message = event.item.text;
        } else if (event.type === 'turn.completed' && event.usage) {
          usage = { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null, cachedInputTokens: event.usage.cached_input_tokens ?? null, costUsd: null };
        } else if (event.type === 'turn.failed') {
          turnFailed = event.error?.message ?? 'Codex could not answer.';
        } else if (event.type === 'error') {
          lastError = event.message;
        }
      }
      if (message === null) throw new ProviderError('bad-response', 'Codex ended without an answer.');
      yield { type: 'result', text: message, structured: undefined, streamed: false, usage, stopReason: 'end', rawReason: null };
    });
  }

  // ----------------------------------------------------------------- shared

  /** Runs `body` with a new private folder (and an empty working folder inside it), removed afterwards. */
  private async *withFolder(body: (this: CliModelProvider, dir: string, cwd: string) => AsyncGenerator<CallEvent>): AsyncGenerator<CallEvent> {
    const root = this.options.workRoot ?? os.tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(path.join(root, 'rs-model-'));
    try {
      const cwd = path.join(dir, 'work');
      await mkdir(cwd);
      yield* body.call(this, dir, cwd);
    } finally {
      // Retries cover a CLI that is still letting go of its working folder (Windows).
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  }

  private spawn(args: string[], cwd: string, stdin: string, signal: AbortSignal | undefined, stop: AbortSignal): AsyncGenerator<ProcessEvent> {
    return spawnLines({ executable: this.options.executable, args, cwd, env: this.options.env, stdin, timeoutMs: this.options.timeoutMs, signal: signal ? AbortSignal.any([signal, stop]) : stop });
  }

  /**
   * Throws for an exit that is not a normal end. `problem` is null when an
   * answer arrived, otherwise the CLI's own error ('' when it gave none, and
   * stderr is used instead).
   */
  private checkExit(e: Extract<ProcessEvent, { type: 'exit' }>, problem: string | null): void {
    if (e.cancelled) throw new ProviderError('cancelled', 'The request was cancelled.');
    if (e.timedOut) throw new ProviderError('timeout', `${this.label} did not answer within ${Math.round(this.options.timeoutMs / 1000)} seconds.`);
    if (e.spawnError) throw new ProviderError('unknown', `Could not start ${this.label}: ${this.clean(e.spawnError)}`);
    if (problem !== null) throw this.failure(problem || e.stderrTail.trim() || `${this.label} ended without an answer (exit code ${e.exitCode ?? 'none'}).`);
  }

  /** A user-facing error from the CLI's own message. */
  private failure(raw: string): ProviderError {
    const text = this.clean(raw);
    const login = this.kind === 'claude-cli' ? '`claude` (then /login)' : '`codex login`';
    if (/not (logged|signed) in|log ?in|unauthori[sz]ed|invalid api key|authentication|\b401\b/i.test(text)) return new ProviderError('auth', `${this.label} is not signed in. Run ${login} in a terminal, then try again.`);
    if (/rate.?limit|usage limit|too many requests|\b429\b|quota/i.test(text)) return new ProviderError('rate-limit', `${this.label}: ${text}`);
    if (/overloaded|\b529\b|\b503\b/i.test(text)) return new ProviderError('overloaded', `${this.label}: ${text}`);
    if (/model.*(not found|not exist|unknown|invalid|not supported)|(unknown|invalid) model/i.test(text)) return new ProviderError('not-found', `${this.label}: ${text}`);
    return new ProviderError('unknown', `${this.label}: ${text}`);
  }

  private clean(text: string): string {
    return redactValues(text, this.options.secrets).trim().slice(0, 500);
  }
}

type CallEvent = { type: 'text-delta'; text: string } | CallResult;
interface CallResult {
  type: 'result';
  text: string;
  /** The parsed structured answer, when the CLI returns it separately (Claude Code). */
  structured: unknown;
  /** Whether the text already went out as deltas. */
  streamed: boolean;
  usage: TokenUsage | null;
  stopReason: StopReason;
  rawReason: string | null;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
