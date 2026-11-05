/**
 * AI integration domain types (milestone M2), shared by the runtime, the web
 * app and the AI packages. Provider and agent *implementations* live in
 * `@research-studio/model-adapters` and `@research-studio/agent-adapters`;
 * their interfaces live in `@research-studio/ai-core`. Nothing here carries a
 * secret: credentials never leave the runtime.
 */
import type { Diagnostic, IsoDateTime, SourceLocation } from './domain';

// ------------------------------------------------------------------ providers

/**
 * Model providers: HTTP model APIs, and the Claude Code and Codex CLIs used
 * as plain models (one answer per call, no tools) with the user's own login.
 */
export const MODEL_PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openai-compatible', 'ollama', 'claude-cli', 'codex-cli'] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/** Provider kinds served by a command-line agent instead of an HTTP API. */
export const CLI_MODEL_PROVIDER_KINDS = ['claude-cli', 'codex-cli'] as const satisfies readonly ModelProviderKind[];
export type CliModelProviderKind = (typeof CLI_MODEL_PROVIDER_KINDS)[number];

/** The model name that leaves the choice to the CLI's own configuration. */
export const CLI_DEFAULT_MODEL = 'default';

/** Command-line coding agents the runtime can drive. */
export const AGENT_KINDS = ['claude-code', 'codex', 'custom'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * What the runtime's adapter for a provider kind actually implements, not
 * what the provider's API can do in general. A capability is only `true`
 * when the adapter sends and handles it end to end.
 */
export interface ModelCapabilities {
  streaming: boolean;
  /** JSON-schema constrained output (`generateStructured`). */
  structuredOutput: boolean;
  /** Tool/function calling. No adapter implements it yet. */
  toolUse: boolean;
  /** Image input (`MessageContent` image parts are serialised). Individual models may still reject images. */
  vision: boolean;
  /** Extended thinking / reasoning output is requested and surfaced. No adapter does this yet. */
  reasoning: boolean;
  /** Context window in tokens, when it is the same for every model of the provider; otherwise null (see `ModelInfo.contextTokens`). */
  maxContextTokens: number | null;
  /** Largest output in tokens, when known for every model of the provider; otherwise null. */
  maxOutputTokens: number | null;
  /** Token counts are reported back. */
  usageReporting: boolean;
  /** The model list can be fetched from the provider. */
  modelListing: boolean;
  /** An API key is needed (false for local endpoints such as Ollama). */
  requiresApiKey: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Context window in tokens, when the provider reports it. */
  contextTokens: number | null;
}

export const CREDENTIAL_SOURCES = ['keyring', 'file', 'memory', 'env', 'none'] as const;
/** Where the runtime found a credential: OS credential store, fallback file, process memory, environment variable, or nowhere. */
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** A configured model provider as the browser sees it. Never includes the secret. */
export interface ProviderConfigView {
  id: string;
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string | null;
  defaultModel: string | null;
  enabled: boolean;
  credential: { required: boolean; configured: boolean; source: CredentialSource };
  capabilities: ModelCapabilities;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Cost reported by the provider or agent itself (never estimated by the runtime). */
  costUsd: number | null;
}

// --------------------------------------------------------------------- agents

/**
 * What a CLI agent may do. No profile lets an agent write the real project
 * directory, run shell commands outside the agent's own sandbox, or fetch from
 * the network through the agent's web tools.
 *
 * - `read`: read project files only. Suggested edits come back as proposals.
 * - `write-staged`: edit files in an isolated staging copy of the project;
 *   every change comes back as a proposal for review.
 */
export const AGENT_PERMISSION_PROFILES = ['read', 'write-staged'] as const;
export type AgentPermissionProfile = (typeof AGENT_PERMISSION_PROFILES)[number];

export interface AgentCapabilities {
  streaming: boolean;
  cancellation: boolean;
  /** Follow-up turns continue the same agent session. */
  resume: boolean;
  /** The agent can edit files itself (in the staging copy). */
  fileEdits: boolean;
  /** The agent reports its own usage/cost. */
  usageReporting: boolean;
  /** The agent accepts a model override. */
  modelSelection: boolean;
  permissionProfiles: AgentPermissionProfile[];
}

export const AGENT_AUTH_STATES = ['authenticated', 'unauthenticated', 'unknown'] as const;
export type AgentAuthState = (typeof AGENT_AUTH_STATES)[number];

export interface AgentDescriptor {
  id: string;
  kind: AgentKind;
  displayName: string;
  available: boolean;
  version: string | null;
  /** Absolute path of the executable that will be spawned. */
  executable: string | null;
  auth: { state: AgentAuthState; method: string | null; detail: string | null };
  capabilities: AgentCapabilities;
  /** Why the agent cannot be used, when `available` is false. */
  problem: string | null;
}

export const AGENT_RUN_STATUSES = ['starting', 'running', 'completed', 'failed', 'cancelled', 'timed-out'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRun {
  id: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  agentId: string;
  permission: AgentPermissionProfile;
  status: AgentRunStatus;
  /** The agent's own session id, used to resume follow-up turns. */
  externalSessionId: string | null;
  model: string | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  usage: TokenUsage | null;
  /** Project-relative paths the agent changed in its staging copy. */
  changedFiles: string[];
  error: string | null;
}

/** Progress reported while an agent runs (tool activity, not message text). */
export interface AgentActivity {
  kind: 'tool' | 'file-change' | 'status' | 'log';
  label: string;
  detail: string | null;
  at: IsoDateTime;
}

// --------------------------------------------------------------- conversation

export const CONVERSATION_MODES = ['model', 'agent'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

export const WRITING_ACTION_IDS = [
  'chat',
  'explain',
  'improve-wording',
  'concise',
  'expand',
  'check-notation',
  'explain-equation',
  'diagnose-errors',
  'suggest-corrections',
  'alternatives',
] as const;
export type WritingActionId = (typeof WRITING_ACTION_IDS)[number];

export interface Conversation {
  id: string;
  projectId: string;
  mode: ConversationMode;
  /** Provider config id (model mode) or agent id (agent mode). */
  providerId: string;
  model: string | null;
  title: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * `complete`: the provider reported a normal end. `truncated`: it stopped at
 * the output limit. `incomplete`: the stream ended without a normal finish
 * (unknown or missing finish reason). Only `complete` answers can produce
 * edit proposals; the others keep their text for reading.
 */
export const AI_MESSAGE_STATUSES = ['streaming', 'complete', 'truncated', 'incomplete', 'error', 'cancelled'] as const;
export type AiMessageStatus = (typeof AI_MESSAGE_STATUSES)[number];

export const CONTEXT_ITEM_KINDS = [
  'selection',
  'active-file',
  'open-tabs',
  'file-tree',
  'outline',
  'diagnostics',
  'bibliography',
  'attached-file',
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/** One piece of context that was sent with a request (shown to the user). */
export interface ContextItemSummary {
  kind: ContextItemKind;
  label: string;
  chars: number;
  truncated: boolean;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  action: WritingActionId | null;
  content: string;
  status: AiMessageStatus;
  /** Context attached to the request this message answers (assistant) or carried (user). */
  context: ContextItemSummary[];
  usage: TokenUsage | null;
  error: string | null;
  /** Edit blocks in this message that could not become proposals, by block index. */
  editIssues: { index: number; problem: string }[];
  /** The provider's own finish reason (e.g. `stop`, `length`, `end_turn`, `max_tokens`), when it reported one. */
  finishReason: string | null;
  createdAt: IsoDateTime;
}

export const STAGING_STATES = ['active', 'idle'] as const;
export type StagingState = (typeof STAGING_STATES)[number];

// ------------------------------------------------------------- edit proposals

export const EDIT_CHANGE_TYPES = ['modify', 'create', 'delete'] as const;
export type EditChangeType = (typeof EDIT_CHANGE_TYPES)[number];

export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'stale', 'reverted'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalWarning {
  code: string;
  message: string;
}

/**
 * A structured change to one project file. Proposals are never applied
 * without an explicit accept, and only while the file still has `baseHash`.
 */
export interface EditProposal {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  agentRunId: string | null;
  source: 'model' | 'agent';
  action: WritingActionId | null;
  file: string;
  changeType: EditChangeType;
  /** sha256 of the file the proposal was made against (`null` for `create`). */
  baseHash: string | null;
  /** Exact text being replaced (whole file for agent changes, empty for `create`). */
  original: string;
  proposed: string;
  /** UTF-16 offsets of `original` in the base content. */
  range: { start: number; end: number } | null;
  explanation: string;
  warnings: ProposalWarning[];
  status: ProposalStatus;
  /** Hash of the file after this proposal was applied (enables revert). */
  appliedHash: string | null;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

// --------------------------------------------------------------------- legacy

/**
 * @deprecated Since M2. Kept for compatibility with M1 code; the assistant
 * now sends a `ContextRequest` and the runtime assembles the context.
 */
export type AiProviderKind = 'api' | 'cli-agent';

/** @deprecated Since M2; see `ModelCapabilities` and `AgentCapabilities`. */
export interface AiCapabilities {
  chat: boolean;
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  /** Maximum context window in tokens, if known. */
  contextTokens: number | null;
}

/** @deprecated Since M2; see `ProviderConfigView` and `AgentDescriptor`. */
export interface AiProviderDescriptor {
  id: string;
  kind: AiProviderKind;
  displayName: string;
  capabilities: AiCapabilities;
  /** Whether credentials / binaries are configured on the runtime. */
  configured: boolean;
}

/** The slice of workspace state a request may be grounded on (as known to the browser). */
export interface AiContextBundle {
  projectId: string;
  activeFile: string | null;
  selection: { file: string; from: SourceLocation; to: SourceLocation; text: string } | null;
  diagnostics: Diagnostic[];
  /** Project-relative files the user explicitly attached. */
  attachedFiles: string[];
}

/** @deprecated Since M2; see `ConversationMessage`. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** @deprecated Since M2; see `ModelRequest` in `@research-studio/ai-core`. */
export interface AiRequest {
  providerId: string;
  model: string;
  messages: AiMessage[];
  context: AiContextBundle;
  signal?: AbortSignal;
}

/** @deprecated Since M2; see `ModelStreamEvent` / `AgentEvent` in `@research-studio/ai-core`. */
export type AiStreamEvent =
  | { type: 'text-delta'; text: string }
  | {
      type: 'edit-proposal';
      file: string;
      from: SourceLocation;
      to: SourceLocation;
      replacement: string;
    }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; message: string };

/** @deprecated Since M2; see `ModelProvider` in `@research-studio/ai-core`. */
export interface AiProvider {
  readonly descriptor: AiProviderDescriptor;
  listModels(): Promise<string[]>;
  stream(request: AiRequest): AsyncIterable<AiStreamEvent>;
}

/** @deprecated Since M2; see `AgentProvider` in `@research-studio/ai-core`. */
export interface CliAgentAdapter {
  readonly descriptor: AiProviderDescriptor;
  /** Resolve the executable and report its version; must not run untrusted input. */
  detect(): Promise<{ available: boolean; version: string | null }>;
  run(request: AiRequest & { workingDirectory: string }): AsyncIterable<AiStreamEvent>;
}
