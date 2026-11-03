import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repositoriesModule from '../src';
import { createDatabase, createRepositories, type DatabaseHandle, type Repositories } from '../src';

let handle: DatabaseHandle;
let repos: Repositories;

beforeEach(() => {
  handle = createDatabase(':memory:');
  repos = createRepositories(handle.db);
});

afterEach(() => handle.close());

const newProject = (id = 'p1', slug = 'paper') =>
  repos.projects.create({ id, name: 'Paper', slug, rootPath: `/w/${slug}`, mainFile: 'main.tex', engine: 'pdflatex' });

describe('migrations', () => {
  it('creates every table', () => {
    const tables = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      '__drizzle_migrations',
      'audit_events',
      'compilation_jobs',
      'document_blocks',
      'document_elements',
      'document_extractions',
      'document_jobs',
      'document_passages',
      'document_raw_outputs',
      'document_references',
      'document_sections',
      'document_sentences',
      'embedding_spaces',
      'embedding_vectors',
      'library_attachments',
      'library_collection_items',
      'library_collections',
      'library_external_collections',
      'library_external_links',
      'library_import_jobs',
      'library_item_tags',
      'library_items',
      'library_project_links',
      'library_tags',
      'literature_cache',
      'literature_provider_state',
      'literature_search_history',
      'passage_embeddings',
      'passage_fts',
      'passage_fts_config',
      'passage_fts_content',
      'passage_fts_data',
      'passage_fts_docsize',
      'passage_fts_idx',
      'project_files',
      'projects',
      'scholarly_works',
      'settings',
      'visual_artifact_versions',
      'visual_artifacts',
      'visual_assets',
      'visual_insertions',
      'visual_tasks',
    ]);
  });

  it('is idempotent and persists to disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rs-db-'));
    const file = path.join(dir, 'studio.db');
    try {
      const first = createDatabase(file);
      createRepositories(first.db).projects.create({
        id: 'x',
        name: 'X',
        slug: 'x',
        rootPath: '/w/x',
        mainFile: 'main.tex',
        engine: 'xelatex',
      });
      first.close();
      const second = createDatabase(file);
      expect(createRepositories(second.db).projects.get('x')?.engine).toBe('xelatex');
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ProjectRepository', () => {
  it('creates, lists, updates and deletes', () => {
    const p = newProject();
    expect(repos.projects.get(p.id)).toEqual(p);
    expect(repos.projects.slugExists('paper')).toBe(true);
    newProject('p2', 'thesis');
    repos.projects.touch('p2', true);
    expect(repos.projects.list().map((x) => x.id)).toEqual(['p2', 'p1']);
    expect(repos.projects.update('p1', { mainFile: 'thesis.tex' })?.mainFile).toBe('thesis.tex');
    expect(repos.projects.delete('p1')).toBe(true);
    expect(repos.projects.get('p1')).toBeNull();
  });

  it('enforces unique slugs', () => {
    newProject();
    expect(() => newProject('p2', 'paper')).toThrow();
  });
});

describe('ProjectFileRepository', () => {
  it('indexes files and removes directory subtrees', () => {
    newProject();
    const e = (p: string) => ({ path: p, kind: 'tex' as const, size: 1, sha256: null, modifiedAt: 'x' });
    repos.files.replaceAll('p1', [e('main.tex'), e('a/b.tex'), e('a/c/d.tex'), e('ab.tex'), e('a_x/y.tex')]);
    repos.files.upsert('p1', { ...e('main.tex'), size: 42 });
    expect(repos.files.list('p1').find((f) => f.path === 'main.tex')?.size).toBe(42);
    repos.files.removePath('p1', 'a');
    expect(repos.files.list('p1').map((f) => f.path)).toEqual(['a_x/y.tex', 'ab.tex', 'main.tex']);
  });

  it('cascades on project delete', () => {
    newProject();
    repos.files.upsert('p1', { path: 'main.tex', kind: 'tex', size: 1, sha256: null, modifiedAt: 'x' });
    repos.projects.delete('p1');
    expect(repos.files.list('p1')).toEqual([]);
  });
});

describe('SettingsRepository', () => {
  it('stores JSON values per scope', () => {
    repos.settings.setMany('global', { theme: 'dark', autosave: false, nested: { a: [1, 2] } });
    repos.settings.setMany('global', { theme: 'light' });
    expect(repos.settings.getAll('global')).toEqual({ theme: 'light', autosave: false, nested: { a: [1, 2] } });
    expect(repos.settings.get('global', 'missing')).toBeUndefined();
    repos.settings.deleteScope('global');
    expect(repos.settings.getAll('global')).toEqual({});
  });
});

describe('CompileJobRepository', () => {
  it('tracks job lifecycle and recovers interrupted jobs', () => {
    newProject();
    const job = repos.jobs.create({ id: 'j1', projectId: 'p1', engine: 'pdflatex', mainFile: 'main.tex' });
    expect(job.status).toBe('queued');
    const diag = { severity: 'error' as const, source: 'latex' as const, message: 'x', file: 'main.tex', line: 1, context: null };
    repos.jobs.update('j1', { status: 'failed', diagnostics: [diag], errorCount: 1, outputTail: 'log' });
    expect(repos.jobs.get('j1')).toMatchObject({ status: 'failed', diagnostics: [diag], errorCount: 1 });
    expect(repos.jobs.outputTail('j1')).toBe('log');

    repos.jobs.create({ id: 'j2', projectId: 'p1', engine: 'pdflatex', mainFile: 'main.tex' });
    expect(repos.jobs.failInterrupted('restarted')).toBe(1);
    expect(repos.jobs.get('j2')?.status).toBe('error');
    expect(repos.jobs.listByProject('p1')).toHaveLength(2);
  });
});

describe('AuditRepository', () => {
  it('appends and lists newest first', () => {
    repos.audit.append({ action: 'auth.session', outcome: 'success' });
    repos.audit.append({ action: 'file.write', outcome: 'denied', projectId: 'p1', details: { reason: 'path' } });
    const events = repos.audit.list();
    expect(events.map((e) => e.action)).toEqual(['file.write', 'auth.session']);
    expect(events[0]?.details).toEqual({ reason: 'path' });
    expect(repos.audit.list({ projectId: 'p1' })).toHaveLength(1);
  });
});

describe('literature cache', () => {
  const entry = (expiresAt: string, value: unknown = { record: { title: 'x' } }) => ({
    provider: 'openalex' as const,
    kind: 'record' as const,
    value,
    retrievedAt: '2026-11-02T12:00:00.000Z',
    expiresAt,
  });

  it('serves live entries only and replaces on write', () => {
    repos.literatureCache.set('record:openalex:doi:10.1/x', entry('2026-11-03T00:00:00.000Z'));
    expect(repos.literatureCache.get('record:openalex:doi:10.1/x', '2026-11-02T13:00:00.000Z')?.value).toEqual({ record: { title: 'x' } });
    expect(repos.literatureCache.get('record:openalex:doi:10.1/x', '2026-11-03T00:00:00.000Z')).toBeNull();
    repos.literatureCache.set('record:openalex:doi:10.1/x', entry('2026-11-04T00:00:00.000Z', { record: null }));
    expect(repos.literatureCache.get('record:openalex:doi:10.1/x', '2026-11-03T12:00:00.000Z')?.value).toEqual({ record: null });
    expect(repos.literatureCache.stats().entries).toBe(1);
  });

  it('purges expired rows, clears by provider, and caps its size', () => {
    const { LiteratureCacheRepository } = repositoriesModule;
    const small = new LiteratureCacheRepository(handle.db, 3);
    for (let i = 0; i < 5; i++) small.set(`k${i}`, entry(`2026-11-0${i + 3}T00:00:00.000Z`));
    expect(small.stats().entries).toBe(3);
    // The entries that expire soonest went first.
    expect(small.get('k0', '2026-11-01T00:00:00.000Z')).toBeNull();
    expect(small.get('k4', '2026-11-01T00:00:00.000Z')).not.toBeNull();
    expect(small.purgeExpired('2026-11-06T12:00:00.000Z')).toBe(2);
    small.set('other', { ...entry('2027-01-01T00:00:00.000Z'), provider: 'crossref' });
    expect(small.clear('openalex')).toBe(1);
    expect(small.stats()).toMatchObject({ entries: 1 });
    expect(small.stats().bytes).toBeGreaterThan(0);
  });
});

describe('literature history and provider state', () => {
  const add = (query: string) =>
    repos.literatureHistory.add({
      query,
      request: { query, sort: 'relevance' },
      resultCount: 3,
      providers: [{ provider: 'openalex', status: 'success', resultCount: 3 }],
    });

  it('keeps the newest searches first and can delete or clear them', () => {
    const first = add('surface code');
    add('magic states');
    expect(repos.literatureHistory.list().map((h) => h.query)).toEqual(['magic states', 'surface code']);
    expect(repos.literatureHistory.list()[0]!.request).toEqual({ query: 'magic states', sort: 'relevance' });
    expect(repos.literatureHistory.delete(first.id)).toBe(true);
    expect(repos.literatureHistory.delete(first.id)).toBe(false);
    expect(repos.literatureHistory.clear()).toBe(1);
  });

  it('caps the history length', () => {
    const { LiteratureHistoryRepository } = repositoriesModule;
    const short = new LiteratureHistoryRepository(handle.db, 2);
    for (const q of ['a', 'b', 'c']) short.add({ query: q, request: { query: q }, resultCount: 0, providers: [] });
    expect(short.list().map((h) => h.query)).toEqual(['c', 'b']);
  });

  it('tracks provider health without losing earlier rate-limit information', () => {
    repos.literatureProviders.record('crossref', { ok: true, at: '2026-11-02T12:00:00Z', rateLimit: { 'x-api-pool': 'public' } });
    repos.literatureProviders.record('crossref', { ok: false, at: '2026-11-02T12:05:00Z', errorKind: 'rate_limited', error: 'Crossref: rate limit reached' });
    expect(repos.literatureProviders.list()).toEqual([
      {
        provider: 'crossref',
        lastSuccessAt: '2026-11-02T12:00:00Z',
        lastErrorAt: '2026-11-02T12:05:00Z',
        lastErrorKind: 'rate_limited',
        lastError: 'Crossref: rate limit reached',
        rateLimit: { 'x-api-pool': 'public' },
        updatedAt: '2026-11-02T12:05:00Z',
      },
    ]);
    repos.literatureProviders.reset('crossref');
    expect(repos.literatureProviders.list()).toEqual([]);
  });
});
