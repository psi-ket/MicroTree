import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type {
  AuditEvent,
  AuditOutcome,
  CompileJob,
  CompileStatus,
  FileKind,
  LatexEngine,
  LiteratureProviderId,
  LiteratureSearchHistoryEntry,
  Project,
} from '@research-studio/shared-types';
import type { StudioDb } from './client';
import {
  auditEvents,
  compilationJobs,
  literatureCache,
  literatureProviderState,
  literatureSearchHistory,
  projectFiles,
  projects,
  settings,
} from './schema';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- projects

type ProjectRow = typeof projects.$inferSelect;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    rootPath: row.rootPath,
    mainFile: row.mainFile,
    engine: row.engine,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
  };
}

export class ProjectRepository {
  constructor(private readonly db: StudioDb) {}

  create(input: { id: string; name: string; slug: string; rootPath: string; mainFile: string; engine: LatexEngine }): Project {
    const ts = now();
    const row = this.db
      .insert(projects)
      .values({ ...input, createdAt: ts, updatedAt: ts, lastOpenedAt: null })
      .returning()
      .get();
    return toProject(row);
  }

  get(id: string): Project | null {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? toProject(row) : null;
  }

  slugExists(slug: string): boolean {
    return this.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get() !== undefined;
  }

  list(): Project[] {
    return this.db
      .select()
      .from(projects)
      .orderBy(desc(projects.lastOpenedAt), desc(projects.updatedAt))
      .all()
      .map(toProject);
  }

  update(id: string, patch: Partial<Pick<Project, 'name' | 'mainFile' | 'engine'>>): Project | null {
    const row = this.db
      .update(projects)
      .set({ ...patch, updatedAt: now() })
      .where(eq(projects.id, id))
      .returning()
      .get();
    return row ? toProject(row) : null;
  }

  touch(id: string, opened = false): void {
    const ts = now();
    this.db
      .update(projects)
      .set(opened ? { updatedAt: ts, lastOpenedAt: ts } : { updatedAt: ts })
      .where(eq(projects.id, id))
      .run();
  }

  delete(id: string): boolean {
    return this.db.delete(projects).where(eq(projects.id, id)).run().changes > 0;
  }
}

// ---------------------------------------------------------------- project files

export interface FileIndexEntry {
  path: string;
  kind: FileKind;
  size: number;
  sha256: string | null;
  modifiedAt: string;
}

export class ProjectFileRepository {
  constructor(private readonly db: StudioDb) {}

  list(projectId: string): FileIndexEntry[] {
    return this.db
      .select({
        path: projectFiles.path,
        kind: projectFiles.kind,
        size: projectFiles.size,
        sha256: projectFiles.sha256,
        modifiedAt: projectFiles.modifiedAt,
      })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId))
      .orderBy(projectFiles.path)
      .all();
  }

  /** Replace the full index for a project (after a tree scan), atomically. */
  replaceAll(projectId: string, entries: FileIndexEntry[]): void {
    const ts = now();
    this.db.transaction((tx) => {
      tx.delete(projectFiles).where(eq(projectFiles.projectId, projectId)).run();
      for (const e of entries) {
        tx.insert(projectFiles).values({ projectId, ...e, indexedAt: ts }).run();
      }
    });
  }

  upsert(projectId: string, entry: FileIndexEntry): void {
    const ts = now();
    this.db
      .insert(projectFiles)
      .values({ projectId, ...entry, indexedAt: ts })
      .onConflictDoUpdate({
        target: [projectFiles.projectId, projectFiles.path],
        set: { kind: entry.kind, size: entry.size, sha256: entry.sha256, modifiedAt: entry.modifiedAt, indexedAt: ts },
      })
      .run();
  }

  /** Remove a file or every file below a directory path. */
  removePath(projectId: string, path: string): void {
    // GLOB is case-sensitive like project paths; bracket-escape its metacharacters.
    const pattern = `${path.replace(/[*?[]/g, (c) => `[${c}]`)}/*`;
    this.db
      .delete(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, projectId),
          or(eq(projectFiles.path, path), sql`${projectFiles.path} GLOB ${pattern}`),
        ),
      )
      .run();
  }
}

// ---------------------------------------------------------------- settings

export class SettingsRepository {
  constructor(private readonly db: StudioDb) {}

  getAll(scope: string): Record<string, unknown> {
    const rows = this.db.select().from(settings).where(eq(settings.scope, scope)).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  get(scope: string, key: string): unknown {
    return this.db
      .select()
      .from(settings)
      .where(and(eq(settings.scope, scope), eq(settings.key, key)))
      .get()?.value;
  }

  setMany(scope: string, values: Record<string, unknown>): void {
    const ts = now();
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(values)) {
        tx.insert(settings)
          .values({ scope, key, value, updatedAt: ts })
          .onConflictDoUpdate({ target: [settings.scope, settings.key], set: { value, updatedAt: ts } })
          .run();
      }
    });
  }

  deleteScope(scope: string): void {
    this.db.delete(settings).where(eq(settings.scope, scope)).run();
  }
}

// ---------------------------------------------------------------- compilation jobs

type JobRow = typeof compilationJobs.$inferSelect;

function toJob(row: JobRow): CompileJob {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    engine: row.engine,
    mainFile: row.mainFile,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    exitCode: row.exitCode,
    pdfAvailable: row.pdfAvailable,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    diagnostics: row.diagnostics,
    statusMessage: row.statusMessage,
  };
}

export type JobPatch = Partial<Omit<CompileJob, 'id' | 'projectId' | 'createdAt'>> & { outputTail?: string | null };

export class CompileJobRepository {
  constructor(private readonly db: StudioDb) {}

  create(input: { id: string; projectId: string; engine: LatexEngine; mainFile: string }): CompileJob {
    const row = this.db
      .insert(compilationJobs)
      .values({ ...input, status: 'queued', createdAt: now() })
      .returning()
      .get();
    return toJob(row);
  }

  get(id: string): CompileJob | null {
    const row = this.db.select().from(compilationJobs).where(eq(compilationJobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  outputTail(id: string): string | null {
    return (
      this.db
        .select({ outputTail: compilationJobs.outputTail })
        .from(compilationJobs)
        .where(eq(compilationJobs.id, id))
        .get()?.outputTail ?? null
    );
  }

  update(id: string, patch: JobPatch): CompileJob | null {
    const row = this.db.update(compilationJobs).set(patch).where(eq(compilationJobs.id, id)).returning().get();
    return row ? toJob(row) : null;
  }

  listByProject(projectId: string, limit = 20): CompileJob[] {
    return this.db
      .select()
      .from(compilationJobs)
      .where(eq(compilationJobs.projectId, projectId))
      .orderBy(desc(compilationJobs.createdAt))
      .limit(limit)
      .all()
      .map(toJob);
  }

  latest(projectId: string): CompileJob | null {
    return this.listByProject(projectId, 1)[0] ?? null;
  }

  /** Jobs left queued/running by a previous process are marked as errors at startup. */
  failInterrupted(message: string): number {
    const active: CompileStatus[] = ['queued', 'running'];
    return this.db
      .update(compilationJobs)
      .set({ status: 'error', statusMessage: message, finishedAt: now() })
      .where(inArray(compilationJobs.status, active))
      .run().changes;
  }
}

// ---------------------------------------------------------------- audit

export interface AuditInput {
  action: string;
  outcome: AuditOutcome;
  actor?: string | null;
  projectId?: string | null;
  target?: string | null;
  details?: Record<string, unknown> | null;
}

export class AuditRepository {
  constructor(private readonly db: StudioDb) {}

  append(event: AuditInput): void {
    this.db
      .insert(auditEvents)
      .values({
        at: now(),
        action: event.action,
        outcome: event.outcome,
        actor: event.actor ?? null,
        projectId: event.projectId ?? null,
        target: event.target ?? null,
        details: event.details ?? null,
      })
      .run();
  }

  list(options: { limit?: number; projectId?: string } = {}): AuditEvent[] {
    const query = this.db.select().from(auditEvents);
    const rows = (options.projectId ? query.where(eq(auditEvents.projectId, options.projectId)) : query)
      .orderBy(desc(auditEvents.id))
      .limit(options.limit ?? 100)
      .all();
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      outcome: r.outcome,
      actor: r.actor,
      projectId: r.projectId,
      target: r.target,
      details: r.details ?? null,
    }));
  }
}

// ---------------------------------------------------------------- literature

export interface LiteratureCacheEntry {
  provider: LiteratureProviderId;
  kind: 'record' | 'search';
  value: unknown;
  retrievedAt: string;
  expiresAt: string;
}

export class LiteratureCacheRepository {
  constructor(
    private readonly db: StudioDb,
    private readonly maxRows = 5000,
  ) {}

  /** A live entry, or null when missing or expired. */
  get(key: string, at = now()): LiteratureCacheEntry | null {
    const row = this.db
      .select()
      .from(literatureCache)
      .where(and(eq(literatureCache.key, key), gt(literatureCache.expiresAt, at)))
      .get();
    return row ? { provider: row.provider, kind: row.kind, value: row.value, retrievedAt: row.retrievedAt, expiresAt: row.expiresAt } : null;
  }

  set(key: string, entry: LiteratureCacheEntry): void {
    const sizeBytes = Buffer.byteLength(JSON.stringify(entry.value));
    this.db.transaction((tx) => {
      tx.insert(literatureCache)
        .values({ key, ...entry, sizeBytes })
        .onConflictDoUpdate({ target: literatureCache.key, set: { ...entry, sizeBytes } })
        .run();
      const { count } = tx.select({ count: sql<number>`count(*)` }).from(literatureCache).get()!;
      if (count > this.maxRows) {
        // Drop the entries that expire soonest.
        const doomed = tx
          .select({ key: literatureCache.key })
          .from(literatureCache)
          .orderBy(asc(literatureCache.expiresAt))
          .limit(count - this.maxRows)
          .all()
          .map((r) => r.key);
        tx.delete(literatureCache).where(inArray(literatureCache.key, doomed)).run();
      }
    });
  }

  purgeExpired(at = now()): number {
    return this.db.delete(literatureCache).where(lte(literatureCache.expiresAt, at)).run().changes;
  }

  clear(provider?: LiteratureProviderId): number {
    const query = this.db.delete(literatureCache);
    return (provider ? query.where(eq(literatureCache.provider, provider)) : query).run().changes;
  }

  stats(): { entries: number; bytes: number } {
    const row = this.db.select({ entries: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${literatureCache.sizeBytes}), 0)` }).from(literatureCache).get();
    return { entries: row?.entries ?? 0, bytes: row?.bytes ?? 0 };
  }
}

export class LiteratureHistoryRepository {
  constructor(
    private readonly db: StudioDb,
    private readonly maxRows = 200,
  ) {}

  add(entry: Omit<LiteratureSearchHistoryEntry, 'id' | 'createdAt'>): LiteratureSearchHistoryEntry {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(literatureSearchHistory)
        .values({ ...entry, createdAt: now() })
        .returning()
        .get();
      tx.delete(literatureSearchHistory)
        .where(
          sql`${literatureSearchHistory.id} NOT IN (SELECT ${literatureSearchHistory.id} FROM ${literatureSearchHistory} ORDER BY ${literatureSearchHistory.id} DESC LIMIT ${this.maxRows})`,
        )
        .run();
      return row;
    });
  }

  list(limit = 50): LiteratureSearchHistoryEntry[] {
    return this.db.select().from(literatureSearchHistory).orderBy(desc(literatureSearchHistory.id)).limit(limit).all();
  }

  delete(id: number): boolean {
    return this.db.delete(literatureSearchHistory).where(eq(literatureSearchHistory.id, id)).run().changes > 0;
  }

  clear(): number {
    return this.db.delete(literatureSearchHistory).run().changes;
  }
}

export interface LiteratureProviderHealth {
  provider: LiteratureProviderId;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: string | null;
  lastError: string | null;
  rateLimit: Record<string, string> | null;
  updatedAt: string;
}

export class LiteratureProviderStateRepository {
  constructor(private readonly db: StudioDb) {}

  list(): LiteratureProviderHealth[] {
    return this.db
      .select()
      .from(literatureProviderState)
      .all()
      .map((r) => ({ ...r, rateLimit: r.rateLimit ?? null }));
  }

  /** Record one finished request. Rate-limit headers are kept from the latest response that had any. */
  record(provider: LiteratureProviderId, outcome: { ok: boolean; at: string; errorKind?: string | null; error?: string | null; rateLimit?: Record<string, string> | null }): void {
    const patch = outcome.ok
      ? { lastSuccessAt: outcome.at }
      : { lastErrorAt: outcome.at, lastErrorKind: outcome.errorKind ?? null, lastError: outcome.error ?? null };
    const rateLimit = outcome.rateLimit ? { rateLimit: outcome.rateLimit } : {};
    this.db
      .insert(literatureProviderState)
      .values({ provider, ...patch, ...rateLimit, updatedAt: outcome.at })
      .onConflictDoUpdate({ target: literatureProviderState.provider, set: { ...patch, ...rateLimit, updatedAt: outcome.at } })
      .run();
  }

  reset(provider: LiteratureProviderId): void {
    this.db.delete(literatureProviderState).where(eq(literatureProviderState.provider, provider)).run();
  }
}

export interface Repositories {
  projects: ProjectRepository;
  files: ProjectFileRepository;
  settings: SettingsRepository;
  jobs: CompileJobRepository;
  audit: AuditRepository;
  literatureCache: LiteratureCacheRepository;
  literatureHistory: LiteratureHistoryRepository;
  literatureProviders: LiteratureProviderStateRepository;
}

export function createRepositories(db: StudioDb): Repositories {
  return {
    projects: new ProjectRepository(db),
    files: new ProjectFileRepository(db),
    settings: new SettingsRepository(db),
    jobs: new CompileJobRepository(db),
    audit: new AuditRepository(db),
    literatureCache: new LiteratureCacheRepository(db),
    literatureHistory: new LiteratureHistoryRepository(db),
    literatureProviders: new LiteratureProviderStateRepository(db),
  };
}
