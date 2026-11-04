import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type {
  DocumentJob,
  ExtractionSummary,
  IndexStatus,
  PassageDetail,
  PassageLocation,
  ResearchSearch,
  ResearchSearchRequest,
  RetrievalProviders,
  SearchResult,
  SimilarPassagesRequest,
  UpdateRetrievalSettingsRequest,
  DocumentStructure,
  DocumentReference,
  Passage,
} from '@research-studio/api-contracts';
import type { Repositories, StudioDb } from '@research-studio/database';
import { PARSER_VERSION, SEGMENTER_VERSION, stableStringify, staleReasons, type PageGeometry } from '@research-studio/document-intelligence';
import {
  DEFAULT_GROBID_CONFIGURATION,
  DEFAULT_PROCESSING_LIMITS,
  DocumentStore,
  ExtractionError,
  GrobidClient,
  IngestionQueue,
  IngestionService,
  PyMuPdfClient,
  checkServiceUrl,
  grobidOutputSettings,
  isLoopbackUrl,
  overallProgress,
  STAGE_LABEL,
  type AttachmentInfo,
  type EmbedOutcome,
  type ExtractionRow,
  type GrobidHealth,
  type JobRow,
  type PassageRow,
  type ProcessingLimits,
} from '@research-studio/paper-ingestion';
import { applyEdits, type AttachmentService, type LibraryRepository } from '@research-studio/research-library';
import {
  DEFAULT_CHUNKING,
  EMBEDDED_KINDS,
  EmbeddingError,
  EmbeddingIndexer,
  HybridSearchEngine,
  OllamaEmbeddingProvider,
  parseQuery,
  SqliteVectorStore,
  segmentDocument,
  sweepIndexes,
  type EmbeddingProvider,
  type EmbeddingSpace,
  type SemanticBackend,
} from '@research-studio/research-retrieval';
import { StudioError } from '@research-studio/shared-types';
import type { RuntimeConfig } from '../config';
import type { EventBus } from '../events';
import type { AuditService } from './audit-service';
import type { Actor } from './project-service';

const SCOPE = 'retrieval';
const HOUR = 60 * 60 * 1000;

interface RetrievalSettings {
  autoProcess: boolean;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  embeddingBaseUrl: string | null;
}

const DEFAULT_SETTINGS: RetrievalSettings = { autoProcess: false, embeddingsEnabled: false, embeddingModel: 'nomic-embed-text', embeddingBaseUrl: null };

interface ReindexState {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  targetModel: string;
  targetSpaceId: string | null;
  rebuild: boolean;
  done: number;
  total: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DocumentRuntimeOptions {
  /** Test seams. */
  grobidFetch?: typeof fetch;
  embeddingFetch?: typeof fetch;
  limits?: Partial<ProcessingLimits>;
  grobidBusyDelayMs?: number;
}

type Scope = z.infer<typeof ResearchSearchRequest>['scope'];
type Filters = z.infer<typeof ResearchSearchRequest>['filters'];

const notFound = (what: string) => new StudioError('NOT_FOUND', what);
const toPassage = (p: PassageRow): Passage => ({
  id: p.id,
  extractionId: p.extractionId,
  order: p.passageOrder,
  kind: p.kind,
  sectionId: p.sectionId,
  sectionPath: p.sectionPath,
  sectionType: p.sectionType,
  text: p.text,
  tokenCount: p.tokenCount,
  textHash: p.textHash,
  stableKey: p.stableKey,
  pageStart: p.pageStart,
  pageEnd: p.pageEnd,
  coordinates: p.coordinates,
});

/**
 * Document intelligence and retrieval inside the runtime: the ingestion
 * queue over library attachments, GROBID and PyMuPDF from the operator's
 * configuration, the keyword and vector indexes in the studio database, the
 * embedding provider from settings, and the search API. PDFs are read only
 * through the library's attachment store.
 */
export class DocumentRuntime {
  readonly store: DocumentStore;
  readonly vectors: SqliteVectorStore;
  readonly engine: HybridSearchEngine;
  readonly queue: IngestionQueue;
  private readonly indexer: EmbeddingIndexer;
  private readonly sqlite: Database.Database;
  private readonly limits: ProcessingLimits;
  private grobid: GrobidClient | null = null;
  private grobidRefusal: string | null = null;
  private grobidHealth: GrobidHealth | null = null;
  private readonly pymupdf: PyMuPdfClient | null;
  private providerCache: { key: string; provider: OllamaEmbeddingProvider } | null = null;
  private reindexController: AbortController | null = null;
  private reindexDone: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastIndexedAt: string | null = null;

  constructor(
    db: StudioDb,
    private readonly repos: Repositories,
    private readonly library: { repo: LibraryRepository; attachments: AttachmentService },
    private readonly config: RuntimeConfig,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly options: DocumentRuntimeOptions = {},
  ) {
    // drizzle's better-sqlite3 driver keeps the connection on `$client` (not in the StudioDb type).
    const client = (db as unknown as { $client?: Database.Database }).$client;
    if (!client) throw new Error('The studio database handle has no SQLite connection');
    this.sqlite = client;
    this.store = new DocumentStore(db);
    this.vectors = new SqliteVectorStore(this.sqlite);
    this.engine = new HybridSearchEngine(this.sqlite, this.vectors);
    this.indexer = new EmbeddingIndexer(this.sqlite, this.vectors);
    const d = config.documents;
    this.limits = { ...DEFAULT_PROCESSING_LIMITS, maxPdfBytes: config.library.maxPdfBytes, maxPages: d.maxPages, grobidTimeoutMs: d.grobidTimeoutMs, ...options.limits };
    if (d.grobidEnabled) {
      try {
        this.grobid = new GrobidClient(
          {
            ...DEFAULT_GROBID_CONFIGURATION,
            baseUrl: d.grobidUrl,
            allowRemote: d.grobidAllowRemote,
            timeoutMs: d.grobidTimeoutMs,
            concurrency: d.concurrency,
            consolidateHeader: d.grobidConsolidation ? 1 : 0,
            consolidateCitations: d.grobidConsolidation ? 1 : 0,
            ...(options.grobidBusyDelayMs !== undefined ? { busyRetryDelayMs: options.grobidBusyDelayMs } : {}),
          },
          { ...(options.grobidFetch ? { fetch: options.grobidFetch } : {}), maxResponseBytes: this.limits.maxOutputBytes },
        );
      } catch (err) {
        this.grobidRefusal = err instanceof Error ? err.message : String(err);
      }
    }
    this.pymupdf = d.pymupdfEnabled
      ? new PyMuPdfClient({ python: d.python, timeoutMs: this.limits.pymupdfTimeoutMs, memoryMb: this.limits.pymupdfMemoryMb, maxPages: d.maxPages, maxOutputBytes: this.limits.maxOutputBytes, concurrency: d.concurrency })
      : null;

    const service = new IngestionService({
      store: this.store,
      limits: this.limits,
      readPdf: (a: AttachmentInfo) => this.library.attachments.readBytes(a.attachmentId),
      grobid: this.grobid,
      pymupdf: this.pymupdf,
      segment: (doc, sha) => segmentDocument(doc, sha, DEFAULT_CHUNKING),
      indexKeywords: (id) => {
        this.engine.keyword.indexExtraction(id);
        this.vectors.invalidate();
        this.lastIndexedAt = new Date().toISOString();
      },
      embed: (id, signal, progress) => this.embedExtraction(id, signal, progress),
      configuration: () => this.configuration(),
    });
    this.queue = new IngestionQueue({
      store: this.store,
      service,
      concurrency: d.concurrency,
      configHash: () => this.configuration().configHash,
      onUpdate: (job) => {
        this.events.publish({ type: 'documents.job', job: this.toJob(job) });
        if (job.status === 'completed' || job.status === 'partial' || job.status === 'needs_ocr') this.events.publish({ type: 'retrieval.changed' });
      },
    });
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const resumed = this.queue.resume();
    const sweep = sweepIndexes(this.sqlite, this.vectors);
    if (resumed || sweep.vectorsRemoved) this.log.info({ resumed, ...sweep }, 'documents: resumed jobs and swept indexes');
    const reindex = this.reindexState();
    if (reindex?.status === 'running') this.startReindex(reindex.rebuild, null, true);
    this.timer = setInterval(() => {
      try {
        sweepIndexes(this.sqlite, this.vectors);
        this.store.pruneFinishedJobs(5);
      } catch (err) {
        this.log.warn({ err }, 'documents: index sweep failed');
      }
    }, HOUR);
    this.timer.unref();
    // New PDFs are processed automatically when the user turned that on.
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type === 'library.changed') this.vectors.invalidate();
      if (event.type === 'library.job' && event.job.status === 'completed' && this.settings().autoProcess) {
        try {
          this.processAll(null);
        } catch (err) {
          this.log.warn({ err }, 'documents: automatic processing failed');
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.reindexController?.abort();
    await this.reindexDone?.catch(() => {});
    await this.queue.stop();
  }

  // ------------------------------------------------------------- settings

  settings(): RetrievalSettings {
    const stored = (this.repos.settings.get(SCOPE, 'settings') as Partial<RetrievalSettings> | undefined) ?? {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  private embeddingBaseUrl(s = this.settings()): string {
    return (s.embeddingBaseUrl ?? this.config.documents.ollamaUrl).replace(/\/+$/, '');
  }

  updateSettings(patch: z.infer<typeof UpdateRetrievalSettingsRequest>, actor: Actor): Promise<RetrievalProviders> {
    if (patch.embeddingBaseUrl) {
      try {
        checkServiceUrl(patch.embeddingBaseUrl, this.config.documents.embeddingsAllowRemote, 'The embedding service');
      } catch (err) {
        throw new StudioError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
      }
    }
    const next = { ...this.settings(), ...patch };
    this.repos.settings.setMany(SCOPE, { settings: next });
    this.providerCache = null;
    this.audit.record({ action: 'retrieval.settings', outcome: 'success', actor: actor.sessionId, details: { ...patch } });
    return this.providers(true);
  }

  /** The configuration recorded with each extraction; a change marks older extractions stale. */
  configuration(): { config: Record<string, unknown>; configHash: string } {
    const config = {
      grobid: this.grobid ? grobidOutputSettings(this.grobid.config) : null,
      pymupdf: !!this.pymupdf,
      chunking: DEFAULT_CHUNKING,
      parserVersion: PARSER_VERSION,
      segmenterVersion: SEGMENTER_VERSION,
      maxPages: this.limits.maxPages,
    };
    return { config, configHash: createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 32) };
  }

  private embeddingProvider(): OllamaEmbeddingProvider | null {
    const s = this.settings();
    if (!s.embeddingsEnabled) return null;
    const base = this.embeddingBaseUrl(s);
    const key = `${base}|${s.embeddingModel}`;
    if (this.providerCache?.key !== key) {
      checkServiceUrl(base, this.config.documents.embeddingsAllowRemote, 'The embedding service');
      this.providerCache = { key, provider: new OllamaEmbeddingProvider({ baseUrl: base, model: s.embeddingModel, ...(this.options.embeddingFetch ? { fetch: this.options.embeddingFetch } : {}) }) };
    }
    return this.providerCache.provider;
  }

  /** Identifies the index results come from (active embedding space), for evidence provenance. */
  retrievalIndexVersion(): string {
    const space = this.activeSpace();
    return space ? `${space.id}:${space.model}:${space.dimensions}` : 'keyword-only';
  }

  private activeSpace(): EmbeddingSpace | null {
    const id = this.repos.settings.get(SCOPE, 'activeSpaceId') as string | undefined;
    return id ? this.vectors.space(id) : null;
  }

  private setActiveSpace(id: string | null): void {
    this.repos.settings.setMany(SCOPE, { activeSpaceId: id });
  }

  // ------------------------------------------------------------ embedding

  private async embedExtraction(extractionId: string, signal: AbortSignal, progress: (stage: 'generating_embeddings' | 'indexing_vectors', fraction: number) => void): Promise<EmbedOutcome> {
    let provider: EmbeddingProvider | null;
    try {
      provider = this.embeddingProvider();
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (!provider) return { status: 'skipped' };
    try {
      const info = await provider.getModelInfo(signal);
      const space = this.vectors.ensureSpace(info);
      const active = this.activeSpace();
      if (!active) this.setActiveSpace(space.id);
      else if (active.id !== space.id) {
        return { status: 'skipped', message: `The embedding model changed (the index uses ${active.model}, ${active.dimensions} dimensions). Semantic search keeps using the existing index until you reindex.` };
      }
      await this.indexer.embedExtractions(space, provider, [extractionId], {
        signal,
        onProgress: (p) => progress(p.done >= p.total ? 'indexing_vectors' : 'generating_embeddings', p.total ? p.done / p.total : 1),
      });
      this.events.publish({ type: 'retrieval.changed' });
      return { status: 'done' };
    } catch (err) {
      if (signal.aborted) throw new ExtractionError('cancelled', 'Cancelled');
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private reindexState(): ReindexState | null {
    return (this.repos.settings.get(SCOPE, 'reindex') as ReindexState | undefined) ?? null;
  }

  private saveReindex(state: ReindexState): void {
    this.repos.settings.setMany(SCOPE, { reindex: state });
    this.events.publish({ type: 'retrieval.changed' });
  }

  /**
   * Embed every active extraction into the space of the configured model.
   * A new model gets a new space; the old one stays active (and searchable)
   * until the new one is complete, then it is removed. Vectors of different
   * spaces are never combined.
   */
  startReindex(rebuild: boolean, actor: Actor | null, resuming = false): IndexStatus {
    if (this.reindexController) return this.indexStatus();
    const provider = this.embeddingProvider();
    if (!provider) throw new StudioError('NOT_CONFIGURED', 'Turn on embeddings and choose a model first');
    const s = this.settings();
    const state: ReindexState = { status: 'running', targetModel: s.embeddingModel, targetSpaceId: null, rebuild, done: 0, total: 0, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    if (!resuming && actor) this.audit.record({ action: 'retrieval.reindex', outcome: 'success', actor: actor.sessionId, details: { model: s.embeddingModel, rebuild } });
    this.saveReindex(state);
    const controller = new AbortController();
    this.reindexController = controller;
    this.reindexDone = (async () => {
      try {
        const info = await provider.getModelInfo(controller.signal);
        const space = this.vectors.ensureSpace(info);
        state.targetSpaceId = space.id;
        if (rebuild && !resuming) {
          this.sqlite.prepare('DELETE FROM passage_embeddings WHERE space_id = ?').run(space.id);
          this.sqlite.prepare('DELETE FROM embedding_vectors WHERE space_id = ?').run(space.id);
          this.vectors.invalidate(space.id);
        }
        const extractions = this.store.activeExtractions().map((x) => x.id);
        let last = 0;
        await this.indexer.embedExtractions(space, provider, extractions, {
          signal: controller.signal,
          onProgress: (p) => {
            state.done = p.done;
            state.total = p.total;
            if (Date.now() - last > 500 || p.done === p.total) {
              last = Date.now();
              this.saveReindex(state);
            }
          },
        });
        const previous = this.activeSpace();
        this.setActiveSpace(space.id);
        if (previous && previous.id !== space.id) this.vectors.deleteSpace(previous.id);
        sweepIndexes(this.sqlite, this.vectors);
        this.lastIndexedAt = new Date().toISOString();
        this.saveReindex({ ...state, status: 'completed', finishedAt: new Date().toISOString() });
      } catch (err) {
        const cancelled = controller.signal.aborted || (err instanceof EmbeddingError && err.code === 'cancelled');
        this.saveReindex({ ...state, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() });
      } finally {
        this.reindexController = null;
      }
    })();
    return this.indexStatus();
  }

  async cancelReindex(): Promise<IndexStatus> {
    this.reindexController?.abort();
    await this.reindexDone?.catch(() => {});
    return this.indexStatus();
  }

  waitForReindex(): Promise<void> {
    return this.reindexDone ?? Promise.resolve();
  }

  // ------------------------------------------------------------- statuses

  async providers(probe = false): Promise<RetrievalProviders> {
    const d = this.config.documents;
    const s = this.settings();
    if (this.grobid && (probe || !this.grobidHealth || Date.now() - Date.parse(this.grobidHealth.checkedAt) > 60_000)) this.grobidHealth = await this.grobid.health();
    const grobid = !d.grobidEnabled
      ? { status: 'disabled' as const, version: null, message: 'GROBID is turned off (RS_GROBID=off)', host: null, remote: false }
      : this.grobidRefusal
        ? { status: 'refused' as const, version: null, message: this.grobidRefusal, host: new URL(d.grobidUrl).host, remote: true }
        : { status: this.grobidHealth!.status, version: this.grobidHealth!.version, message: this.grobidHealth!.message, host: this.grobidHealth!.host, remote: this.grobidHealth!.remote };
    const py = this.pymupdf ? await this.pymupdf.status(probe) : { status: 'disabled' as const, version: null, message: 'PyMuPDF is turned off (RS_PYMUPDF=off)' };
    const base = this.embeddingBaseUrl(s);
    let embeddings: RetrievalProviders['embeddings'] = {
      status: 'disabled',
      version: null,
      message: s.embeddingsEnabled ? null : 'Embeddings are off: semantic search is not available',
      enabled: s.embeddingsEnabled,
      provider: 'ollama',
      model: s.embeddingModel,
      host: new URL(base).host,
      remote: !isLoopbackUrl(base),
      dimensions: null,
    };
    if (s.embeddingsEnabled) {
      try {
        const provider = this.embeddingProvider()!;
        const info = probe || !this.activeSpace() ? await provider.getModelInfo(AbortSignal.timeout(10_000)) : this.activeSpace()!;
        embeddings = { ...embeddings, status: 'available', version: info.version ?? null, dimensions: info.dimensions, message: null };
      } catch (err) {
        embeddings = { ...embeddings, status: 'unavailable', message: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      grobid: { ...grobid, consolidation: d.grobidConsolidation },
      pymupdf: { ...py, python: d.python },
      embeddings,
      settings: { autoProcess: s.autoProcess, embeddingsEnabled: s.embeddingsEnabled, embeddingModel: s.embeddingModel, embeddingBaseUrl: s.embeddingBaseUrl },
    };
  }

  indexStatus(): IndexStatus {
    const one = <T>(sql: string, ...params: unknown[]) => this.sqlite.prepare(sql).get(...params) as T;
    const pdfs = one<{ n: number }>("SELECT COUNT(*) AS n FROM library_attachments a JOIN library_items i ON i.id = a.library_item_id WHERE a.attachment_type = 'pdf' AND i.archived_at IS NULL").n;
    const byStatus = this.sqlite.prepare('SELECT status, COUNT(*) AS n FROM document_extractions WHERE is_active = 1 GROUP BY status').all() as { status: string; n: number }[];
    const count = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
    const { configHash } = this.configuration();
    const stale = one<{ n: number }>('SELECT COUNT(*) AS n FROM document_extractions WHERE is_active = 1 AND (config_hash <> ? OR parser_version <> ?)', configHash, PARSER_VERSION).n;
    const jobs = this.sqlite
      .prepare("SELECT status, COUNT(*) AS n FROM document_jobs WHERE status NOT IN ('completed','partial','needs_ocr','failed','cancelled') GROUP BY status")
      .all() as { status: string; n: number }[];
    const queued = jobs.find((j) => j.status === 'queued')?.n ?? 0;
    const running = jobs.reduce((n, j) => n + (j.status === 'queued' ? 0 : j.n), 0);
    // Failed: the latest job of an attachment failed and it has no usable extraction.
    const failed = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT attachment_id, status, ROW_NUMBER() OVER (PARTITION BY attachment_id ORDER BY created_at DESC, id DESC) AS rn FROM document_jobs) j
       WHERE j.rn = 1 AND j.status = 'failed' AND NOT EXISTS (SELECT 1 FROM document_extractions x WHERE x.attachment_id = j.attachment_id AND x.is_active = 1)`,
    ).n;
    const processed = count('completed') + count('partial');
    const withActive = processed + count('needs_ocr');
    const space = this.activeSpace();
    const embeddable = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM document_passages p JOIN document_extractions x ON x.id = p.extraction_id AND x.is_active = 1 WHERE p.kind IN (SELECT value FROM json_each(?))`,
      JSON.stringify(EMBEDDED_KINDS),
    ).n;
    const reindex = this.reindexState();
    const last = one<{ t: string | null }>('SELECT MAX(processing_completed_at) AS t FROM document_extractions WHERE is_active = 1').t;
    return {
      documents: { pdfAttachments: pdfs, processed, partial: count('partial'), needsOcr: count('needs_ocr'), failed, waiting: Math.max(0, pdfs - withActive - queued - running - failed), queued, running, stale },
      keyword: { passages: this.engine.keyword.count() },
      embeddings: {
        activeSpace: space ? { id: space.id, provider: space.provider, model: space.model, dimensions: space.dimensions, version: space.version ?? null } : null,
        indexedPassages: space ? this.vectors.indexedPassages(space.id) : 0,
        embeddablePassages: embeddable,
        reindex: reindex ? { status: reindex.status, targetModel: reindex.targetModel, done: reindex.done, total: reindex.total, error: reindex.error, startedAt: reindex.startedAt, finishedAt: reindex.finishedAt } : null,
      },
      lastIndexedAt: [last, this.lastIndexedAt].filter(Boolean).sort().at(-1) ?? null,
    };
  }

  toJob(row: JobRow): DocumentJob {
    return {
      id: row.id,
      kind: row.kind,
      attachmentId: row.attachmentId,
      libraryItemId: row.libraryItemId,
      status: row.status,
      stageLabel: STAGE_LABEL[row.status],
      progress: overallProgress(row.status, row.progress),
      error: row.error ?? null,
      retryCount: row.retryCount,
      attempts: row.attempts,
      notes: row.notes,
      extractionId: row.extractionId,
      previousExtractionId: row.previousExtractionId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  private summary(x: ExtractionRow): ExtractionSummary {
    const c = this.sqlite
      .prepare(
        `SELECT (SELECT COUNT(*) FROM document_sections WHERE extraction_id = @id) AS sections,
                (SELECT COUNT(*) FROM document_blocks WHERE extraction_id = @id) AS blocks,
                (SELECT COUNT(*) FROM document_passages WHERE extraction_id = @id) AS passages,
                (SELECT COUNT(*) FROM document_references WHERE extraction_id = @id) AS refs,
                (SELECT COUNT(*) FROM document_elements WHERE extraction_id = @id) AS elements`,
      )
      .get({ id: x.id }) as { sections: number; blocks: number; passages: number; refs: number; elements: number };
    const attachment = this.store.attachmentInfo(x.attachmentId);
    const stale = staleReasons(
      { sourceSha256: x.sourceSha256, extractor: x.extractor, extractorVersion: x.extractorVersion, parserVersion: x.parserVersion, configHash: x.configHash },
      {
        configHash: this.configuration().configHash,
        parserVersion: PARSER_VERSION,
        ...(attachment ? { sourceSha256: attachment.sha256 } : {}),
        ...(x.extractor === 'grobid' && this.grobidHealth?.version ? { extractorVersion: this.grobidHealth.version } : {}),
      },
    );
    return {
      id: x.id,
      attachmentId: x.attachmentId,
      libraryItemId: x.libraryItemId,
      status: x.status,
      isActive: x.isActive,
      extractor: x.extractor,
      extractorVersion: x.extractorVersion,
      parserVersion: x.parserVersion,
      segmenterVersion: x.segmenterVersion,
      configHash: x.configHash,
      sourceSha256: x.sourceSha256,
      pageCount: x.pageCount,
      language: x.language,
      metadata: x.metadata,
      quality: x.quality,
      warnings: x.warnings,
      processingStartedAt: x.processingStartedAt,
      processingCompletedAt: x.processingCompletedAt,
      counts: { sections: c.sections, blocks: c.blocks, passages: c.passages, references: c.refs, elements: c.elements },
      stale,
    };
  }

  private requireAttachment(attachmentId: string): AttachmentInfo {
    const a = this.store.attachmentInfo(attachmentId);
    if (!a) throw notFound(`Attachment ${attachmentId} not found`);
    return a;
  }

  private requireActive(attachmentId: string): ExtractionRow {
    this.requireAttachment(attachmentId);
    const x = this.store.activeExtraction(attachmentId);
    if (!x) throw new StudioError('NOT_FOUND', 'This PDF has not been processed yet', { attachmentId, processed: false });
    return x;
  }

  documentStatus(attachmentId: string) {
    this.requireAttachment(attachmentId);
    const x = this.store.activeExtraction(attachmentId);
    const job = this.store.latestJob(attachmentId);
    const space = this.activeSpace();
    const embeddable = x
      ? (this.sqlite.prepare('SELECT COUNT(*) AS n FROM document_passages WHERE extraction_id = ? AND kind IN (SELECT value FROM json_each(?))').get(x.id, JSON.stringify(EMBEDDED_KINDS)) as { n: number }).n
      : 0;
    return {
      attachmentId,
      extraction: x ? this.summary(x) : null,
      job: job ? this.toJob(job) : null,
      embeddings: { indexedPassages: x && space ? this.vectors.indexedPassages(space.id, x.id) : 0, embeddablePassages: embeddable, spaceId: space?.id ?? null },
    };
  }

  // ------------------------------------------------------------ processing

  process(attachmentId: string, kind: 'process' | 'reprocess', actor: Actor) {
    try {
      const r = this.queue.request(attachmentId, kind);
      if (r.created) this.audit.record({ action: `documents.${kind}`, outcome: 'success', actor: actor.sessionId, target: attachmentId });
      return { job: this.toJob(r.job), created: r.created };
    } catch (err) {
      if (err instanceof ExtractionError) throw new StudioError(err.code === 'missing-file' ? 'NOT_FOUND' : 'VALIDATION_FAILED', err.message);
      throw err;
    }
  }

  cancel(attachmentId: string, actor: Actor) {
    this.requireAttachment(attachmentId);
    const job = this.store.unfinishedJob(attachmentId);
    if (job) {
      this.queue.cancel(job.id);
      this.audit.record({ action: 'documents.cancel', outcome: 'success', actor: actor.sessionId, target: attachmentId });
    }
    return this.documentStatus(attachmentId);
  }

  async waitForJob(jobId: string): Promise<DocumentJob | null> {
    const r = await this.queue.wait(jobId);
    return r ? this.toJob(r) : null;
  }

  /** Queue every PDF that has no extraction and no unfinished job. */
  processAll(actor: Actor | null): { queued: number; alreadyQueued: number } {
    let queued = 0;
    let alreadyQueued = 0;
    for (const a of this.store.unprocessedPdfAttachments()) {
      const latest = this.store.latestJob(a.attachmentId);
      // Failed documents are not retried automatically; the user retries them one by one.
      if (latest?.status === 'failed' && !actor) continue;
      const r = this.queue.request(a.attachmentId, 'process');
      if (r.created) queued++;
      else alreadyQueued++;
    }
    if (actor && queued) this.audit.record({ action: 'documents.process', outcome: 'success', actor: actor.sessionId, details: { queued } });
    return { queued, alreadyQueued };
  }

  jobs(status: 'active' | 'failed' | 'all', limit: number): DocumentJob[] {
    const statuses =
      status === 'active' ? (['queued', 'validating', 'extracting', 'normalizing', 'segmenting', 'indexing_keywords', 'generating_embeddings', 'indexing_vectors'] as const) : status === 'failed' ? (['failed'] as const) : undefined;
    return this.store.listJobs({ ...(statuses ? { statuses: [...statuses] } : {}), limit }).map((j) => this.toJob(j));
  }

  // -------------------------------------------------------------- structure

  private linkedReferences(extractionId: string): DocumentReference[] {
    const rows = this.store.references(extractionId);
    const items = new Map<string, string>();
    const look = this.sqlite.prepare('SELECT i.id AS id FROM scholarly_works w JOIN library_items i ON i.scholarly_work_id = w.id WHERE w.doi = ? OR w.arxiv_id = ? LIMIT 1');
    return rows.map((r) => {
      const key = `${r.doi ?? ''}|${r.arxivId ?? ''}`;
      if (!items.has(key) && (r.doi || r.arxivId)) items.set(key, (look.get(r.doi ?? '\u0000', r.arxivId ?? '\u0000') as { id: string } | undefined)?.id ?? '');
      const linked = items.get(key) || null;
      return {
        id: r.id,
        order: r.referenceOrder,
        raw: r.rawReference,
        parsed: r.parsedMetadata,
        doi: r.doi,
        arxivId: r.arxivId,
        linkedLibraryItemId: linked,
        resolutionStatus: linked ? (r.doi ? 'matched-doi' : 'matched-arxiv') : 'unresolved',
        pageStart: r.pageStart,
        pageEnd: r.pageEnd,
        coordinates: r.coordinates,
      };
    });
  }

  structure(attachmentId: string): DocumentStructure {
    const x = this.requireActive(attachmentId);
    return {
      extraction: this.summary(x),
      pages: x.pages,
      sections: this.sections(x.id),
      blocks: this.store.blocks(x.id).map((b) => ({
        id: b.id,
        sectionId: b.sectionId,
        type: b.blockType,
        order: b.blockOrder,
        spans: b.content,
        text: b.plainText,
        sourceXmlId: b.sourceXmlId,
        elementId: b.elementId,
        sentenceSource: b.sentenceSource,
        pageStart: b.pageStart,
        pageEnd: b.pageEnd,
        coordinates: b.coordinates,
      })),
      elements: this.elements(x.id),
      references: this.linkedReferences(x.id),
    };
  }

  private sections(extractionId: string) {
    return this.store.sections(extractionId).map((s) => ({
      id: s.id,
      parentSectionId: s.parentSectionId,
      heading: s.heading,
      headingNumber: s.headingNumber,
      level: s.sectionLevel,
      order: s.sectionOrder,
      path: s.sectionPath,
      type: s.sectionType,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      coordinates: s.coordinates,
    }));
  }

  private elements(extractionId: string) {
    return this.store.elements(extractionId).map((e) => ({
      id: e.id,
      sectionId: e.sectionId,
      type: e.elementType,
      label: e.label,
      caption: e.caption,
      content: e.content,
      sourceXmlId: e.sourceXmlId,
      pageStart: e.pageStart,
      pageEnd: e.pageEnd,
      coordinates: e.coordinates,
    }));
  }

  sectionsOf(attachmentId: string) {
    const x = this.requireActive(attachmentId);
    return { extractionId: x.id, sections: this.sections(x.id) };
  }

  passagesOf(attachmentId: string, offset: number, limit: number) {
    const x = this.requireActive(attachmentId);
    const { passages, total } = this.store.passages(x.id, { offset, limit });
    return { extractionId: x.id, passages: passages.map(toPassage), total, offset, limit };
  }

  referencesOf(attachmentId: string) {
    const x = this.requireActive(attachmentId);
    return { extractionId: x.id, references: this.linkedReferences(x.id) };
  }

  elementsOf(attachmentId: string) {
    const x = this.requireActive(attachmentId);
    return { extractionId: x.id, elements: this.elements(x.id) };
  }

  // ----------------------------------------------------------------- search

  /** Active, searchable extractions within a scope and the library filters. */
  private resolveScope(scope: Scope, filters: Filters, extra: { itemIds?: string[] } = {}): string[] {
    const where: string[] = ["x.is_active = 1", "x.status IN ('completed', 'partial')"];
    const params: Record<string, unknown> = {};
    if (scope.kind === 'papers') {
      where.push('i.id IN (SELECT value FROM json_each(@items))');
      params.items = JSON.stringify(scope.libraryItemIds);
    } else {
      where.push('i.archived_at IS NULL');
      if (scope.kind === 'collections') {
        where.push('EXISTS (SELECT 1 FROM library_collection_items ci WHERE ci.library_item_id = i.id AND ci.collection_id IN (SELECT value FROM json_each(@collections)))');
        params.collections = JSON.stringify(scope.collectionIds);
      }
    }
    if (extra.itemIds) {
      where.push('i.id IN (SELECT value FROM json_each(@extraItems))');
      params.extraItems = JSON.stringify(extra.itemIds);
    }
    if (filters.author) {
      where.push("w.authors_key LIKE @author ESCAPE '\\'");
      params.author = `%${filters.author.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    if (filters.yearFrom !== undefined) {
      where.push('w.year >= @yearFrom');
      params.yearFrom = filters.yearFrom;
    }
    if (filters.yearTo !== undefined) {
      where.push('w.year <= @yearTo');
      params.yearTo = filters.yearTo;
    }
    if (filters.venue) {
      where.push("lower(coalesce(json_extract(w.user_edits, '$.venue'), json_extract(w.work, '$.venue'), '')) LIKE @venue ESCAPE '\\'");
      params.venue = `%${filters.venue.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    if (filters.publicationTypes?.length) {
      where.push("coalesce(json_extract(w.user_edits, '$.publicationType'), json_extract(w.work, '$.publicationType')) IN (SELECT value FROM json_each(@types))");
      params.types = JSON.stringify(filters.publicationTypes);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT x.id FROM document_extractions x JOIN library_items i ON i.id = x.library_item_id JOIN scholarly_works w ON w.id = i.scholarly_work_id
         WHERE ${where.join(' AND ')}`,
      )
      .all(params) as { id: string }[];
    return rows.map((r) => r.id);
  }

  private semanticBackend(): SemanticBackend | null {
    const space = this.activeSpace();
    let provider: EmbeddingProvider | null;
    try {
      provider = this.embeddingProvider();
    } catch {
      provider = null;
    }
    if (!space || !provider) return null;
    // The query must be embedded by the model that built the index.
    const s = this.settings();
    if (s.embeddingModel !== space.model) return null;
    return { space, provider };
  }

  async search(input: z.infer<typeof ResearchSearchRequest>, signal: AbortSignal): Promise<ResearchSearch> {
    const parsed = parseQuery(input.query);
    const warnings: string[] = [];
    let itemRestriction: string[] | undefined;
    // An identifier restricts the search to the paper with that DOI or arXiv ID.
    if (parsed.doi || parsed.arxivId) {
      const items = this.sqlite
        .prepare('SELECT i.id FROM scholarly_works w JOIN library_items i ON i.scholarly_work_id = w.id WHERE (@doi IS NOT NULL AND w.doi = @doi) OR (@arxiv IS NOT NULL AND w.arxiv_id = @arxiv)')
        .all({ doi: parsed.doi, arxiv: parsed.arxivId }) as { id: string }[];
      itemRestriction = items.map((r) => r.id);
      if (!itemRestriction.length) warnings.push(`No paper in your library has ${parsed.doi ? `DOI ${parsed.doi}` : `arXiv ID ${parsed.arxivId}`}.`);
    }
    const extractionIds = this.resolveScope(input.scope, input.filters, itemRestriction ? { itemIds: itemRestriction } : {});
    const semantic = this.semanticBackend();
    const kinds = input.filters.includeReferences ? (['abstract', 'body', 'caption', 'formula', 'reference'] as const) : undefined;
    let response;
    if ((parsed.doi || parsed.arxivId) && !parsed.clauses.length) {
      // Identifier only: the paper's passages in reading order.
      const rows = extractionIds.length
        ? (this.sqlite
            .prepare(`SELECT id, extraction_id FROM document_passages WHERE extraction_id IN (SELECT value FROM json_each(?)) AND kind <> 'reference' ORDER BY extraction_id, passage_order LIMIT 500`)
            .all(JSON.stringify(extractionIds)) as { id: string; extraction_id: string }[])
        : [];
      const all = rows.map((r, i) => ({ passageId: r.id, extractionId: r.extraction_id, score: 0, keywordRank: i + 1, semanticRank: null, keywordScore: null, semanticScore: null, matchedBy: 'keyword' as const, position: i + 1 }));
      response = { parsed, mode: input.mode, results: all.slice(input.offset, input.offset + input.limit), total: all.length, relaxed: false, semantic: { used: false, space: semantic?.space ?? null, reason: null }, warnings: [] as string[] };
    } else {
      try {
        response = await this.engine.search(
          { query: input.query, mode: input.mode, filter: { extractionIds, ...(kinds ? { kinds } : {}), ...(input.filters.sectionTypes ? { sectionTypes: input.filters.sectionTypes } : {}) }, limit: input.limit, offset: input.offset },
          semantic,
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw new StudioError('BAD_REQUEST', 'The search was cancelled');
        throw err;
      }
    }
    if (input.mode !== 'keyword' && !semantic && !response.semantic.reason) warnings.push('No embedding index is active; semantic search is not available.');
    return {
      query: input.query,
      understood: { notes: response.parsed.notes, sections: response.parsed.sections, doi: response.parsed.doi, arxivId: response.parsed.arxivId },
      mode: input.mode,
      results: this.hydrate(response.results),
      total: response.total,
      offset: input.offset,
      limit: input.limit,
      relaxed: response.relaxed,
      semantic: { used: response.semantic.used, reason: response.semantic.reason, model: semantic?.space.model ?? null },
      warnings: [...new Set([...warnings, ...response.warnings])],
      papersSearched: new Set(extractionIds).size,
    };
  }

  /** Passages close to a given passage in the active embedding space. */
  async similar(input: z.infer<typeof SimilarPassagesRequest>): Promise<ResearchSearch> {
    const p = this.store.passage(input.passageId);
    if (!p) throw notFound('Passage not found');
    const semantic = this.semanticBackend();
    if (!semantic) throw new StudioError('NOT_CONFIGURED', 'Similar passages need an active embedding index');
    const row = this.sqlite
      .prepare('SELECT v.vector FROM passage_embeddings pe JOIN embedding_vectors v ON v.space_id = pe.space_id AND v.text_hash = pe.text_hash WHERE pe.space_id = ? AND pe.passage_id = ?')
      .get(semantic.space.id, p.id) as { vector: Buffer } | undefined;
    if (!row) throw new StudioError('NOT_FOUND', 'This passage has no vector in the active embedding index yet');
    const vector = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
    const extractionIds = this.resolveScope(input.scope, {});
    const hits = this.vectors
      .search(semantic.space.id, vector, { extractionIds, kinds: ['abstract', 'body', 'caption', 'formula'], sectionTypes: [] }, input.limit + 1)
      .filter((h) => h.passageId !== p.id)
      .slice(0, input.limit)
      .map((h, i) => ({ passageId: h.passageId, extractionId: h.extractionId, score: h.score, keywordRank: null, semanticRank: i + 1, keywordScore: null, semanticScore: h.score, matchedBy: 'semantic' as const, position: i + 1 }));
    return {
      query: p.text.slice(0, 200),
      understood: { notes: ['Passages similar to the selected passage'], sections: [], doi: null, arxivId: null },
      mode: 'semantic',
      results: this.hydrate(hits),
      total: hits.length,
      offset: 0,
      limit: input.limit,
      relaxed: false,
      semantic: { used: true, reason: null, model: semantic.space.model },
      warnings: [],
      papersSearched: extractionIds.length,
    };
  }

  private papers(itemIds: string[]) {
    const out = new Map<string, SearchResult['paper'] & { license: string | null }>();
    for (const { item, work } of this.library.repo.withWorks(itemIds)) {
      const w = applyEdits(work.work, work.userEdits);
      out.set(item.id, {
        libraryItemId: item.id,
        title: w.title,
        authors: w.authors.map((a) => a.name),
        year: w.publicationYear,
        venue: w.venue,
        doi: w.identifiers.doi,
        arxivId: w.identifiers.arxivId,
        publicationType: w.publicationType,
        license: w.openAccess.license,
      });
    }
    return out;
  }

  private provenance(x: ExtractionRow, license: string | null) {
    const a = this.library.repo.getAttachment(x.attachmentId);
    return {
      attachmentId: x.attachmentId,
      sourceSha256: x.sourceSha256,
      extractionId: x.id,
      extractor: x.extractor,
      extractorVersion: x.extractorVersion,
      parserVersion: x.parserVersion,
      configHash: x.configHash,
      extractedAt: x.processingCompletedAt ?? x.processingStartedAt,
      attachmentSource: a?.source ?? 'upload',
      attachmentSourceUrl: a?.sourceUrl ?? null,
      attachmentAddedAt: a?.createdAt ?? x.createdAt,
      license,
    };
  }

  private hydrate(hits: { passageId: string; extractionId: string; position: number; score: number; keywordRank: number | null; semanticRank: number | null; keywordScore: number | null; semanticScore: number | null; matchedBy: 'keyword' | 'semantic' | 'hybrid' }[]): SearchResult[] {
    const passages = new Map(this.store.passagesByIds(hits.map((h) => h.passageId)).map((p) => [p.id, p]));
    const extractions = new Map<string, ExtractionRow>();
    for (const h of hits) if (!extractions.has(h.extractionId)) extractions.set(h.extractionId, this.store.getExtraction(h.extractionId)!);
    const papers = this.papers([...new Set([...extractions.values()].filter(Boolean).map((x) => x.libraryItemId))]);
    const out: SearchResult[] = [];
    for (const h of hits) {
      const p = passages.get(h.passageId);
      const x = extractions.get(h.extractionId);
      const paper = x ? papers.get(x.libraryItemId) : undefined;
      if (!p || !x || !paper) continue;
      const { license, ...paperRef } = paper;
      out.push({
        ...h,
        documentId: x.id,
        attachmentId: x.attachmentId,
        kind: p.kind,
        sectionPath: p.sectionPath,
        sectionType: p.sectionType,
        pageStart: p.pageStart,
        pageEnd: p.pageEnd,
        hasCoordinates: p.coordinates.length > 0,
        text: p.text,
        paper: paperRef,
        provenance: this.provenance(x, license),
      });
    }
    return out;
  }

  passageDetail(passageId: string): PassageDetail {
    const p = this.store.passage(passageId);
    if (!p) throw notFound('Passage not found');
    const x = this.store.getExtraction(p.extractionId)!;
    const paper = this.papers([x.libraryItemId]).get(x.libraryItemId);
    if (!paper) throw notFound('Passage not found');
    const around = this.store.neighbours(p, 1, 1);
    const { license, ...paperRef } = paper;
    return {
      passage: toPassage(p),
      paper: paperRef,
      provenance: this.provenance(x, license),
      before: around.filter((n) => n.passageOrder < p.passageOrder).map(toPassage),
      after: around.filter((n) => n.passageOrder > p.passageOrder).map(toPassage),
      sentences: this.store.sentencesOf(p.id).map((s) => ({ id: s.id, order: s.sentenceOrder, text: s.text, pageStart: s.pageStart, pageEnd: s.pageEnd, coordinates: s.coordinates })),
    };
  }

  passageLocation(passageId: string): PassageLocation {
    const p = this.store.passage(passageId);
    if (!p) throw notFound('Passage not found');
    const x = this.store.getExtraction(p.extractionId)!;
    const pages = new Set(p.coordinates.map((c) => c.pageNumber));
    if (p.pageStart) pages.add(p.pageStart);
    return {
      passageId,
      attachmentId: x.attachmentId,
      pageNumber: p.pageStart ?? p.coordinates[0]?.pageNumber ?? null,
      pageEnd: p.pageEnd,
      coordinates: p.coordinates,
      pages: (x.pages as PageGeometry[]).filter((g) => pages.has(g.pageNumber)),
    };
  }
}
