import type { z } from 'zod';
import type { ErrorCode } from '@research-studio/shared-types';
import {
  API_PREFIX,
  ApiErrorBodySchema,
  AuditResponse,
  CancelCompileResponse,
  CompileResponse,
  CreateSessionResponse,
  EntryResponse,
  HealthResponse,
  JobDetailResponse,
  JobListResponse,
  ProjectFileContentSchema,
  ProjectListResponse,
  ProjectResponse,
  RuntimeInfoResponse,
  SettingsResponse,
  SymbolsResponse,
  SynctexForwardResponse,
  SynctexInverseResponse,
  TreeResponse,
  UploadResponse,
  WriteFileResponse,
  WsTicketResponse,
  type CreateEntryRequest,
  type CreateProjectRequest,
  type SynctexForwardRequest,
  type SynctexInverseRequest,
  type UpdateProjectRequest,
  type UpdateSettingsRequest,
  type WriteFileRequest,
} from './schemas';
import {
  AgentApprovalsResponse,
  AgentListResponse,
  AiStatusResponse,
  CancelMessageResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationResponse,
  ModelListResponse,
  ProposalListResponse,
  ProposalPreviewResponse,
  ProposalResponse,
  ProviderListResponse,
  ProviderResponse,
  SendMessageResponse,
  type AcceptProposalRequest,
  type CreateConversationRequest,
  type CreateProviderRequest,
  type SendMessageRequest,
  type SetAgentApprovalRequest,
  type UpdateProviderRequest,
} from './ai';
import {
  LiteratureAuthorResponse,
  LiteratureCacheClearResponse,
  LiteratureHistoryResponse,
  LiteraturePreferencesResponse,
  LiteratureProviderResponse,
  LiteratureProvidersResponse,
  LiteratureRelatedResponse,
  LiteratureResolveResponse,
  LiteratureSearchResponse,
  LiteratureWorkResponse,
  type LiteratureSearchRequestSchema,
  type UpdateLiteraturePreferencesRequest,
  type UpdateLiteratureProviderRequest,
} from './literature';
import {
  AddLibraryItemResponse,
  AttachmentResponse,
  BibApplyResponse,
  BibUpdatePreviewSchema,
  BulkLibraryResponse,
  CitationKeySuggestionsResponse,
  CollectionResponse,
  CollectionsResponse,
  CountResponse,
  DeleteItemsResponse,
  DeletionImpactResponse,
  DuplicatesResponse,
  ExportResponse,
  ImportJobListResponse,
  ImportJobResponse,
  LibraryItemPageSchema,
  LibraryItemResponse,
  LibraryOverviewResponse,
  LibraryPreferencesResponse,
  MergeResponse,
  ProjectReferenceSettingsResponse,
  ProjectReferencesSchema,
  ReferencePreviewResponse,
  RegenerateKeysResponse,
  StorageReportResponse,
  TagsResponse,
  ZoteroExportPreviewResponse,
  ZoteroImportPreviewSchema,
  ZoteroStatusResponse,
  type AddLibraryItemRequest,
  type BibApplyRequest,
  type BibPreviewRequest,
  type BulkLibraryRequest,
  type CreateCollectionRequest,
  type ExportRequest,
  type IdentifierImportRequest,
  type MatchRequest,
  type ReferenceImportRequest,
  type ReferencePreviewRequest,
  type UpdateCollectionRequest,
  type UpdateLibraryItemRequest,
  type UpdateLibraryPreferencesRequest,
  type UpdateProjectReferenceSettingsRequest,
  type ZoteroImportPreviewRequest,
  type ZoteroImportRequest,
} from './library';
import {
  DocumentElementsResponse,
  DocumentJobListResponse,
  DocumentJobResponse,
  DocumentPassagesResponse,
  DocumentReferencesResponse,
  DocumentSectionsResponse,
  DocumentStatusResponse,
  DocumentStructureResponse,
  IndexStatusResponse,
  PassageDetailResponse,
  PassageLocationResponse,
  ProcessAllResponse,
  ResearchSearchResponse,
  RetrievalProvidersResponse,
  type ResearchSearchRequest,
  type SimilarPassagesRequest,
  type UpdateRetrievalSettingsRequest,
} from './documents';
import {
  ArtifactListResponse,
  ArtifactResponse,
  ArtifactVersionSchema,
  ArtifactVersionsResponse,
  CompareResponse,
  InsertionListResponse,
  InsertionPlanSchema,
  InsertionResponse,
  ProviderCheckResponse,
  RefineResponse,
  RollbackResponse,
  ValidateResponse,
  VisualArtifactSchema,
  VisualAssetDetailResponse,
  VisualAssetListResponse,
  VisualAssetResponse,
  VisualAssetSchema,
  VisualProvidersResponse,
  VisualTaskListResponse,
  VisualTaskResponse,
  type ApplyInsertionRequest,
  type CreateVisualTaskRequest,
  type InsertionOptionsSchema,
  type ManualEditRequest,
  type PlotUpdateRequest,
  type PreprocessOperationSchema,
  type RefineRequest,
} from './visual';
import { z as zod } from 'zod';
import type { LibraryItemQuery, LiteratureProviderId, ProposalStatus } from '@research-studio/shared-types';

export class RuntimeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeApiError';
  }
}

export interface RuntimeClientOptions {
  /** Origin of the runtime, e.g. `http://127.0.0.1:4317`. */
  baseUrl: string;
  getSessionToken: () => string | null;
  fetch?: typeof fetch;
  /** Called when the runtime rejects the session (401). */
  onUnauthorized?: () => void;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  auth?: boolean;
  formData?: FormData;
  /** Aborting rejects with the signal's reason (an `AbortError`), not a RuntimeApiError. */
  signal?: AbortSignal;
}

export function createRuntimeClient(options: RuntimeClientOptions) {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(`${base}${API_PREFIX}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {};
    if (opts.auth !== false) {
      const token = options.getSessionToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let body: FormData | string | undefined;
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let response: Response;
    try {
      response = await doFetch(url, { method, headers, ...(body !== undefined ? { body } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new RuntimeApiError(0, 'NETWORK', `Cannot reach the runtime at ${base}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (!response.ok) {
      let parsed: z.infer<typeof ApiErrorBodySchema> | null;
      try {
        parsed = ApiErrorBodySchema.parse(await response.json());
      } catch {
        parsed = null;
      }
      if (response.status === 401 && opts.auth !== false) options.onUnauthorized?.();
      throw new RuntimeApiError(
        response.status,
        parsed?.error.code ?? 'BAD_RESPONSE',
        parsed?.error.message ?? `Runtime responded with HTTP ${response.status}`,
        parsed?.error.details,
      );
    }
    return response;
  }

  async function json<S extends z.ZodType>(schema: S, method: string, path: string, opts?: RequestOptions) {
    const response = await send(method, path, opts);
    const data: unknown = await response.json();
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new RuntimeApiError(response.status, 'BAD_RESPONSE', 'Unexpected response from the runtime', result.error.issues);
    }
    return result.data as z.infer<S>;
  }

  async function empty(method: string, path: string, opts?: RequestOptions): Promise<void> {
    await send(method, path, opts);
  }

  const p = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
  const work = (workId: string) => `/literature/works/${encodeURIComponent(workId)}`;
  const item = (itemId: string) => `/library/items/${encodeURIComponent(itemId)}`;
  const attachment = (attachmentId: string) => `/library/attachments/${encodeURIComponent(attachmentId)}`;
  const collection = (collectionId: string) => `/library/collections/${encodeURIComponent(collectionId)}`;
  const doc = (attachmentId: string) => `/documents/${encodeURIComponent(attachmentId)}`;
  const art = (artifactId: string) => `/visual/artifacts/${encodeURIComponent(artifactId)}`;
  const VersionResponse = zod.object({ version: ArtifactVersionSchema });
  /** DOIs and old-style arXiv IDs contain `/`; each segment is encoded on its own. */
  const segments = (id: string) => id.split('/').map(encodeURIComponent).join('/');

  return {
    baseUrl: base,

    health: () => json(HealthResponse, 'GET', '/health', { auth: false }),
    createSession: (pairingToken: string) =>
      json(CreateSessionResponse, 'POST', '/auth/session', { auth: false, body: { pairingToken } }),
    deleteSession: () => empty('DELETE', '/auth/session'),
    wsTicket: () => json(WsTicketResponse, 'POST', '/auth/ws-ticket'),
    runtimeInfo: () => json(RuntimeInfoResponse, 'GET', '/runtime/info'),

    listProjects: () => json(ProjectListResponse, 'GET', '/projects'),
    createProject: (input: z.input<typeof CreateProjectRequest>) =>
      json(ProjectResponse, 'POST', '/projects', { body: input }),
    getProject: (projectId: string) => json(ProjectResponse, 'GET', p(projectId)),
    updateProject: (projectId: string, patch: z.input<typeof UpdateProjectRequest>) =>
      json(ProjectResponse, 'PATCH', p(projectId), { body: patch }),
    deleteProject: (projectId: string, deleteFiles = false) =>
      empty('DELETE', p(projectId), { query: { deleteFiles } }),

    tree: (projectId: string) => json(TreeResponse, 'GET', `${p(projectId)}/tree`),
    symbols: (projectId: string) => json(SymbolsResponse, 'GET', `${p(projectId)}/symbols`),
    readFile: (projectId: string, path: string) =>
      json(ProjectFileContentSchema, 'GET', `${p(projectId)}/files/content`, { query: { path } }),
    writeFile: (projectId: string, input: z.input<typeof WriteFileRequest>) =>
      json(WriteFileResponse, 'PUT', `${p(projectId)}/files/content`, { body: input }),
    createEntry: (projectId: string, input: z.input<typeof CreateEntryRequest>) =>
      json(EntryResponse, 'POST', `${p(projectId)}/files`, { body: input }),
    renameEntry: (projectId: string, from: string, to: string) =>
      json(EntryResponse, 'POST', `${p(projectId)}/files/rename`, { body: { from, to } }),
    deleteEntry: (projectId: string, path: string) =>
      empty('DELETE', `${p(projectId)}/files`, { query: { path } }),
    rawFile: async (projectId: string, path: string): Promise<Blob> =>
      (await send('GET', `${p(projectId)}/files/raw`, { query: { path } })).blob(),
    upload: (projectId: string, file: Blob, fileName: string, directory = '') => {
      const form = new FormData();
      form.append('directory', directory);
      form.append('file', file, fileName);
      return json(UploadResponse, 'POST', `${p(projectId)}/uploads`, { formData: form });
    },

    compile: (projectId: string) => json(CompileResponse, 'POST', `${p(projectId)}/compile`),
    cancelCompile: (projectId: string) => json(CancelCompileResponse, 'POST', `${p(projectId)}/compile/cancel`),
    listJobs: (projectId: string) => json(JobListResponse, 'GET', `${p(projectId)}/compile/jobs`),
    getJob: (projectId: string, jobId: string) =>
      json(JobDetailResponse, 'GET', `${p(projectId)}/compile/jobs/${encodeURIComponent(jobId)}`),
    pdf: async (projectId: string): Promise<ArrayBuffer> =>
      (await send('GET', `${p(projectId)}/pdf`)).arrayBuffer(),
    synctexForward: (projectId: string, input: z.input<typeof SynctexForwardRequest>) =>
      json(SynctexForwardResponse, 'POST', `${p(projectId)}/synctex/forward`, { body: input }),
    synctexInverse: (projectId: string, input: z.input<typeof SynctexInverseRequest>) =>
      json(SynctexInverseResponse, 'POST', `${p(projectId)}/synctex/inverse`, { body: input }),

    getSettings: () => json(SettingsResponse, 'GET', '/settings'),
    updateSettings: (patch: z.input<typeof UpdateSettingsRequest>) =>
      json(SettingsResponse, 'PATCH', '/settings', { body: patch }),
    audit: (query: { limit?: number; projectId?: string } = {}) =>
      json(AuditResponse, 'GET', '/audit', { query }),

    ai: {
      status: () => json(AiStatusResponse, 'GET', '/ai/status'),
      listProviders: () => json(ProviderListResponse, 'GET', '/ai/providers'),
      createProvider: (input: z.input<typeof CreateProviderRequest>) =>
        json(ProviderResponse, 'POST', '/ai/providers', { body: input }),
      updateProvider: (providerId: string, patch: z.input<typeof UpdateProviderRequest>) =>
        json(ProviderResponse, 'PATCH', `/ai/providers/${encodeURIComponent(providerId)}`, { body: patch }),
      deleteProvider: (providerId: string) => empty('DELETE', `/ai/providers/${encodeURIComponent(providerId)}`),
      listModels: (providerId: string) =>
        json(ModelListResponse, 'GET', `/ai/providers/${encodeURIComponent(providerId)}/models`),
      listAgents: (refresh = false) =>
        json(AgentListResponse, 'GET', '/ai/agents', { query: { refresh: refresh ? '1' : undefined } }),

      agentApprovals: (projectId: string) => json(AgentApprovalsResponse, 'GET', `${p(projectId)}/ai/agent-approvals`),
      setAgentApproval: (projectId: string, input: z.input<typeof SetAgentApprovalRequest>) =>
        json(AgentApprovalsResponse, 'PUT', `${p(projectId)}/ai/agent-approvals`, { body: input }),

      listConversations: (projectId: string) => json(ConversationListResponse, 'GET', `${p(projectId)}/ai/conversations`),
      createConversation: (projectId: string, input: z.input<typeof CreateConversationRequest>) =>
        json(ConversationResponse, 'POST', `${p(projectId)}/ai/conversations`, { body: input }),
      getConversation: (projectId: string, conversationId: string) =>
        json(ConversationDetailResponse, 'GET', `${p(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}`),
      deleteConversation: (projectId: string, conversationId: string) =>
        empty('DELETE', `${p(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}`),
      sendMessage: (projectId: string, conversationId: string, input: z.input<typeof SendMessageRequest>) =>
        json(SendMessageResponse, 'POST', `${p(projectId)}/ai/conversations/${encodeURIComponent(conversationId)}/messages`, { body: input }),
      cancelMessage: (projectId: string, messageId: string) =>
        json(CancelMessageResponse, 'POST', `${p(projectId)}/ai/messages/${encodeURIComponent(messageId)}/cancel`),

      listProposals: (projectId: string, status?: ProposalStatus) =>
        json(ProposalListResponse, 'GET', `${p(projectId)}/ai/proposals`, { query: { status } }),
      previewProposal: (projectId: string, proposalId: string) =>
        json(ProposalPreviewResponse, 'GET', `${p(projectId)}/ai/proposals/${encodeURIComponent(proposalId)}/preview`),
      acceptProposal: (projectId: string, proposalId: string, input: z.input<typeof AcceptProposalRequest> = {}) =>
        json(ProposalResponse, 'POST', `${p(projectId)}/ai/proposals/${encodeURIComponent(proposalId)}/accept`, { body: input }),
      rejectProposal: (projectId: string, proposalId: string) =>
        json(ProposalResponse, 'POST', `${p(projectId)}/ai/proposals/${encodeURIComponent(proposalId)}/reject`),
      revertProposal: (projectId: string, proposalId: string) =>
        json(ProposalResponse, 'POST', `${p(projectId)}/ai/proposals/${encodeURIComponent(proposalId)}/revert`),
    },

    literature: {
      providers: () => json(LiteratureProvidersResponse, 'GET', '/literature/providers'),
      updateProvider: (providerId: LiteratureProviderId, patch: z.input<typeof UpdateLiteratureProviderRequest>) =>
        json(LiteratureProviderResponse, 'PATCH', `/literature/providers/${providerId}`, { body: patch }),
      testProvider: (providerId: LiteratureProviderId) => json(LiteratureProviderResponse, 'POST', `/literature/providers/${providerId}/test`),
      search: (input: z.input<typeof LiteratureSearchRequestSchema>, signal?: AbortSignal) =>
        json(LiteratureSearchResponse, 'POST', '/literature/search', { body: input, signal }),
      work: (workId: string, signal?: AbortSignal) => json(LiteratureWorkResponse, 'GET', work(workId), { signal }),
      references: (workId: string, limit?: number, signal?: AbortSignal) =>
        json(LiteratureRelatedResponse, 'GET', `${work(workId)}/references`, { query: { limit }, signal }),
      citations: (workId: string, limit?: number, signal?: AbortSignal) =>
        json(LiteratureRelatedResponse, 'GET', `${work(workId)}/citations`, { query: { limit }, signal }),
      resolveDoi: (doi: string, signal?: AbortSignal) => json(LiteratureResolveResponse, 'GET', `/literature/resolve/doi/${segments(doi)}`, { signal }),
      resolveArxiv: (arxivId: string, signal?: AbortSignal) =>
        json(LiteratureResolveResponse, 'GET', `/literature/resolve/arxiv/${segments(arxivId)}`, { signal }),
      author: (authorId: string, signal?: AbortSignal) =>
        json(LiteratureAuthorResponse, 'GET', `/literature/authors/${encodeURIComponent(authorId)}`, { signal }),
      history: (limit?: number) => json(LiteratureHistoryResponse, 'GET', '/literature/history', { query: { limit } }),
      deleteHistoryEntry: (id: number) => empty('DELETE', `/literature/history/${id}`),
      clearHistory: () => empty('DELETE', '/literature/history'),
      preferences: () => json(LiteraturePreferencesResponse, 'GET', '/literature/preferences'),
      updatePreferences: (patch: z.input<typeof UpdateLiteraturePreferencesRequest>) =>
        json(LiteraturePreferencesResponse, 'PATCH', '/literature/preferences', { body: patch }),
      clearCache: () => json(LiteratureCacheClearResponse, 'DELETE', '/literature/cache'),
    },

    library: {
      overview: () => json(LibraryOverviewResponse, 'GET', '/library/overview'),
      preferences: () => json(LibraryPreferencesResponse, 'GET', '/library/preferences'),
      updatePreferences: (patch: z.input<typeof UpdateLibraryPreferencesRequest>) =>
        json(LibraryPreferencesResponse, 'PATCH', '/library/preferences', { body: patch }),
      tags: () => json(TagsResponse, 'GET', '/library/tags'),

      items: (query: LibraryItemQuery = {}, signal?: AbortSignal) =>
        json(LibraryItemPageSchema, 'GET', '/library/items', { query: { ...query }, signal }),
      add: (input: z.input<typeof AddLibraryItemRequest>, signal?: AbortSignal) =>
        json(AddLibraryItemResponse, 'POST', '/library/items', { body: input, signal }),
      item: (itemId: string) => json(LibraryItemResponse, 'GET', item(itemId)),
      update: (itemId: string, patch: z.input<typeof UpdateLibraryItemRequest>) =>
        json(LibraryItemResponse, 'PATCH', item(itemId), { body: patch }),
      markOpened: (itemId: string) => empty('POST', `${item(itemId)}/opened`),
      bulk: (input: z.input<typeof BulkLibraryRequest>) => json(BulkLibraryResponse, 'POST', '/library/items/bulk', { body: input }),
      deletionImpact: (itemIds: string[]) => json(DeletionImpactResponse, 'POST', '/library/items/deletion-impact', { body: { itemIds } }),
      deleteItems: (itemIds: string[]) => json(DeleteItemsResponse, 'POST', '/library/items/delete', { body: { itemIds } }),
      citationKeySuggestions: (itemId: string) => json(CitationKeySuggestionsResponse, 'GET', `${item(itemId)}/citation-keys`),
      setCitationKey: (itemId: string, key: string, confirm = false) =>
        json(LibraryItemResponse, 'PUT', `${item(itemId)}/citation-key`, { body: { key, confirm } }),
      regenerateCitationKeys: (itemIds: string[], replaceExisting: boolean) =>
        json(RegenerateKeysResponse, 'POST', '/library/citation-keys/regenerate', { body: { itemIds, replaceExisting } }),
      match: (itemId: string, input: z.input<typeof MatchRequest>) => json(LibraryItemResponse, 'POST', `${item(itemId)}/match`, { body: input }),
      refresh: (itemId: string) => json(LibraryItemResponse, 'POST', `${item(itemId)}/refresh`),
      duplicates: () => json(DuplicatesResponse, 'GET', '/library/duplicates'),
      merge: (keepId: string, dropId: string) => json(MergeResponse, 'POST', '/library/merge', { body: { keepId, dropId } }),

      uploadPdfs: (files: { file: Blob; name: string }[], collectionId?: string) => {
        const form = new FormData();
        for (const f of files) form.append('file', f.file, f.name);
        return json(ImportJobResponse, 'POST', '/library/imports/pdf', { formData: form, query: { collectionId } });
      },
      attachPdf: (itemId: string, file: Blob, name: string) => {
        const form = new FormData();
        form.append('file', file, name);
        return json(ImportJobResponse, 'POST', `${item(itemId)}/attachments`, { formData: form });
      },
      fetchOpenAccessPdf: (itemId: string) => json(ImportJobResponse, 'POST', `${item(itemId)}/fetch-pdf`),
      attachmentContent: async (attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer> =>
        (await send('GET', `${attachment(attachmentId)}/content`, { signal })).arrayBuffer(),
      renameAttachment: (attachmentId: string, fileName: string) =>
        json(AttachmentResponse, 'PATCH', attachment(attachmentId), { body: { fileName } }),
      deleteAttachment: (attachmentId: string) => empty('DELETE', attachment(attachmentId)),
      sweepStorage: () => json(StorageReportResponse, 'POST', '/library/storage/sweep'),

      previewReferences: (input: z.input<typeof ReferencePreviewRequest>) =>
        json(ReferencePreviewResponse, 'POST', '/library/imports/references/preview', { body: input }),
      importReferences: (input: z.input<typeof ReferenceImportRequest>) =>
        json(ImportJobResponse, 'POST', '/library/imports/references', { body: input }),
      importIdentifiers: (input: z.input<typeof IdentifierImportRequest>) =>
        json(ImportJobResponse, 'POST', '/library/imports/identifiers', { body: input }),
      jobs: () => json(ImportJobListResponse, 'GET', '/library/jobs'),
      job: (jobId: string) => json(ImportJobResponse, 'GET', `/library/jobs/${encodeURIComponent(jobId)}`),
      cancelJob: (jobId: string) => json(ImportJobResponse, 'POST', `/library/jobs/${encodeURIComponent(jobId)}/cancel`),

      export: (input: z.input<typeof ExportRequest>) => json(ExportResponse, 'POST', '/library/export', { body: input }),

      collections: () => json(CollectionsResponse, 'GET', '/library/collections'),
      createCollection: (input: z.input<typeof CreateCollectionRequest>) =>
        json(CollectionResponse, 'POST', '/library/collections', { body: input }),
      updateCollection: (collectionId: string, patch: z.input<typeof UpdateCollectionRequest>) =>
        json(CollectionResponse, 'PATCH', collection(collectionId), { body: patch }),
      deleteCollection: (collectionId: string) => empty('DELETE', collection(collectionId)),
      addToCollection: (collectionId: string, itemIds: string[]) =>
        json(CountResponse, 'POST', `${collection(collectionId)}/items`, { body: { itemIds } }),
      removeFromCollection: (collectionId: string, itemIds: string[]) =>
        json(CountResponse, 'POST', `${collection(collectionId)}/items/remove`, { body: { itemIds } }),
      moveItems: (fromId: string, toId: string, itemIds: string[]) =>
        json(CountResponse, 'POST', '/library/collections/move', { body: { fromId, toId, itemIds } }),

      zotero: {
        status: (probeLocal = false) => json(ZoteroStatusResponse, 'GET', '/library/zotero', { query: { probe: probeLocal ? '1' : undefined } }),
        setWebKey: (apiKey: string) => json(ZoteroStatusResponse, 'PUT', '/library/zotero/web-key', { body: { apiKey } }),
        deleteWebKey: () => json(ZoteroStatusResponse, 'DELETE', '/library/zotero/web-key'),
        setLocal: (enabled: boolean) => json(ZoteroStatusResponse, 'PUT', '/library/zotero/local', { body: { enabled } }),
        previewImport: (input: z.input<typeof ZoteroImportPreviewRequest>, signal?: AbortSignal) =>
          json(ZoteroImportPreviewSchema, 'POST', '/library/zotero/import/preview', { body: input, signal }),
        import: (input: z.input<typeof ZoteroImportRequest>) => json(ImportJobResponse, 'POST', '/library/zotero/import', { body: input }),
        previewExport: (itemIds: string[]) => json(ZoteroExportPreviewResponse, 'POST', '/library/zotero/export/preview', { body: { itemIds } }),
        export: (itemIds: string[]) => json(ImportJobResponse, 'POST', '/library/zotero/export', { body: { itemIds } }),
        resolveConflict: (itemId: string, keep: 'local' | 'remote') =>
          json(LibraryItemResponse, 'POST', `${item(itemId)}/zotero-conflict`, { body: { keep } }),
      },
    },

    documents: {
      status: (attachmentId: string) => json(DocumentStatusResponse, 'GET', `${doc(attachmentId)}/status`),
      process: (attachmentId: string) => json(DocumentJobResponse, 'POST', `${doc(attachmentId)}/process`),
      reprocess: (attachmentId: string) => json(DocumentJobResponse, 'POST', `${doc(attachmentId)}/reprocess`),
      cancel: (attachmentId: string) => json(DocumentStatusResponse, 'POST', `${doc(attachmentId)}/cancel`),
      structure: (attachmentId: string, signal?: AbortSignal) => json(DocumentStructureResponse, 'GET', `${doc(attachmentId)}/structure`, { signal }),
      sections: (attachmentId: string) => json(DocumentSectionsResponse, 'GET', `${doc(attachmentId)}/sections`),
      passages: (attachmentId: string, offset = 0, limit = 100) => json(DocumentPassagesResponse, 'GET', `${doc(attachmentId)}/passages`, { query: { offset, limit } }),
      references: (attachmentId: string) => json(DocumentReferencesResponse, 'GET', `${doc(attachmentId)}/references`),
      elements: (attachmentId: string) => json(DocumentElementsResponse, 'GET', `${doc(attachmentId)}/elements`),
      jobs: (status: 'active' | 'failed' | 'all' = 'all', limit = 100) => json(DocumentJobListResponse, 'GET', '/documents/jobs', { query: { status, limit } }),
      processAll: () => json(ProcessAllResponse, 'POST', '/documents/process-all'),
    },

    research: {
      search: (input: z.input<typeof ResearchSearchRequest>, signal?: AbortSignal) => json(ResearchSearchResponse, 'POST', '/research/search', { body: input, signal }),
      similar: (input: z.input<typeof SimilarPassagesRequest>, signal?: AbortSignal) => json(ResearchSearchResponse, 'POST', '/research/search/passage', { body: input, signal }),
      passage: (passageId: string) => json(PassageDetailResponse, 'GET', `/research/passages/${encodeURIComponent(passageId)}`),
      location: (passageId: string) => json(PassageLocationResponse, 'GET', `/research/passages/${encodeURIComponent(passageId)}/location`),
    },

    retrieval: {
      providers: (probe = false) => json(RetrievalProvidersResponse, 'GET', '/retrieval/providers', { query: { probe: probe ? '1' : undefined } }),
      updateSettings: (patch: z.input<typeof UpdateRetrievalSettingsRequest>) => json(RetrievalProvidersResponse, 'PATCH', '/retrieval/settings', { body: patch }),
      status: () => json(IndexStatusResponse, 'GET', '/retrieval/index/status'),
      reindex: (rebuild = false) => json(IndexStatusResponse, 'POST', '/retrieval/reindex', { body: { rebuild } }),
      cancelReindex: () => json(IndexStatusResponse, 'POST', '/retrieval/reindex/cancel'),
    },

    visual: {
      upload: (file: Blob, fileName: string, source: 'upload' | 'clipboard' = 'upload', projectId?: string) => {
        const form = new FormData();
        form.set('source', source);
        if (projectId) form.set('projectId', projectId);
        form.set('file', file, fileName);
        return json(VisualAssetResponse, 'POST', '/visual/assets', { formData: form });
      },
      fromProject: (projectId: string, path: string) => json(VisualAssetResponse, 'POST', '/visual/assets/from-project', { body: { projectId, path } }),
      pdfRegion: (png: Blob, region: { attachmentId: string; pageNumber: number; x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number; renderScale: number }) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(region)) form.set(k, String(v));
        form.set('file', png, 'region.png');
        return json(VisualAssetResponse, 'POST', '/visual/assets/pdf-region', { formData: form });
      },
      assets: (projectId?: string) => json(VisualAssetListResponse, 'GET', '/visual/assets', { query: { projectId } }),
      asset: (assetId: string) => json(VisualAssetDetailResponse, 'GET', `/visual/assets/${encodeURIComponent(assetId)}`),
      assetContent: async (assetId: string, signal?: AbortSignal) => (await send('GET', `/visual/assets/${encodeURIComponent(assetId)}/content`, { signal })).blob(),
      variant: (assetId: string, operations: z.input<typeof PreprocessOperationSchema>[], label?: string) =>
        json(zod.object({ asset: VisualAssetSchema }), 'POST', `/visual/assets/${encodeURIComponent(assetId)}/variants`, { body: { operations, ...(label ? { label } : {}) } }),
      providers: () => json(VisualProvidersResponse, 'GET', '/visual/providers'),
      checkProvider: (providerId: string, model: string, taskType?: string) => json(ProviderCheckResponse, 'GET', `/visual/providers/${encodeURIComponent(providerId)}/check`, { query: { model, taskType } }),
      createTask: (input: z.input<typeof CreateVisualTaskRequest>) => json(VisualTaskResponse, 'POST', '/visual/tasks', { body: input }),
      tasks: (projectId?: string) => json(VisualTaskListResponse, 'GET', '/visual/tasks', { query: { projectId } }),
      task: (taskId: string) => json(VisualTaskResponse, 'GET', `/visual/tasks/${encodeURIComponent(taskId)}`),
      cancelTask: (taskId: string) => json(VisualTaskResponse, 'POST', `/visual/tasks/${encodeURIComponent(taskId)}/cancel`),
      retryTask: (taskId: string, consent = false) => json(VisualTaskResponse, 'POST', `/visual/tasks/${encodeURIComponent(taskId)}/retry`, { body: { consent } }),
      chooseTaskType: (taskId: string, taskType: string) => json(VisualTaskResponse, 'POST', `/visual/tasks/${encodeURIComponent(taskId)}/choose`, { body: { taskType } }),
      artifacts: (projectId?: string) => json(ArtifactListResponse, 'GET', '/visual/artifacts', { query: { projectId } }),
      artifact: (artifactId: string) => json(ArtifactResponse, 'GET', art(artifactId)),
      versions: (artifactId: string) => json(ArtifactVersionsResponse, 'GET', `${art(artifactId)}/versions`),
      saveVersion: (artifactId: string, input: z.input<typeof ManualEditRequest>) => json(VersionResponse, 'POST', `${art(artifactId)}/versions`, { body: input }),
      restore: (artifactId: string, version: number) => json(VersionResponse, 'POST', `${art(artifactId)}/restore`, { body: { version } }),
      validate: (artifactId: string, sourceCode?: string) => json(ValidateResponse, 'POST', `${art(artifactId)}/validate`, { body: sourceCode === undefined ? {} : { sourceCode } }),
      compile: (artifactId: string, version?: number) => json(VersionResponse, 'POST', `${art(artifactId)}/compile`, { body: version ? { version } : {} }),
      preview: async (artifactId: string, version: number, signal?: AbortSignal) => (await send('GET', `${art(artifactId)}/versions/${version}/preview`, { signal })).arrayBuffer(),
      refine: (artifactId: string, input: z.input<typeof RefineRequest>, signal?: AbortSignal) => json(RefineResponse, 'POST', `${art(artifactId)}/refine`, { body: input, signal }),
      updatePlot: (artifactId: string, input: z.input<typeof PlotUpdateRequest>) => json(VersionResponse, 'POST', `${art(artifactId)}/plot`, { body: input }),
      approve: (artifactId: string, version: number) => json(zod.object({ artifact: VisualArtifactSchema }), 'POST', `${art(artifactId)}/approve`, { body: { version } }),
      compare: (artifactId: string, from: number, to: number) => json(CompareResponse, 'GET', `${art(artifactId)}/compare`, { query: { from, to } }),
      export: async (artifactId: string, version: number, format: 'tex' | 'standalone' | 'csv' | 'json') => (await send('GET', `${art(artifactId)}/versions/${version}/export`, { query: { format } })).text(),
      previewInsertion: (artifactId: string, input: z.input<typeof InsertionOptionsSchema>) => json(zod.object({ plan: InsertionPlanSchema }), 'POST', `${art(artifactId)}/insert/preview`, { body: input }),
      insert: (artifactId: string, input: z.input<typeof ApplyInsertionRequest>) => json(InsertionResponse, 'POST', `${art(artifactId)}/insert`, { body: input }),
      insertions: (projectId: string) => json(InsertionListResponse, 'GET', '/visual/insertions', { query: { projectId } }),
      rollback: (insertionId: string) => json(RollbackResponse, 'POST', `/visual/insertions/${encodeURIComponent(insertionId)}/rollback`),
    },

    references: {
      get: (projectId: string) => json(ProjectReferencesSchema, 'GET', `${p(projectId)}/references`),
      updateSettings: (projectId: string, patch: z.input<typeof UpdateProjectReferenceSettingsRequest>) =>
        json(ProjectReferenceSettingsResponse, 'PATCH', `${p(projectId)}/references/settings`, { body: patch }),
      link: (projectId: string, itemIds: string[]) => json(CountResponse, 'POST', `${p(projectId)}/references/items`, { body: { itemIds } }),
      unlink: (projectId: string, itemIds: string[]) =>
        json(CountResponse, 'POST', `${p(projectId)}/references/items/remove`, { body: { itemIds } }),
      previewBib: (projectId: string, input: z.input<typeof BibPreviewRequest> = {}) =>
        json(BibUpdatePreviewSchema, 'POST', `${p(projectId)}/references/bib/preview`, { body: input }),
      applyBib: (projectId: string, input: z.input<typeof BibApplyRequest>) =>
        json(BibApplyResponse, 'POST', `${p(projectId)}/references/bib/apply`, { body: input }),
    },
  };
}

export type RuntimeClient = ReturnType<typeof createRuntimeClient>;
