import { z } from 'zod';
import { AgentActivitySchema, AgentRunSchema, ConversationMessageSchema, EditProposalSchema } from './ai';
import { DocumentJobSchema } from './documents';
import { ImportJobSchema } from './library';
import { ArtifactVersionSchema, VisualTaskSchema } from './visual';
import { CompileJobSchema, ProjectSchema } from './schemas';

/** Messages pushed by the runtime over the WebSocket. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), sessionId: z.string(), serverTime: z.string() }),
  z.object({ type: z.literal('pong'), id: z.string().optional() }),
  z.object({ type: z.literal('compile.queued'), job: CompileJobSchema }),
  z.object({ type: z.literal('compile.started'), job: CompileJobSchema }),
  z.object({
    type: z.literal('compile.output'),
    projectId: z.string(),
    jobId: z.string(),
    chunk: z.string(),
  }),
  z.object({ type: z.literal('compile.finished'), job: CompileJobSchema }),
  z.object({
    type: z.literal('files.changed'),
    projectId: z.string(),
    paths: z.array(z.string()),
    /** Session that made the change, so its own client can skip reloading. */
    originSessionId: z.string().nullable(),
    /**
     * `runtime`: written through the API (by a client, an accepted proposal, ...).
     * `external`: noticed on disk by the watcher (another editor, git, a sync tool).
     */
    source: z.enum(['runtime', 'external']),
    /** What happened to each file (external changes only). */
    changes: z
      .array(z.object({ path: z.string(), change: z.enum(['added', 'changed', 'deleted', 'renamed']), from: z.string().optional() }))
      .optional(),
  }),
  z.object({ type: z.literal('project.updated'), project: ProjectSchema }),
  z.object({ type: z.literal('project.deleted'), projectId: z.string() }),
  z.object({ type: z.literal('session.expired') }),
  // AI (M2). Message text streams as deltas; `ai.message.updated` carries the
  // authoritative state (status, usage, final content).
  z.object({
    type: z.literal('ai.message.delta'),
    projectId: z.string(),
    conversationId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal('ai.message.updated'), projectId: z.string(), message: ConversationMessageSchema }),
  z.object({ type: z.literal('ai.proposal.updated'), projectId: z.string(), proposal: EditProposalSchema }),
  z.object({
    type: z.literal('ai.agent.event'),
    projectId: z.string(),
    conversationId: z.string(),
    run: AgentRunSchema.nullable(),
    activity: AgentActivitySchema.nullable(),
  }),
  // Library (M3.2): import progress, and a notice that items or collections
  // changed (IDs only; clients refetch what they show).
  z.object({ type: z.literal('library.job'), job: ImportJobSchema }),
  z.object({ type: z.literal('library.changed'), kind: z.enum(['items', 'collections']), ids: z.array(z.string()) }),
  // Documents and retrieval (M3.3): processing progress, and a notice that the
  // search index changed (clients refetch the index status).
  z.object({ type: z.literal('documents.job'), job: DocumentJobSchema }),
  z.object({ type: z.literal('retrieval.changed') }),
  // Visual intelligence (M4): task progress and artifact changes (new version, compile result).
  z.object({ type: z.literal('visual.task'), task: VisualTaskSchema }),
  z.object({ type: z.literal('visual.artifact'), artifactId: z.string(), version: ArtifactVersionSchema.nullable() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** Messages accepted from clients. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.string().max(64).optional() }),
  /** Report external changes to this project's files while the client has it open. */
  z.object({ type: z.literal('project.watch'), projectId: z.string().regex(/^[a-z0-9-]{2,64}$/) }),
  z.object({ type: z.literal('project.unwatch'), projectId: z.string().regex(/^[a-z0-9-]{2,64}$/) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const WS_PATH = '/api/v1/ws';
/** Maximum size of a client WebSocket frame accepted by the runtime. */
export const WS_MAX_CLIENT_MESSAGE_BYTES = 4096;
