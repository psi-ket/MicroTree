import type {
  AgentCapabilities,
  AgentAuthState,
  AgentKind,
  AgentPermissionProfile,
  ModelCapabilities,
  ModelInfo,
  ModelProviderKind,
  TokenUsage,
} from '@research-studio/shared-types';

// ------------------------------------------------------------- model providers

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** One part of a message. Images are raw bytes; adapters encode them for their provider. */
export type MessageContent = { type: 'text'; text: string } | { type: 'image'; mimeType: ImageMimeType; data: Uint8Array };

export interface ChatTurn {
  role: 'user' | 'assistant';
  /** A plain string is the same as one text part. Images need `capabilities.vision` (see `validateRequestContent`). */
  content: string | MessageContent[];
}

export interface ModelRequest {
  model: string;
  /** Operator instructions. Untrusted project content never goes here. */
  system: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/**
 * Normalised end of a model answer. Each adapter maps its provider's own
 * finish reasons; anything it does not recognise, or a stream that ends
 * without any finish reason, is `other`.
 */
export type StopReason = 'end' | 'max-tokens' | 'refusal' | 'cancelled' | 'other';

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | {
      type: 'done';
      stopReason: StopReason;
      /** The provider's finish reason as reported (`stop`, `length`, `end_turn`, `max_tokens`, …); null if none was sent. */
      rawReason: string | null;
      detail: string | null;
    };

/**
 * How a model answer ended, from the application's point of view. Only
 * `completed` answers are complete enough to turn into edit proposals.
 */
export type CompletionState = 'completed' | 'truncated' | 'cancelled' | 'failed' | 'incomplete';

/**
 * Classify the end of a stream. `error` is set when the stream threw (provider
 * failure, timeout); `cancelled` when the user stopped it.
 */
export function completionState(outcome: { stopReason: StopReason | null; cancelled: boolean; error: boolean }): CompletionState {
  if (outcome.cancelled) return 'cancelled';
  if (outcome.error) return 'failed';
  switch (outcome.stopReason) {
    case 'end':
      return 'completed';
    case 'max-tokens':
      return 'truncated';
    case 'refusal':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // `other`, or no `done` event at all: the answer did not finish normally.
      return 'incomplete';
  }
}

/** A JSON Schema plus the validator that output must also pass. */
export interface StructuredOutputSpec<T> {
  name: string;
  /** JSON Schema (draft 2020-12 subset accepted by all providers). */
  jsonSchema: Record<string, unknown>;
  parse(value: unknown): T;
}

export interface StructuredResult<T> {
  value: T;
  usage: TokenUsage | null;
}

/**
 * An HTTP model API. Implementations run inside the runtime only; they receive
 * the API key in their constructor and must never surface it in errors.
 * Streams end with exactly one `done` event; failures throw `ProviderError`.
 */
export interface ModelProvider {
  readonly kind: ModelProviderKind;
  readonly capabilities: ModelCapabilities;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /** Only available when `capabilities.structuredOutput` is true. */
  generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>>;
}

// ----------------------------------------------------------------- CLI agents

/** How to start the agent process: an absolute executable plus fixed leading arguments. */
export interface AgentExecutable {
  command: string;
  prefixArgs: string[];
}

export interface AgentDetection {
  available: boolean;
  executable: AgentExecutable | null;
  version: string | null;
  problem: string | null;
}

export interface AgentAuthStatus {
  state: AgentAuthState;
  method: string | null;
  detail: string | null;
}

export interface AgentRunOptions {
  /** Full prompt; delivered on stdin, never as a command-line argument. */
  prompt: string;
  /** Absolute directory the agent works in (always a staging copy, never the project). */
  workingDirectory: string;
  permission: AgentPermissionProfile;
  model: string | null;
  /** The agent's own session id from a previous turn. */
  resumeSessionId: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Environment for the child process (already filtered by the caller). */
  env: Record<string, string | undefined>;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string; model: string | null }
  | { type: 'text-delta'; text: string }
  /** A complete assistant message (agents that do not stream deltas). */
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; detail: string | null; phase: 'started' | 'completed' | 'failed' }
  /** What the agent says it changed. Informational: the runtime diffs the staging copy itself. */
  | { type: 'file-change'; path: string; change: 'add' | 'update' | 'delete' }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'log'; text: string }
  | {
      type: 'done';
      status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
      /** Final answer text, when the protocol reports one separately. */
      result: string | null;
      error: string | null;
    };

/**
 * A command-line agent. Agents differ: capabilities state what each one can
 * do, and adapters translate each agent's own structured protocol into
 * `AgentEvent`s. `run` yields events and always finishes with one `done`.
 */
export interface AgentProvider {
  readonly id: string;
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentDetection>;
  authStatus(): Promise<AgentAuthStatus>;
  run(options: AgentRunOptions): AsyncIterable<AgentEvent>;
}
