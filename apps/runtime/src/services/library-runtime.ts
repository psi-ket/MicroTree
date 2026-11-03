import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type {
  AddLibraryItemRequest,
  IdentifierImportRequest,
  ReferenceImportRequest,
  ZoteroImportRequest,
} from '@research-studio/api-contracts';
import { LibraryPreferencesSchema } from '@research-studio/api-contracts';
import type { SecretStore } from '@research-studio/ai-storage';
import type { Repositories, StudioDb } from '@research-studio/database';
import { titleKey } from '@research-studio/literature-engine';
import {
  AttachmentService,
  AttachmentStorage,
  CollectionRepository,
  CollectionService,
  ImportJobRunner,
  LibraryError,
  LibraryRepository,
  LibraryService,
  ProjectLibraryService,
  ZoteroClient,
  emptyReference,
  fetchOpenAccessPdf,
  importPdf,
  openAccessPdfUrls,
  parseIdentifierList,
  parseReferences,
  previewZoteroExport,
  previewZoteroImport,
  resolveZoteroConflict,
  runIdentifierImport,
  runReferenceImport,
  runZoteroExport,
  runZoteroImport,
  type AddOptions,
  type JobContext,
  type LibraryChange,
  type ProjectFilesPort,
  type ReceiveMeta,
  type ReferenceSettingsPort,
  type ScholarlyLookup,
  type StorageReport,
  type TempFile,
  type ZoteroContext,
} from '@research-studio/research-library';
import {
  DEFAULT_LIBRARY_PREFERENCES,
  StudioError,
  type FileTreeNode,
  type ImportJob,
  type LibraryPreferences,
  type ProjectReferenceSettings,
  type ScholarlyWork,
  type ZoteroMode,
  type ZoteroStatus,
} from '@research-studio/shared-types';
import type { RuntimeConfig } from '../config';
import type { EventBus } from '../events';
import type { AuditService } from './audit-service';
import type { LiteratureService } from './literature-service';
import type { Actor, ProjectService } from './project-service';

const PREFS_SCOPE = 'library';
const ZOTERO_SCOPE = 'library.zotero';
const ZOTERO_SECRET = 'zotero:web';
const HOUR = 60 * 60 * 1000;
const USER_AGENT = 'ResearchStudio/0.1 (local research library)';

export interface LibraryRuntimeOptions {
  /** Test seam: the HTTP client used for the Zotero web API. */
  zoteroFetch?: typeof fetch;
  /** Test seam: lets the open-access fetcher reach a local test server over http. */
  allowLoopbackPdfFetch?: boolean;
}

/** A file received from the browser, waiting in temporary storage for its import job. */
export interface ReceivedUpload {
  temp: TempFile;
  meta: ReceiveMeta;
}

interface ZoteroState {
  userId?: string | null;
  username?: string | null;
  canWrite?: boolean | null;
  lastError?: string | null;
  localEnabled?: boolean;
  localError?: string | null;
}

const never = new AbortController().signal;

function walkFiles(node: FileTreeNode, out: string[] = []): string[] {
  if (node.type === 'file') out.push(node.path);
  for (const child of node.children ?? []) walkFiles(child, out);
  return out;
}

/**
 * The research library inside the runtime: storage under the data directory,
 * the M3.1 literature engine as the only metadata source, events and audit.
 */
export class LibraryRuntime {
  readonly storage: AttachmentStorage;
  readonly repo: LibraryRepository;
  readonly attachments: AttachmentService;
  readonly library: LibraryService;
  readonly collections: CollectionService;
  readonly jobs: ImportJobRunner;
  private sweepTimer: NodeJS.Timeout | null = null;

  get maxPdfBytes(): number {
    return this.config.library.maxPdfBytes;
  }

  constructor(
    db: StudioDb,
    private readonly repos: Repositories,
    private readonly secrets: SecretStore,
    private readonly projects: ProjectService,
    private readonly literature: LiteratureService,
    private readonly config: RuntimeConfig,
    readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly options: LibraryRuntimeOptions = {},
  ) {
    this.storage = new AttachmentStorage(config.library.storageDir);
    this.repo = new LibraryRepository(db, titleKey);
    this.attachments = new AttachmentService(this.storage, this.repo, { maxBytes: config.library.maxPdfBytes });
    const collectionRepo = new CollectionRepository(db);
    const onChange = (change: LibraryChange) => this.events.publish({ type: 'library.changed', kind: change.kind, ids: change.ids });
    this.library = new LibraryService({
      repo: this.repo,
      collections: collectionRepo,
      attachments: this.attachments,
      lookup: config.literature.enabled ? this.lookup() : null,
      preferences: () => this.preferences(),
      onChange,
    });
    this.collections = new CollectionService(collectionRepo, this.repo, undefined, onChange);
    this.jobs = new ImportJobRunner(this.repo, (job) => this.events.publish({ type: 'library.job', job }));
  }

  /** Startup recovery: jobs the last process left unfinished, temporary files and unreferenced objects. */
  async start(): Promise<void> {
    await this.storage.init();
    const interrupted = this.jobs.recoverInterrupted();
    const report = await this.attachments.sweep(0);
    if (interrupted || report.tmpRemoved || report.orphansRemoved || report.strays.length || report.missing.length) {
      this.log.info(
        { interrupted, tmpRemoved: report.tmpRemoved, orphansRemoved: report.orphansRemoved, strays: report.strays.length, missing: report.missing.length },
        'library storage recovered',
      );
    }
    this.sweepTimer = setInterval(() => {
      // Uploads in progress are younger than an hour.
      this.attachments.sweep(HOUR).catch((err: unknown) => this.log.warn({ err }, 'library storage sweep failed'));
    }, HOUR);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.jobs.stopAll();
  }

  /** The M3.1 engine, seen through the narrow port the library uses. Library lookups stay out of search history. */
  private lookup(): ScholarlyLookup {
    const lit = this.literature;
    return {
      resolveDoi: (doi, signal) => lit.resolveDoi(doi, signal ?? never),
      resolveArxiv: (id, signal) => lit.resolveArxiv(id, signal ?? never),
      search: async (query, { mode, limit, author }, signal) => {
        const result = await lit.search(
          { query, mode, limit, ...(author ? { filters: { authors: [author] } } : {}) },
          signal ?? never,
          { saveHistory: false },
        );
        return { works: result.results.map((r) => r.work), providerStatus: result.providerStatus };
      },
      work: async (id, signal) => (await lit.work(id, signal ?? never)).work,
    };
  }

  // --------------------------------------------------------- preferences

  preferences(): LibraryPreferences {
    const stored = LibraryPreferencesSchema.partial().safeParse(this.repos.settings.getAll(PREFS_SCOPE));
    return { ...DEFAULT_LIBRARY_PREFERENCES, ...(stored.success ? stored.data : {}) };
  }

  updatePreferences(patch: Partial<LibraryPreferences>): LibraryPreferences {
    this.repos.settings.setMany(PREFS_SCOPE, patch);
    return this.preferences();
  }

  // ----------------------------------------------------------- projects

  /** Project references for one request; writes are audited as `actor`. */
  projectReferences(actor: Actor): ProjectLibraryService {
    const projects = this.projects;
    const files: ProjectFilesPort = {
      listFiles: async (projectId) => walkFiles(await projects.tree(projectId)),
      read: async (projectId, path) => {
        try {
          const file = await projects.readFile(projectId, path);
          return { content: file.content, hash: file.hash };
        } catch (err) {
          if (err instanceof StudioError && err.code === 'NOT_FOUND' && (err.details as { path?: string } | undefined)?.path !== undefined) return null;
          throw err;
        }
      },
      write: async (projectId, path, content, baseHash) => {
        await projects.writeFile(projectId, { path, content, baseHash, createOnly: baseHash === null }, actor);
      },
    };
    const settings: ReferenceSettingsPort = {
      get: (projectId) => (this.repos.settings.get(`project:${projectId}`, 'references') as Partial<ProjectReferenceSettings> | undefined) ?? null,
      set: (projectId, value) => this.repos.settings.setMany(`project:${projectId}`, { references: value }),
    };
    return new ProjectLibraryService(this.library, files, settings);
  }

  // --------------------------------------------------------------- adding

  async add(input: z.infer<typeof AddLibraryItemRequest>, signal: AbortSignal) {
    const opts: AddOptions = input.options ?? {};
    let result;
    if (input.source === 'work') {
      // The runtime fetches the record itself: the browser names a work, it does not supply its metadata.
      const work = await this.library.lookup.work(input.workId, signal);
      result = await this.library.addWork(work, opts);
    } else if (input.source === 'identifier') {
      result = await this.library.addByIdentifier(input.kind, input.value, opts, signal);
    } else {
      const { bibtexType, ...fields } = input.reference;
      const ref = { ...emptyReference('manual'), ...fields, bibtexType: bibtexType ?? null, localSource: { format: 'manual' } };
      result = await this.library.addReference(ref, null, opts);
    }
    const wantPdf = input.source !== 'manual' && (input.fetchOpenAccessPdf ?? this.preferences().fetchOpenAccessPdf);
    const job = wantPdf && result.item.attachments.length === 0 ? this.startOpenAccessFetch(result.item.id, result.item.work) : null;
    return { ...result, job };
  }

  /** Download the paper's listed open-access PDF in the background. Null when the record lists none. */
  startOpenAccessFetch(itemId: string, work: ScholarlyWork): ImportJob | null {
    const urls = openAccessPdfUrls(work);
    if (!urls.length) return null;
    return this.jobs.start('pdf', 1, async (ctx) => {
      const problems: string[] = [];
      for (const url of urls) {
        try {
          const fetched = await fetchOpenAccessPdf(url, {
            maxBytes: this.config.library.maxPdfBytes,
            userAgent: USER_AGENT,
            signal: ctx.signal,
            ...(this.options.allowLoopbackPdfFetch ? { allowLoopbackHttp: true } : {}),
          });
          const meta: ReceiveMeta = { originalFileName: fetched.suggestedName, declaredType: fetched.contentType, attachmentType: 'pdf' };
          const file = await this.attachments.validate(await this.attachments.receiveRaw(fetched.body, meta, ctx.signal), meta, ctx.signal);
          const result = await importPdf(this.library, file, { targetItemId: itemId, source: 'open-access', sourceUrl: fetched.url, signal: ctx.signal });
          ctx.record({ label: result.label, outcome: result.outcome, libraryItemId: itemId, confidence: null, message: null });
          return;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          problems.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      ctx.record({ label: 'Open-access PDF', outcome: 'failed', libraryItemId: itemId, confidence: null, message: problems.join('; ') });
    });
  }

  fetchPdfFor(itemId: string, item: { work: ScholarlyWork }): ImportJob {
    const job = this.startOpenAccessFetch(itemId, item.work);
    if (!job) throw new LibraryError('NOT_FOUND', 'The record lists no open-access PDF for this paper');
    return job;
  }

  // -------------------------------------------------------------- imports

  /** Import uploaded PDFs (already in temporary storage) as one job. */
  importUploads(uploads: ReceivedUpload[], options: { targetItemId?: string | null; add?: AddOptions }, actor: Actor): ImportJob {
    this.audit.record({ action: 'library.import', outcome: 'success', actor: actor.sessionId, details: { kind: 'pdf', files: uploads.length } });
    const job = this.jobs.start('pdf', uploads.length, async (ctx) => {
      for (const { temp, meta } of uploads) {
        if (ctx.signal.aborted) return;
        try {
          const file = await this.attachments.validate(temp, meta, ctx.signal);
          const r = await importPdf(this.library, file, {
            targetItemId: options.targetItemId ?? null,
            ...(options.add ? { add: options.add } : {}),
            signal: ctx.signal,
          });
          ctx.record({ label: r.label, outcome: r.outcome, libraryItemId: r.libraryItemId, confidence: r.confidence, message: r.message });
        } catch (err) {
          if (ctx.signal.aborted) return;
          ctx.record({ label: meta.originalFileName, outcome: 'failed', libraryItemId: null, confidence: null, message: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    // However the job ends (even cancelled while queued), no upload stays in temporary
    // storage. Committed files were moved away, so removing their temporary path is a no-op.
    void this.jobs.wait(job.id).then(() => Promise.all(uploads.map((u) => this.storage.discard(u.temp).catch(() => {}))));
    return job;
  }

  /** Remove received uploads that will not be imported (a later part of the request failed). */
  async discardUploads(uploads: ReceivedUpload[]): Promise<void> {
    await Promise.all(uploads.map((u) => this.storage.discard(u.temp).catch(() => {})));
  }

  importReferences(input: z.infer<typeof ReferenceImportRequest>, actor: Actor): ImportJob {
    const parsed = parseReferences(input.format, input.text);
    if (!parsed.references.length) throw new LibraryError('VALIDATION_FAILED', `No ${input.format === 'bibtex' ? 'BibTeX' : 'RIS'} entries were found`);
    const total = input.only?.length ?? parsed.references.length;
    this.audit.record({ action: 'library.import', outcome: 'success', actor: actor.sessionId, details: { kind: input.format, entries: total } });
    return this.jobs.start(
      input.format,
      total,
      (ctx) =>
        runReferenceImport(
          this.library,
          parsed.references,
          {
            ...(input.only ? { only: input.only } : {}),
            resolveIdentifiers: input.resolveIdentifiers && this.library.hasLookup,
            searchTitles: input.searchTitles && this.library.hasLookup,
            ...(input.options ? { add: input.options } : {}),
          },
          ctx,
        ),
      parsed.warnings.map((w) => w.message),
    );
  }

  importIdentifiers(input: z.infer<typeof IdentifierImportRequest>, actor: Actor): ImportJob {
    const ids = parseIdentifierList(input.text);
    if (!ids.length) throw new LibraryError('VALIDATION_FAILED', 'No DOIs or arXiv identifiers were found');
    if (!this.library.hasLookup) throw new LibraryError('NOT_CONFIGURED', 'Literature search is turned off; identifiers cannot be looked up');
    this.audit.record({ action: 'library.import', outcome: 'success', actor: actor.sessionId, details: { kind: 'identifiers', entries: ids.length } });
    return this.jobs.start('identifiers', ids.length, (ctx: JobContext) => runIdentifierImport(this.library, ids, input.options, ctx));
  }

  // -------------------------------------------------------------- storage

  async sweepStorage(actor: Actor): Promise<{ tmpRemoved: number; orphansRemoved: number; strays: number; missingFiles: number }> {
    const report: StorageReport = await this.attachments.sweep(HOUR);
    this.audit.record({
      action: 'library.storage.sweep',
      outcome: 'success',
      actor: actor.sessionId,
      details: { tmpRemoved: report.tmpRemoved, orphansRemoved: report.orphansRemoved, strays: report.strays.length, missing: report.missing.length },
    });
    return { tmpRemoved: report.tmpRemoved, orphansRemoved: report.orphansRemoved, strays: report.strays.length, missingFiles: report.missing.length };
  }

  // --------------------------------------------------------------- Zotero

  private zoteroState(): ZoteroState {
    return (this.repos.settings.get(ZOTERO_SCOPE, 'state') as ZoteroState | undefined) ?? {};
  }

  private saveZoteroState(patch: ZoteroState): void {
    this.repos.settings.setMany(ZOTERO_SCOPE, { state: { ...this.zoteroState(), ...patch } });
  }

  private webClient(apiKey: string): ZoteroClient {
    return new ZoteroClient({ mode: 'web', baseUrl: this.config.library.zoteroUrl, apiKey, userAgent: USER_AGENT, ...(this.options.zoteroFetch ? { fetch: this.options.zoteroFetch } : {}) });
  }

  async zoteroStatus(probeLocal = false): Promise<ZoteroStatus> {
    const state = this.zoteroState();
    const configured = (await this.secrets.get(ZOTERO_SECRET)) !== null;
    let reachable: boolean | null = null;
    let localError = state.localError ?? null;
    if (probeLocal && state.localEnabled) {
      try {
        await new ZoteroClient({ mode: 'local', baseUrl: this.config.library.zoteroLocalUrl, timeoutMs: 3000 }).ping();
        reachable = true;
        localError = null;
      } catch (err) {
        reachable = false;
        localError = err instanceof Error ? err.message : String(err);
      }
    }
    const { linked, conflicts } = this.repo.countLinks('zotero');
    return {
      web: {
        configured,
        userId: configured ? (state.userId ?? null) : null,
        username: configured ? (state.username ?? null) : null,
        canWrite: configured ? (state.canWrite ?? null) : null,
        lastError: configured ? (state.lastError ?? null) : null,
      },
      local: { enabled: state.localEnabled ?? false, reachable, lastError: localError },
      linkedItems: linked,
      conflicts,
    };
  }

  /** Check a key against Zotero and keep it in the runtime's secret store. It is never sent back. */
  async setZoteroKey(apiKey: string, actor: Actor): Promise<ZoteroStatus> {
    const info = await this.webClient(apiKey).keyInfo();
    if (!info.canRead) throw new LibraryError('FORBIDDEN', 'This key cannot read your Zotero library');
    await this.secrets.set(ZOTERO_SECRET, apiKey);
    this.saveZoteroState({ userId: info.userId, username: info.username, canWrite: info.canWrite, lastError: null });
    this.audit.record({ action: 'library.zotero.key', outcome: 'success', actor: actor.sessionId, details: { stored: true, canWrite: info.canWrite } });
    return this.zoteroStatus();
  }

  async deleteZoteroKey(actor: Actor): Promise<ZoteroStatus> {
    await this.secrets.delete(ZOTERO_SECRET);
    this.saveZoteroState({ userId: null, username: null, canWrite: null, lastError: null });
    this.audit.record({ action: 'library.zotero.key', outcome: 'success', actor: actor.sessionId, details: { stored: false } });
    return this.zoteroStatus();
  }

  setZoteroLocal(enabled: boolean): Promise<ZoteroStatus> {
    this.saveZoteroState({ localEnabled: enabled, localError: null });
    return this.zoteroStatus(enabled);
  }

  private async zoteroContext(mode: ZoteroMode): Promise<ZoteroContext> {
    if (mode === 'local') {
      if (!this.zoteroState().localEnabled) throw new LibraryError('NOT_CONFIGURED', 'Turn on the Zotero desktop connection first');
      const client = new ZoteroClient({ mode: 'local', baseUrl: this.config.library.zoteroLocalUrl, userAgent: USER_AGENT });
      return { library: this.library, collections: this.collections, client, userId: '0', libraryId: 'local' };
    }
    const key = await this.secrets.get(ZOTERO_SECRET);
    if (!key) throw new LibraryError('NOT_CONFIGURED', 'Add a Zotero API key first');
    let userId = this.zoteroState().userId;
    const client = this.webClient(key);
    if (!userId) {
      userId = (await client.keyInfo()).userId;
      this.saveZoteroState({ userId });
    }
    return { library: this.library, collections: this.collections, client, userId, libraryId: `users/${userId}` };
  }

  /** Remember the last Zotero failure for the status panel, then rethrow. */
  private async zoteroCall<T>(mode: ZoteroMode, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.saveZoteroState(mode === 'web' ? { lastError: null } : { localError: null });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.saveZoteroState(mode === 'web' ? { lastError: message } : { localError: message });
      throw err;
    }
  }

  async previewZoteroImport(mode: ZoteroMode, collectionKey: string | undefined, signal: AbortSignal) {
    const ctx = await this.zoteroContext(mode);
    return this.zoteroCall(mode, () => previewZoteroImport(ctx, collectionKey ? { collectionKey } : {}, signal));
  }

  async importZotero(input: z.infer<typeof ZoteroImportRequest>, actor: Actor): Promise<ImportJob> {
    const ctx = await this.zoteroContext(input.mode);
    this.audit.record({ action: 'library.import', outcome: 'success', actor: actor.sessionId, details: { kind: `zotero-${input.mode}`, items: input.itemKeys?.length ?? 'all' } });
    return this.jobs.start('zotero', input.itemKeys?.length ?? 0, (job) =>
      this.zoteroCall(input.mode, () =>
        runZoteroImport(
          ctx,
          {
            ...(input.collectionKey ? { collectionKey: input.collectionKey } : {}),
            ...(input.itemKeys ? { itemKeys: input.itemKeys } : {}),
            importCollections: input.importCollections,
            importPdfs: input.importPdfs,
            resolveIdentifiers: input.resolveIdentifiers && this.library.hasLookup,
          },
          job,
        ),
      ),
    );
  }

  async previewZoteroExport(itemIds: string[], signal: AbortSignal) {
    const ctx = await this.zoteroContext('web');
    return this.zoteroCall('web', () => previewZoteroExport(ctx, itemIds, signal));
  }

  async exportZotero(itemIds: string[], actor: Actor): Promise<ImportJob> {
    const ctx = await this.zoteroContext('web');
    this.audit.record({ action: 'library.zotero.export', outcome: 'success', actor: actor.sessionId, details: { items: itemIds.length } });
    return this.jobs.start('zotero', itemIds.length, (job) => this.zoteroCall('web', () => runZoteroExport(ctx, itemIds, job)));
  }

  async resolveZoteroConflict(itemId: string, keep: 'local' | 'remote', signal: AbortSignal) {
    const link = this.repo.linksForItems([itemId]).find((l) => l.provider === 'zotero' && l.syncStatus === 'conflict');
    if (!link) throw new LibraryError('NOT_FOUND', 'This paper has no Zotero conflict');
    const ctx = await this.zoteroContext(link.externalLibraryId === 'local' ? 'local' : 'web');
    await resolveZoteroConflict(ctx, itemId, keep, signal);
    return this.library.getItem(itemId);
  }
}
