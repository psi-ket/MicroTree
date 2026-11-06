import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type {
  AgentPermissionProfile,
  AgentRun,
  AgentRunStatus,
  AiMessageStatus,
  ContextItemSummary,
  Conversation,
  ConversationMessage,
  ConversationMode,
  EditProposal,
  ModelProviderKind,
  ProposalStatus,
  TokenUsage,
  WritingActionId,
} from '@research-studio/shared-types';
import * as schema from './schema';
import { aiAgentApprovals, aiAgentRuns, aiConversations, aiMessages, aiProposals, aiProviders, aiStagingWorkspaces } from './schema';

export type AiDb = BetterSQLite3Database<typeof schema>;

export const AI_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATIONS_TABLE = '__ai_migrations';

/** Run the AI migrations on an already-migrated core database connection. */
export function openAiDb(sqlite: Database.Database, migrationsFolder = AI_MIGRATIONS_DIR): AiDb {
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  return db;
}

const now = () => new Date().toISOString();

// --------------------------------------------------------------- providers

export interface ProviderRecord {
  id: string;
  kind: ModelProviderKind;
  displayName: string;
  baseUrl: string | null;
  defaultModel: string | null;
  enabled: boolean;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ProviderRepository {
  constructor(private readonly db: AiDb) {}

  list(): ProviderRecord[] {
    return this.db.select().from(aiProviders).orderBy(asc(aiProviders.createdAt)).all();
  }

  get(id: string): ProviderRecord | null {
    return this.db.select().from(aiProviders).where(eq(aiProviders.id, id)).get() ?? null;
  }

  create(input: Omit<ProviderRecord, 'createdAt' | 'updatedAt'>): ProviderRecord {
    const at = now();
    const row = { ...input, createdAt: at, updatedAt: at };
    this.db.insert(aiProviders).values(row).run();
    return row;
  }

  update(id: string, patch: Partial<Omit<ProviderRecord, 'id' | 'kind' | 'createdAt' | 'updatedAt'>>): ProviderRecord | null {
    this.db.update(aiProviders).set({ ...patch, updatedAt: now() }).where(eq(aiProviders.id, id)).run();
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.delete(aiProviders).where(eq(aiProviders.id, id)).run().changes > 0;
  }
}

// ----------------------------------------------------------- conversations

type ConversationRow = typeof aiConversations.$inferSelect;
const toConversation = ({ agentSessionId: _s, ...row }: ConversationRow): Conversation => row;

export class ConversationRepository {
  constructor(private readonly db: AiDb) {}

  create(input: { id: string; projectId: string; mode: ConversationMode; providerId: string; model: string | null; title: string }): Conversation {
    const at = now();
    const row: ConversationRow = { ...input, agentSessionId: null, archivedAt: null, createdAt: at, updatedAt: at };
    this.db.insert(aiConversations).values(row).run();
    return toConversation(row);
  }

  /** Scoped by project: a conversation id from another project is not found. */
  get(projectId: string, id: string): Conversation | null {
    const row = this.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.projectId, projectId)))
      .get();
    return row ? toConversation(row) : null;
  }

  agentSessionId(id: string): string | null {
    return this.db.select({ s: aiConversations.agentSessionId }).from(aiConversations).where(eq(aiConversations.id, id)).get()?.s ?? null;
  }

  /** The project's conversations, or only its archived ones, most recently active first. */
  list(projectId: string, options: { archived?: boolean; limit?: number } = {}): Conversation[] {
    return this.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.projectId, projectId), options.archived ? isNotNull(aiConversations.archivedAt) : isNull(aiConversations.archivedAt)))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(options.limit ?? 50)
      .all()
      .map(toConversation);
  }

  update(id: string, patch: Partial<Pick<ConversationRow, 'title' | 'model' | 'agentSessionId'>>): void {
    this.db.update(aiConversations).set({ ...patch, updatedAt: now() }).where(eq(aiConversations.id, id)).run();
  }

  touch(id: string): void {
    this.db.update(aiConversations).set({ updatedAt: now() }).where(eq(aiConversations.id, id)).run();
  }

  /** Archive or restore; the conversation keeps its place by last activity. */
  setArchived(projectId: string, id: string, archived: boolean): Conversation | null {
    this.db
      .update(aiConversations)
      .set({ archivedAt: archived ? now() : null })
      .where(and(eq(aiConversations.id, id), eq(aiConversations.projectId, projectId)))
      .run();
    return this.get(projectId, id);
  }

  delete(projectId: string, id: string): boolean {
    return (
      this.db
        .delete(aiConversations)
        .where(and(eq(aiConversations.id, id), eq(aiConversations.projectId, projectId)))
        .run().changes > 0
    );
  }
}

// ---------------------------------------------------------------- messages

type MessageRow = typeof aiMessages.$inferSelect;
const toMessage = ({ seq: _seq, ...row }: MessageRow): ConversationMessage => row;

export class MessageRepository {
  constructor(private readonly db: AiDb) {}

  append(input: {
    id: string;
    conversationId: string;
    role: 'user' | 'assistant';
    action: WritingActionId | null;
    content: string;
    status: AiMessageStatus;
    context: ContextItemSummary[];
  }): ConversationMessage {
    const seq =
      (this.db
        .select({ max: sql<number | null>`max(${aiMessages.seq})` })
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, input.conversationId))
        .get()?.max ?? 0) + 1;
    const row: MessageRow = { ...input, seq, usage: null, error: null, editIssues: [], finishReason: null, createdAt: now() };
    this.db.insert(aiMessages).values(row).run();
    return toMessage(row);
  }

  get(id: string): ConversationMessage | null {
    const row = this.db.select().from(aiMessages).where(eq(aiMessages.id, id)).get();
    return row ? toMessage(row) : null;
  }

  list(conversationId: string): ConversationMessage[] {
    return this.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.seq)).all().map(toMessage);
  }

  update(
    id: string,
    patch: Partial<{
      content: string;
      status: AiMessageStatus;
      usage: TokenUsage | null;
      error: string | null;
      context: ContextItemSummary[];
      editIssues: { index: number; problem: string }[];
      finishReason: string | null;
    }>,
  ): ConversationMessage | null {
    this.db.update(aiMessages).set(patch).where(eq(aiMessages.id, id)).run();
    return this.get(id);
  }

  /** Mark messages left streaming by a previous runtime process. */
  failInterrupted(message: string): number {
    return this.db.update(aiMessages).set({ status: 'error', error: message }).where(eq(aiMessages.status, 'streaming')).run().changes;
  }
}

// --------------------------------------------------------------- proposals

type ProposalRow = typeof aiProposals.$inferSelect;

function toProposal(row: ProposalRow): EditProposal {
  const { rangeStart, rangeEnd, previousContent: _p, blockIndex: _b, ...rest } = row;
  return { ...rest, range: rangeStart !== null && rangeEnd !== null ? { start: rangeStart, end: rangeEnd } : null };
}

export type NewProposal = Omit<EditProposal, 'status' | 'appliedHash' | 'createdAt' | 'resolvedAt'> & { blockIndex: number | null };

export class ProposalRepository {
  constructor(private readonly db: AiDb) {}

  create(input: NewProposal): EditProposal {
    const { range, ...rest } = input;
    const row: ProposalRow = {
      ...rest,
      rangeStart: range?.start ?? null,
      rangeEnd: range?.end ?? null,
      status: 'pending',
      appliedHash: null,
      previousContent: null,
      createdAt: now(),
      resolvedAt: null,
    };
    this.db.insert(aiProposals).values(row).run();
    return toProposal(row);
  }

  /** Scoped by project: a proposal id from another project is not found. */
  get(projectId: string, id: string): EditProposal | null {
    const row = this.row(projectId, id);
    return row ? toProposal(row) : null;
  }

  previousContent(projectId: string, id: string): string | null {
    return this.row(projectId, id)?.previousContent ?? null;
  }

  private row(projectId: string, id: string): ProposalRow | undefined {
    return this.db.select().from(aiProposals).where(and(eq(aiProposals.id, id), eq(aiProposals.projectId, projectId))).get();
  }

  list(projectId: string, filter: { status?: ProposalStatus; messageIds?: string[]; agentRunId?: string } = {}, limit = 200): EditProposal[] {
    const conditions = [eq(aiProposals.projectId, projectId)];
    if (filter.status) conditions.push(eq(aiProposals.status, filter.status));
    if (filter.messageIds) {
      if (!filter.messageIds.length) return [];
      conditions.push(inArray(aiProposals.messageId, filter.messageIds));
    }
    if (filter.agentRunId) conditions.push(eq(aiProposals.agentRunId, filter.agentRunId));
    return this.db
      .select()
      .from(aiProposals)
      .where(and(...conditions))
      .orderBy(asc(aiProposals.createdAt), asc(aiProposals.blockIndex))
      .limit(limit)
      .all()
      .map(toProposal);
  }

  /**
   * Move a proposal from one status to another. Returns null when it was not
   * in `from` any more (another request resolved it first).
   */
  transition(
    projectId: string,
    id: string,
    from: ProposalStatus,
    to: ProposalStatus,
    extra: Partial<Pick<ProposalRow, 'appliedHash' | 'previousContent'>> = {},
  ): EditProposal | null {
    const changes = this.db
      .update(aiProposals)
      .set({ status: to, resolvedAt: now(), ...extra })
      .where(and(eq(aiProposals.id, id), eq(aiProposals.projectId, projectId), eq(aiProposals.status, from)))
      .run().changes;
    return changes ? this.get(projectId, id) : null;
  }

  /** Record the file hash an accepted proposal produced. */
  setApplied(projectId: string, id: string, appliedHash: string | null): EditProposal | null {
    this.db
      .update(aiProposals)
      .set({ appliedHash })
      .where(and(eq(aiProposals.id, id), eq(aiProposals.projectId, projectId), eq(aiProposals.status, 'accepted')))
      .run();
    return this.get(projectId, id);
  }

  /** Pending proposals for `file` whose base no longer matches `currentHash` become stale. */
  markStale(projectId: string, file: string, currentHash: string | null): EditProposal[] {
    const affected = this.db
      .select()
      .from(aiProposals)
      .where(and(eq(aiProposals.projectId, projectId), eq(aiProposals.file, file), eq(aiProposals.status, 'pending')))
      .all()
      .filter((r) => r.baseHash !== currentHash);
    if (!affected.length) return [];
    this.db
      .update(aiProposals)
      .set({ status: 'stale', resolvedAt: now() })
      .where(and(inArray(aiProposals.id, affected.map((r) => r.id)), eq(aiProposals.status, 'pending')))
      .run();
    return affected.map((r) => ({ ...toProposal(r), status: 'stale' as const }));
  }
}

// -------------------------------------------------------------- agent runs

type RunRow = typeof aiAgentRuns.$inferSelect;

export class AgentRunRepository {
  constructor(private readonly db: AiDb) {}

  create(input: { id: string; projectId: string; conversationId: string; messageId: string; agentId: string; permission: AgentPermissionProfile; model: string | null }): AgentRun {
    const row: RunRow = {
      ...input,
      status: 'starting',
      externalSessionId: null,
      startedAt: now(),
      finishedAt: null,
      usage: null,
      changedFiles: [],
      error: null,
    };
    this.db.insert(aiAgentRuns).values(row).run();
    return row;
  }

  get(projectId: string, id: string): AgentRun | null {
    return this.db.select().from(aiAgentRuns).where(and(eq(aiAgentRuns.id, id), eq(aiAgentRuns.projectId, projectId))).get() ?? null;
  }

  byMessage(messageId: string): AgentRun | null {
    return this.db.select().from(aiAgentRuns).where(eq(aiAgentRuns.messageId, messageId)).get() ?? null;
  }

  listByConversation(conversationId: string): AgentRun[] {
    return this.db.select().from(aiAgentRuns).where(eq(aiAgentRuns.conversationId, conversationId)).orderBy(asc(aiAgentRuns.startedAt)).all();
  }

  update(id: string, patch: Partial<Pick<RunRow, 'status' | 'externalSessionId' | 'model' | 'finishedAt' | 'usage' | 'changedFiles' | 'error'>>): AgentRun | null {
    this.db.update(aiAgentRuns).set(patch).where(eq(aiAgentRuns.id, id)).run();
    return this.db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, id)).get() ?? null;
  }

  failInterrupted(message: string): number {
    return this.db
      .update(aiAgentRuns)
      .set({ status: 'failed' as AgentRunStatus, error: message, finishedAt: now() })
      .where(inArray(aiAgentRuns.status, ['starting', 'running']))
      .run().changes;
  }
}

// --------------------------------------------------------- agent approvals

export interface AgentApproval {
  agentId: string;
  permission: AgentPermissionProfile;
  approvedAt: string;
}

export class AgentApprovalRepository {
  constructor(private readonly db: AiDb) {}

  list(projectId: string): AgentApproval[] {
    return this.db
      .select({ agentId: aiAgentApprovals.agentId, permission: aiAgentApprovals.permission, approvedAt: aiAgentApprovals.approvedAt })
      .from(aiAgentApprovals)
      .where(eq(aiAgentApprovals.projectId, projectId))
      .orderBy(asc(aiAgentApprovals.agentId), asc(aiAgentApprovals.permission))
      .all();
  }

  isApproved(projectId: string, agentId: string, permission: AgentPermissionProfile): boolean {
    return !!this.db
      .select({ a: aiAgentApprovals.agentId })
      .from(aiAgentApprovals)
      .where(and(eq(aiAgentApprovals.projectId, projectId), eq(aiAgentApprovals.agentId, agentId), eq(aiAgentApprovals.permission, permission)))
      .get();
  }

  set(projectId: string, agentId: string, permission: AgentPermissionProfile, approved: boolean): void {
    if (approved) {
      this.db.insert(aiAgentApprovals).values({ projectId, agentId, permission, approvedAt: now() }).onConflictDoNothing().run();
    } else {
      this.db
        .delete(aiAgentApprovals)
        .where(and(eq(aiAgentApprovals.projectId, projectId), eq(aiAgentApprovals.agentId, agentId), eq(aiAgentApprovals.permission, permission)))
        .run();
    }
  }
}

// ------------------------------------------------------ staging workspaces

export type StagingRecord = typeof aiStagingWorkspaces.$inferSelect;

export class StagingRepository {
  constructor(private readonly db: AiDb) {}

  get(sessionId: string): StagingRecord | null {
    return this.db.select().from(aiStagingWorkspaces).where(eq(aiStagingWorkspaces.sessionId, sessionId)).get() ?? null;
  }

  list(): StagingRecord[] {
    return this.db.select().from(aiStagingWorkspaces).orderBy(asc(aiStagingWorkspaces.lastActiveAt)).all();
  }

  /** Record that a session's copy is in use (created on first use). */
  activate(input: { sessionId: string; projectId: string; agentId: string }): StagingRecord {
    const at = now();
    this.db
      .insert(aiStagingWorkspaces)
      .values({ ...input, state: 'active', bytes: 0, files: 0, createdAt: at, lastActiveAt: at })
      .onConflictDoUpdate({ target: aiStagingWorkspaces.sessionId, set: { state: 'active', lastActiveAt: at, agentId: input.agentId } })
      .run();
    return this.get(input.sessionId)!;
  }

  /** The run finished; remember the copy's size. */
  release(sessionId: string, size: { bytes: number; files: number } | null): void {
    this.db
      .update(aiStagingWorkspaces)
      .set({ state: 'idle', lastActiveAt: now(), ...(size ?? {}) })
      .where(eq(aiStagingWorkspaces.sessionId, sessionId))
      .run();
  }

  /** The copy was prepared: remember its size. */
  touch(sessionId: string, size: { bytes: number; files: number }): void {
    this.db.update(aiStagingWorkspaces).set({ ...size, lastActiveAt: now() }).where(eq(aiStagingWorkspaces.sessionId, sessionId)).run();
  }

  delete(sessionId: string): void {
    this.db.delete(aiStagingWorkspaces).where(eq(aiStagingWorkspaces.sessionId, sessionId)).run();
  }

  /** After a crash nothing is running: every copy is idle. */
  releaseAll(): number {
    return this.db.update(aiStagingWorkspaces).set({ state: 'idle' }).where(eq(aiStagingWorkspaces.state, 'active')).run().changes;
  }
}

export interface AiRepositories {
  providers: ProviderRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  proposals: ProposalRepository;
  agentRuns: AgentRunRepository;
  approvals: AgentApprovalRepository;
  staging: StagingRepository;
}

export function createAiRepositories(db: AiDb): AiRepositories {
  return {
    providers: new ProviderRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    proposals: new ProposalRepository(db),
    agentRuns: new AgentRunRepository(db),
    approvals: new AgentApprovalRepository(db),
    staging: new StagingRepository(db),
  };
}
