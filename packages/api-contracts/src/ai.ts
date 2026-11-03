import { z } from 'zod';
import {
  AGENT_AUTH_STATES,
  AGENT_KINDS,
  AGENT_PERMISSION_PROFILES,
  AGENT_RUN_STATUSES,
  AI_MESSAGE_STATUSES,
  CONTEXT_ITEM_KINDS,
  CONVERSATION_MODES,
  CREDENTIAL_SOURCES,
  EDIT_CHANGE_TYPES,
  MODEL_PROVIDER_KINDS,
  PROPOSAL_STATUSES,
  WRITING_ACTION_IDS,
  type AgentActivity,
  type AgentDescriptor,
  type AgentRun,
  type Conversation,
  type ConversationMessage,
  type EditProposal,
  type ModelInfo,
  type ProviderConfigView,
} from '@research-studio/shared-types';
import { ProjectId, ProjectPath } from './schemas';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

const Id = z.string().regex(/^[a-z0-9-]{2,64}$/, 'Invalid id');

// ----------------------------------------------------------------- models

export const ModelCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  toolUse: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  maxContextTokens: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  usageReporting: z.boolean(),
  modelListing: z.boolean(),
  requiresApiKey: z.boolean(),
});

export const ProviderConfigSchema = z.object({
  id: z.string(),
  kind: z.enum(MODEL_PROVIDER_KINDS),
  displayName: z.string(),
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  enabled: z.boolean(),
  credential: z.object({ required: z.boolean(), configured: z.boolean(), source: z.enum(CREDENTIAL_SOURCES) }),
  capabilities: ModelCapabilitiesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
assertType<Exact<z.infer<typeof ProviderConfigSchema>, ProviderConfigView>>();

export const ModelInfoSchema = z.object({ id: z.string(), displayName: z.string(), contextTokens: z.number().nullable() });
assertType<Exact<z.infer<typeof ModelInfoSchema>, ModelInfo>>();

const ApiKey = z.string().trim().min(8, 'The API key looks too short').max(512);
/** Passed to SDKs and as one CLI argument: no whitespace, and never something that reads as a flag. */
const ModelName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s-]\S*$/, 'Model names cannot start with "-" or contain spaces');
const BaseUrl = z.string().trim().max(500);

export const CreateProviderRequest = z.object({
  kind: z.enum(MODEL_PROVIDER_KINDS),
  displayName: z.string().trim().min(1).max(80),
  baseUrl: BaseUrl.nullable().default(null),
  defaultModel: ModelName.nullable().default(null),
  /** Sent once, stored in the runtime's secret store, never returned. */
  apiKey: ApiKey.nullable().default(null),
});

export const UpdateProviderRequest = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    baseUrl: BaseUrl.nullable(),
    defaultModel: ModelName.nullable(),
    enabled: z.boolean(),
    /** A new key replaces the stored one; `null` removes it. */
    apiKey: ApiKey.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const ProviderParams = z.object({ providerId: Id });
export const ProviderResponse = z.object({ provider: ProviderConfigSchema });
export const ProviderListResponse = z.object({ providers: z.array(ProviderConfigSchema) });
export const ModelListResponse = z.object({ models: z.array(ModelInfoSchema) });

export const AiStatusResponse = z.object({
  secretStore: z.object({ kind: z.enum(['keyring', 'file', 'memory']), notice: z.string().nullable() }),
  agentsEnabled: z.boolean(),
  limits: z.object({ maxOutputTokens: z.number(), requestTimeoutMs: z.number(), agentTimeoutMs: z.number() }),
});

// ----------------------------------------------------------------- agents

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  cancellation: z.boolean(),
  resume: z.boolean(),
  fileEdits: z.boolean(),
  usageReporting: z.boolean(),
  modelSelection: z.boolean(),
  permissionProfiles: z.array(z.enum(AGENT_PERMISSION_PROFILES)),
});

export const AgentDescriptorSchema = z.object({
  id: z.string(),
  kind: z.enum(AGENT_KINDS),
  displayName: z.string(),
  available: z.boolean(),
  version: z.string().nullable(),
  executable: z.string().nullable(),
  auth: z.object({ state: z.enum(AGENT_AUTH_STATES), method: z.string().nullable(), detail: z.string().nullable() }),
  capabilities: AgentCapabilitiesSchema,
  problem: z.string().nullable(),
});
assertType<Exact<z.infer<typeof AgentDescriptorSchema>, AgentDescriptor>>();

export const AgentListResponse = z.object({ agents: z.array(AgentDescriptorSchema) });
export const AgentListQuery = z.object({ refresh: z.enum(['0', '1']).optional() });

export const AgentApprovalSchema = z.object({ agentId: z.string(), permission: z.enum(AGENT_PERMISSION_PROFILES), approvedAt: z.string() });
export const AgentApprovalsResponse = z.object({ approvals: z.array(AgentApprovalSchema) });
export const SetAgentApprovalRequest = z.object({
  agentId: Id,
  permission: z.enum(AGENT_PERMISSION_PROFILES),
  approved: z.boolean(),
});

const TokenUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});

export const AgentRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  agentId: z.string(),
  permission: z.enum(AGENT_PERMISSION_PROFILES),
  status: z.enum(AGENT_RUN_STATUSES),
  externalSessionId: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  usage: TokenUsageSchema.nullable(),
  changedFiles: z.array(z.string()),
  error: z.string().nullable(),
});
assertType<Exact<z.infer<typeof AgentRunSchema>, AgentRun>>();

export const AgentActivitySchema = z.object({
  kind: z.enum(['tool', 'file-change', 'status', 'log']),
  label: z.string(),
  detail: z.string().nullable(),
  at: z.string(),
});
assertType<Exact<z.infer<typeof AgentActivitySchema>, AgentActivity>>();

// ---------------------------------------------------------- conversations

export const ConversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  mode: z.enum(CONVERSATION_MODES),
  providerId: z.string(),
  model: z.string().nullable(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
assertType<Exact<z.infer<typeof ConversationSchema>, Conversation>>();

export const ContextItemSchema = z.object({ kind: z.enum(CONTEXT_ITEM_KINDS), label: z.string(), chars: z.number(), truncated: z.boolean() });

export const ConversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant']),
  action: z.enum(WRITING_ACTION_IDS).nullable(),
  content: z.string(),
  status: z.enum(AI_MESSAGE_STATUSES),
  context: z.array(ContextItemSchema),
  usage: TokenUsageSchema.nullable(),
  error: z.string().nullable(),
  editIssues: z.array(z.object({ index: z.number(), problem: z.string() })),
  finishReason: z.string().nullable(),
  createdAt: z.string(),
});
assertType<Exact<z.infer<typeof ConversationMessageSchema>, ConversationMessage>>();

export const EditProposalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  agentRunId: z.string().nullable(),
  source: z.enum(['model', 'agent']),
  action: z.enum(WRITING_ACTION_IDS).nullable(),
  file: z.string(),
  changeType: z.enum(EDIT_CHANGE_TYPES),
  baseHash: z.string().nullable(),
  original: z.string(),
  proposed: z.string(),
  range: z.object({ start: z.number(), end: z.number() }).nullable(),
  explanation: z.string(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  status: z.enum(PROPOSAL_STATUSES),
  appliedHash: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
assertType<Exact<z.infer<typeof EditProposalSchema>, EditProposal>>();

export const ConversationParams = z.object({ projectId: ProjectId, conversationId: Id });
export const MessageParams = z.object({ projectId: ProjectId, messageId: Id });
export const ProposalParams = z.object({ projectId: ProjectId, proposalId: Id });

export const CreateConversationRequest = z.object({
  mode: z.enum(CONVERSATION_MODES),
  providerId: Id,
  model: ModelName.nullable().default(null),
  title: z.string().trim().max(120).optional(),
});

export const ConversationResponse = z.object({ conversation: ConversationSchema });
export const ConversationListResponse = z.object({ conversations: z.array(ConversationSchema) });
export const ConversationDetailResponse = z.object({
  conversation: ConversationSchema,
  messages: z.array(ConversationMessageSchema),
  proposals: z.array(EditProposalSchema),
  runs: z.array(AgentRunSchema),
});

const Line = z.number().int().min(1).max(10_000_000);
export const ContextRequestSchema = z.object({
  activeFile: ProjectPath.nullable().default(null),
  selection: z
    .object({ file: ProjectPath, startLine: Line, startColumn: Line, endLine: Line, endColumn: Line })
    .nullable()
    .default(null),
  selectionText: z.string().max(200_000).nullable().default(null),
  cursor: z.object({ line: Line, column: Line }).nullable().default(null),
  openTabs: z.array(ProjectPath).max(50).default([]),
  attachedFiles: z.array(ProjectPath).max(8).default([]),
});

export const SendMessageRequest = z.object({
  action: z.enum(WRITING_ACTION_IDS).default('chat'),
  text: z.string().max(20_000).default(''),
  context: ContextRequestSchema,
  /** Overrides the conversation's model for this and later turns. */
  model: ModelName.optional(),
  /** Agent mode only. */
  permission: z.enum(AGENT_PERMISSION_PROFILES).optional(),
});
export const SendMessageResponse = z.object({ userMessage: ConversationMessageSchema, assistantMessage: ConversationMessageSchema });
export const CancelMessageResponse = z.object({ message: ConversationMessageSchema });

// --------------------------------------------------------------- proposals

export const ProposalListQuery = z.object({ status: z.enum(PROPOSAL_STATUSES).optional() });
export const ProposalListResponse = z.object({ proposals: z.array(EditProposalSchema) });
export const ProposalResponse = z.object({ proposal: EditProposalSchema });
export const ProposalPreviewResponse = z.object({
  proposal: EditProposalSchema,
  /** Whole-file text before and after, when the file still matches the proposal's base. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  stale: z.boolean(),
});
export const AcceptProposalRequest = z.object({
  /** The full file text after a manual edit of the proposal in the review view. */
  content: z.string().max(8 * 1024 * 1024).optional(),
});
