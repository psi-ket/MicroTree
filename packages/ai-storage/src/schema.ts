import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  AGENT_PERMISSION_PROFILES,
  AGENT_RUN_STATUSES,
  AI_MESSAGE_STATUSES,
  CONVERSATION_MODES,
  EDIT_CHANGE_TYPES,
  STAGING_STATES,
  MODEL_PROVIDER_KINDS,
  PROPOSAL_STATUSES,
  type ContextItemSummary,
  type ProposalWarning,
  type TokenUsage,
  type WritingActionId,
} from '@research-studio/shared-types';

// Tables owned by the AI integration. They live in the runtime's SQLite file
// next to the core tables, with their own migration history
// (`__ai_migrations`). `projects` is created by @research-studio/database.

/** Model provider settings. The API key is NOT here: it lives in the secret store under `secretRef`. */
export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: MODEL_PROVIDER_KINDS }).notNull(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url'),
  defaultModel: text('default_model'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Key in the secret store; null when no secret was ever stored. */
  secretRef: text('secret_ref'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiConversations = sqliteTable(
  'ai_conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    mode: text('mode', { enum: CONVERSATION_MODES }).notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model'),
    title: text('title').notNull(),
    /** Agent mode: the agent's own session id for resuming. */
    agentSessionId: text('agent_session_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('ai_conversations_project_idx').on(t.projectId, t.updatedAt)],
);

export const aiMessages = sqliteTable(
  'ai_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    action: text('action').$type<WritingActionId>(),
    content: text('content').notNull(),
    status: text('status', { enum: AI_MESSAGE_STATUSES }).notNull(),
    context: text('context', { mode: 'json' }).$type<ContextItemSummary[]>().notNull(),
    usage: text('usage', { mode: 'json' }).$type<TokenUsage>(),
    error: text('error'),
    editIssues: text('edit_issues', { mode: 'json' }).$type<{ index: number; problem: string }[]>().notNull(),
    /** The provider's raw finish reason. */
    finishReason: text('finish_reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.seq)],
);

export const aiProposals = sqliteTable(
  'ai_proposals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    agentRunId: text('agent_run_id'),
    source: text('source', { enum: ['model', 'agent'] }).notNull(),
    action: text('action').$type<WritingActionId>(),
    /** Position of the edit block within its message (model proposals). */
    blockIndex: integer('block_index'),
    file: text('file').notNull(),
    changeType: text('change_type', { enum: EDIT_CHANGE_TYPES }).notNull(),
    baseHash: text('base_hash'),
    original: text('original').notNull(),
    proposed: text('proposed').notNull(),
    rangeStart: integer('range_start'),
    rangeEnd: integer('range_end'),
    explanation: text('explanation').notNull(),
    warnings: text('warnings', { mode: 'json' }).$type<ProposalWarning[]>().notNull(),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull(),
    appliedHash: text('applied_hash'),
    /** Full file content before the proposal was applied (for revert). */
    previousContent: text('previous_content'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    index('ai_proposals_project_idx').on(t.projectId, t.createdAt),
    index('ai_proposals_message_idx').on(t.messageId),
    index('ai_proposals_file_idx').on(t.projectId, t.file, t.status),
  ],
);

export const aiAgentRuns = sqliteTable(
  'ai_agent_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull(),
    agentId: text('agent_id').notNull(),
    permission: text('permission', { enum: AGENT_PERMISSION_PROFILES }).notNull(),
    status: text('status', { enum: AGENT_RUN_STATUSES }).notNull(),
    externalSessionId: text('external_session_id'),
    model: text('model'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    usage: text('usage', { mode: 'json' }).$type<TokenUsage>(),
    changedFiles: text('changed_files', { mode: 'json' }).$type<string[]>().notNull(),
    error: text('error'),
  },
  (t) => [index('ai_agent_runs_project_idx').on(t.projectId, t.startedAt)],
);

/**
 * Which CLI agents the user allowed to run in which project, per permission
 * profile. Agents never run in a project without a row here.
 */
export const aiAgentApprovals = sqliteTable(
  'ai_agent_approvals',
  {
    projectId: text('project_id').notNull(),
    agentId: text('agent_id').notNull(),
    permission: text('permission', { enum: AGENT_PERMISSION_PROFILES }).notNull(),
    approvedAt: text('approved_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.agentId, t.permission] })],
);

/**
 * Agent staging copies (`<dataDir>/agent-workspaces/<sessionId>`), one per
 * agent conversation. Deliberately without a foreign key: the row must outlive
 * its conversation or project so the cleanup can still find and remove the
 * copy.
 */
export const aiStagingWorkspaces = sqliteTable(
  'ai_staging_workspaces',
  {
    sessionId: text('session_id').primaryKey(),
    projectId: text('project_id').notNull(),
    agentId: text('agent_id').notNull(),
    state: text('state', { enum: STAGING_STATES }).notNull(),
    bytes: integer('bytes').notNull().default(0),
    files: integer('files').notNull().default(0),
    createdAt: text('created_at').notNull(),
    lastActiveAt: text('last_active_at').notNull(),
  },
  (t) => [index('ai_staging_last_active_idx').on(t.lastActiveAt)],
);
