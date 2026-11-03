import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@research-studio/api-contracts';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { z } from 'zod';
import type { BibUpdatePreview, ImportJob, LibraryItem, ProjectReferences, ZoteroStatus } from '@research-studio/shared-types';
import { makePdf } from '../../../packages/research-library/test/fixtures/make-pdf';
import { MockZotero } from '../../../packages/research-library/test/fixtures/mock-zotero';
import type { LibraryRuntimeOptions } from '../src/services/library-runtime';
import { createTestRuntime, type TestRuntime } from './helpers';

interface MockLiterature {
  env: Record<string, string>;
  close(): Promise<void>;
}

const mockModule = pathToFileURL(new URL('../../../e2e/mock-literature-server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
const SHOR_TITLE = 'Scheme for reducing decoherence in quantum computer memory';
const shorPdf = makePdf({ xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' }, pages: [[{ text: SHOR_TITLE, size: 18 }]] });
const notesPdf = makePdf({ info: { Title: 'Field notes on nothing in particular' }, pages: [[{ text: 'Field notes', size: 18 }]] });

let mock: MockLiterature;
let rt: TestRuntime | null = null;
/** Every response body of the current test, to check that no storage path ever reaches the browser. */
let seen: string[] = [];

beforeAll(async () => {
  const { startMockLiteratureServer } = (await import(mockModule)) as { startMockLiteratureServer: () => Promise<MockLiterature> };
  mock = await startMockLiteratureServer();
});
afterAll(() => mock.close());
afterEach(async () => {
  if (rt) {
    for (const body of seen) {
      expect(body).not.toContain(rt.config.library.storageDir);
      expect(body).not.toContain(rt.config.dataDir);
      expect(body).not.toMatch(/objects\/[0-9a-f]{2}\//);
    }
    await rt.dispose();
  }
  rt = null;
  seen = [];
});

async function runtime(config: Record<string, string> = {}, library: LibraryRuntimeOptions = {}): Promise<TestRuntime> {
  rt = await createTestRuntime({
    config: { ...mock.env, RS_LITERATURE_TIMEOUT_MS: '5000', ...config },
    literature: { providerConfig: { minIntervalMs: 0, backoffBaseMs: 1, maxRetries: 1 } },
    library,
  });
  return rt;
}

async function call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await rt!.request(method, `/api/v1${url}`, body === undefined ? {} : { body });
  seen.push(res.body);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
}

function pdfForm(files: { name: string; bytes: Uint8Array; type?: string }[]) {
  const boundary = `----rs${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/pdf'}\r\n\r\n`));
    parts.push(Buffer.from(f.bytes), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(url: string, files: { name: string; bytes: Uint8Array; type?: string }[]) {
  const form = pdfForm(files);
  const res = await rt!.request('POST', `/api/v1${url}`, { body: form.body, headers: { 'content-type': form.contentType } });
  seen.push(res.body);
  return res;
}

const finished = (job: ImportJob) => rt!.library.jobs.wait(job.id);
const tmpFiles = async () => readdir(path.join(rt!.config.library.storageDir, 'tmp'));
async function objectFiles(): Promise<string[]> {
  const root = path.join(rt!.config.library.storageDir, 'objects');
  const out: string[] = [];
  for (const a of await readdir(root).catch(() => [])) for (const b of await readdir(path.join(root, a))) out.push(...(await readdir(path.join(root, a, b))));
  return out;
}

describe('library API', () => {
  it('requires a session', async () => {
    await runtime();
    const res = await rt!.request('GET', '/api/v1/library/overview', { auth: false });
    expect(res.statusCode).toBe(401);
  });

  it('adds papers by DOI through the literature engine, and never infers the reading status', async () => {
    await runtime();
    const events: ServerEvent[] = [];
    rt!.events.subscribe((e) => events.push(e));

    const added = await call<{ item: LibraryItem; created: boolean; job: ImportJob | null }>('POST', '/library/items', { source: 'identifier', kind: 'doi', value: 'https://doi.org/10.1103/PhysRevA.52.R2493' });
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ metadataStatus: 'resolved', readingStatus: 'to-read', origin: 'providers' });
    expect(added.body.item.work.title).toBe(SHOR_TITLE);
    expect(added.body.item.citationKey).toMatch(/^shor1995/);
    expect(added.body.job).toBeNull();
    const id = added.body.item.id;
    expect(events).toContainEqual({ type: 'library.changed', kind: 'items', ids: [id] });

    const again = await call<{ item: LibraryItem; created: boolean }>('POST', '/library/items', { source: 'identifier', kind: 'doi', value: '10.1103/physreva.52.r2493' });
    expect(again).toMatchObject({ status: 200, body: { created: false, item: { id } } });

    expect((await call('POST', `/library/items/${id}/opened`)).status).toBe(204);
    const opened = (await call<{ item: LibraryItem }>('GET', `/library/items/${id}`)).body.item;
    expect(opened.readingStatus).toBe('to-read');
    expect(opened.lastOpenedAt).not.toBeNull();

    const edited = await call<{ item: LibraryItem }>('PATCH', `/library/items/${id}`, { readingStatus: 'read', tags: ['qec'], edits: { venue: 'Phys. Rev. A' } });
    expect(edited.body.item).toMatchObject({ readingStatus: 'read', tags: ['qec'], edits: { venue: 'Phys. Rev. A' } });
    expect(edited.body.item.work.venue).toBe('Phys. Rev. A');

    // A browser cannot hand the runtime metadata for a "search result": it names a work, the runtime fetches it.
    const forged = await call('POST', '/library/items', { source: 'work', workId: 'doi:10.1103/physreva.52.r2493', work: { title: 'Forged' } });
    expect(forged.status).toBe(200);
    expect(rt!.library.library.query({}).total).toBe(1);

    const bad = await call<{ error: { code: string } }>('PATCH', `/library/items/${id}`, { readingStatus: 'devoured' });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } });
  });

  it('imports uploaded PDFs in the background, stores them by content, and serves them back', async () => {
    await runtime();
    const res = await upload('/library/imports/pdf', [
      { name: 'shor.pdf', bytes: shorPdf },
      { name: '../../escape.pdf', bytes: notesPdf },
    ]);
    expect(res.statusCode).toBe(202);
    const job = await finished(res.json<{ job: ImportJob }>().job);
    expect(job.status).toBe('completed');
    expect(job.items.map((i) => [i.outcome, i.confidence])).toEqual([
      ['added', 'exact-doi'],
      ['unresolved', 'unresolved'],
    ]);

    const shor = (await call<{ item: LibraryItem }>('GET', `/library/items/${job.items[0]!.libraryItemId}`)).body.item;
    expect(shor.work.title).toBe(SHOR_TITLE);
    expect(shor.attachments).toMatchObject([{ originalFileName: 'shor.pdf', mimeType: 'application/pdf', fileSize: shorPdf.length, source: 'upload', available: true }]);
    const notes = (await call<{ item: LibraryItem }>('GET', `/library/items/${job.items[1]!.libraryItemId}`)).body.item;
    // Only what the file states; nothing invented.
    expect(notes.work).toMatchObject({ title: 'Field notes on nothing in particular', authors: [], abstract: null, publicationDate: null });
    expect(notes.work.identifiers.doi).toBeNull();
    expect(notes.attachments[0]!.fileName).not.toContain('..');
    expect(existsSync(path.join(rt!.base, 'escape.pdf'))).toBe(false);

    const content = await rt!.request('GET', `/api/v1/library/attachments/${shor.attachments[0]!.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(Buffer.compare(content.rawPayload, shorPdf)).toBe(0);
    expect(content.headers).toMatchObject({ 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff' });
    expect(content.headers['content-security-policy']).toContain('sandbox');
    expect(content.headers['content-disposition']).toMatch(/^inline; filename=/);

    expect(await objectFiles()).toHaveLength(2);
    expect(await tmpFiles()).toEqual([]);

    // The same bytes again: recognised, not stored twice.
    const dup = await finished((await upload('/library/imports/pdf', [{ name: 'copy.pdf', bytes: shorPdf }])).json<{ job: ImportJob }>().job);
    expect(dup.items[0]).toMatchObject({ outcome: 'duplicate', libraryItemId: shor.id });
    expect(await objectFiles()).toHaveLength(2);
    expect(await tmpFiles()).toEqual([]);
  });

  it('rejects files that are not PDFs or are too large, leaving nothing behind', async () => {
    await runtime({ RS_LIBRARY_MAX_PDF_BYTES: String(1024 * 1024) });
    const textAsPdf = await finished((await upload('/library/imports/pdf', [{ name: 'notes.pdf', bytes: Buffer.from('just some text') }])).json<{ job: ImportJob }>().job);
    expect(textAsPdf.items[0]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/PDF/) });

    const wrongType = await upload('/library/imports/pdf', [{ name: 'a.pdf', bytes: shorPdf, type: 'text/html' }]);
    expect(wrongType.statusCode).toBe(415);

    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const tooBig = await upload('/library/imports/pdf', [{ name: 'big.pdf', bytes: big }]);
    expect(tooBig.statusCode).toBe(413);

    expect(await tmpFiles()).toEqual([]);
    expect(await objectFiles()).toEqual([]);
    expect(rt!.library.library.query({}).total).toBe(0);
  });

  it('works without literature search: PDFs are kept unresolved, identifier lookups are refused', async () => {
    await runtime({ RS_LITERATURE: 'off' });
    const job = await finished((await upload('/library/imports/pdf', [{ name: 'shor.pdf', bytes: shorPdf }])).json<{ job: ImportJob }>().job);
    expect(job.items[0]).toMatchObject({ outcome: 'unresolved', message: expect.stringMatching(/not available/) });
    // The DOI stated in the PDF was kept: adding it again finds the paper without any lookup.
    const known = await call<{ created: boolean }>('POST', '/library/items', { source: 'identifier', kind: 'doi', value: '10.1103/physreva.52.r2493' });
    expect(known).toMatchObject({ status: 200, body: { created: false } });
    const unknown = await call<{ error: { code: string } }>('POST', '/library/items', { source: 'identifier', kind: 'arxiv', value: '1706.03762' });
    expect(unknown.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('imports BibTeX after a preview, exports it, and keeps papers when their collection is deleted', async () => {
    await runtime();
    const bib = [
      '@article{shor95, title={Scheme for reducing decoherence in quantum computer memory}, author={Shor, Peter W.}, year={1995}, doi={10.1103/PhysRevA.52.R2493}, mynote={keep me}}',
      '@book{knuth84, title={The {\\TeX}book}, author={Knuth, Donald E.}, year={1984}, publisher={Addison-Wesley}}',
    ].join('\n\n');
    const preview = await call<{ entries: { state: string; citationKey: string }[] }>('POST', '/library/imports/references/preview', { format: 'bibtex', text: bib });
    expect(preview.body.entries.map((e) => [e.citationKey, e.state])).toEqual([
      ['shor95', 'new'],
      ['knuth84', 'new'],
    ]);
    expect(rt!.library.library.query({}).total).toBe(0);

    const started = await call<{ job: ImportJob }>('POST', '/library/imports/references', { format: 'bibtex', text: bib, resolveIdentifiers: false });
    expect(started.status).toBe(202);
    const job = await finished(started.body.job);
    expect(job.items.map((i) => i.outcome)).toEqual(['added', 'added']);
    const ids = job.items.map((i) => i.libraryItemId!);

    const coll = await call<{ collection: { id: string } }>('POST', '/library/collections', { name: 'Classics', color: '#336699' });
    expect(coll.status).toBe(201);
    expect((await call('POST', `/library/collections/${coll.body.collection.id}/items`, { itemIds: ids })).body).toEqual({ count: 2 });
    const scoped = await call<{ text: string; count: number }>('POST', '/library/export', { format: 'bibtex', selection: { collectionId: coll.body.collection.id } });
    expect(scoped.body.count).toBe(2);
    expect(scoped.body.text).toContain('@article{shor95,');
    expect(scoped.body.text).toContain('mynote = {keep me}');
    expect((await call('DELETE', `/library/collections/${coll.body.collection.id}`)).status).toBe(204);
    expect(rt!.library.library.query({}).total).toBe(2);

    const ris = await call<{ text: string; fileName: string }>('POST', '/library/export', { format: 'ris', selection: { itemIds: [ids[1]!] } });
    expect(ris.body).toMatchObject({ fileName: 'library.ris' });
    expect(ris.body.text).toMatch(/^TY {2}- BOOK/);
  });

  it('cancels a queued import and leaves no temporary files', async () => {
    await runtime({ RS_LITERATURE: 'off' });
    // Two jobs run at a time; the third waits in the queue and is cancelled there.
    const jobs: ImportJob[] = [];
    for (let i = 0; i < 3; i++) jobs.push((await upload('/library/imports/pdf', [{ name: `n${i}.pdf`, bytes: makePdf({ pages: [[{ text: `Paper ${i}` }]] }) }])).json<{ job: ImportJob }>().job);
    const cancelled = await call<{ job: ImportJob }>('POST', `/library/jobs/${jobs[2]!.id}/cancel`);
    expect(cancelled.status).toBe(200);
    const final = await finished(jobs[2]!);
    expect(final.status).toBe('cancelled');
    await Promise.all(jobs.map(finished));
    await new Promise((r) => setTimeout(r, 50));
    expect(await tmpFiles()).toEqual([]);
    expect((await call<{ jobs: ImportJob[] }>('GET', '/library/jobs')).body.jobs).toHaveLength(3);
  });
});

describe('project references', () => {
  it('updates the .bib file only through a reviewed preview, and protects keys used in the manuscript', async () => {
    await runtime();
    const project = (await call<{ project: { id: string } }>('POST', '/projects', { name: 'Codes', template: 'empty' })).body.project;
    const item = (await call<{ item: LibraryItem }>('POST', '/library/items', { source: 'identifier', kind: 'doi', value: '10.1103/physreva.52.r2493' })).body.item;
    const key = item.citationKey!;
    await rt!.projects.writeFile(project.id, { path: 'main.tex', content: `\\documentclass{article}\\begin{document}See \\cite{${key}}.\\bibliography{references}\\end{document}\n` }, { sessionId: null });

    expect((await call('POST', `/projects/${project.id}/references/items`, { itemIds: [item.id] })).body).toEqual({ count: 1 });
    const refs = (await call<ProjectReferences>('GET', `/projects/${project.id}/references`)).body;
    expect(refs.settings).toEqual({ bibFile: 'references.bib', citeCommand: 'cite' });
    expect(refs.citations).toEqual([{ key, occurrences: [{ file: 'main.tex', line: 1 }], definedIn: [], libraryItemId: item.id, status: 'library-only' }]);

    const preview = (await call<BibUpdatePreview>('POST', `/projects/${project.id}/references/bib/preview`, {})).body;
    expect(preview).toMatchObject({ path: 'references.bib', baseHash: null, original: '', changes: [{ kind: 'add-entry', citationKey: key, applicable: true }] });
    // Previewing writes nothing.
    expect((await call('GET', `/projects/${project.id}/files/content?path=references.bib`)).status).toBe(404);

    const applied = await call<{ path: string }>('POST', `/projects/${project.id}/references/bib/apply`, { baseHash: preview.baseHash });
    expect(applied).toMatchObject({ status: 200, body: { path: 'references.bib' } });
    const bib = (await call<{ content: string; hash: string }>('GET', `/projects/${project.id}/files/content?path=references.bib`)).body;
    expect(bib.content).toContain(`@article{${key},`);

    // The file changed after this preview was made: nothing is written.
    const stale = await call<{ error: { code: string; details: { reason: string } } }>('POST', `/projects/${project.id}/references/bib/apply`, { baseHash: preview.baseHash });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT', details: { reason: 'STALE_PREVIEW' } } } });

    // The key is used by a linked project: renaming needs explicit confirmation.
    const rename = await call<{ error: { code: string } }>('PUT', `/library/items/${item.id}/citation-key`, { key: 'shorCodes' });
    expect(rename.status).toBe(409);
    expect((await call<{ item: LibraryItem }>('GET', `/library/items/${item.id}`)).body.item.citationKey).toBe(key);

    const impact = await call<{ projects: { id: string }[]; attachments: number }>('POST', '/library/items/deletion-impact', { itemIds: [item.id] });
    expect(impact.body.projects.map((p) => p.id)).toEqual([project.id]);
    const audit = (await call<{ events: { action: string }[] }>('GET', '/audit?limit=50')).body.events.map((e) => e.action);
    expect(audit).toContain('library.bib.apply');
  });
});

describe('Zotero', () => {
  let zotero: MockZotero;
  beforeAll(async () => {
    zotero = new MockZotero();
    await zotero.start();
  });
  afterAll(() => zotero.stop());

  it('keeps the API key in the runtime, never returns it, and imports from Zotero', async () => {
    await runtime({ RS_ZOTERO_URL: zotero.baseUrl });
    zotero.addItem({ itemType: 'book', title: 'Quantum Computation and Quantum Information', creators: [{ creatorType: 'author', firstName: 'Michael', lastName: 'Nielsen' }], date: '2000' });

    expect((await call('PUT', '/library/zotero/web-key', { apiKey: 'not a key!' })).status).toBe(400);
    expect((await call('PUT', '/library/zotero/web-key', { apiKey: 'WrongKeyWrongKey12345678' })).status).toBe(403);
    expect(await rt!.secrets.get('zotero:web')).toBeNull();

    const set = await call<{ status: ZoteroStatus }>('PUT', '/library/zotero/web-key', { apiKey: zotero.apiKey });
    expect(set.body.status.web).toMatchObject({ configured: true, userId: zotero.userId, username: 'tester', canWrite: true });
    expect(await rt!.secrets.get('zotero:web')).toBe(zotero.apiKey);

    const preview = await call<{ items: { title: string; state: string }[] }>('POST', '/library/zotero/import/preview', { mode: 'web' });
    expect(preview.body.items).toMatchObject([{ title: 'Quantum Computation and Quantum Information', state: 'new' }]);
    const job = await finished((await call<{ job: ImportJob }>('POST', '/library/zotero/import', { mode: 'web' })).body.job);
    expect(job.items.map((i) => i.outcome)).toEqual(['added']);
    expect((await call<{ status: ZoteroStatus }>('GET', '/library/zotero')).body.status.linkedItems).toBe(1);

    // The local API is off until the user turns it on.
    expect((await call<{ error: { code: string } }>('POST', '/library/zotero/import/preview', { mode: 'local' })).body.error.code).toBe('NOT_CONFIGURED');

    const removed = await call<{ status: ZoteroStatus }>('DELETE', '/library/zotero/web-key');
    expect(removed.body.status.web.configured).toBe(false);
    expect(await rt!.secrets.get('zotero:web')).toBeNull();

    const audit = await call<{ events: { action: string }[] }>('GET', '/audit?limit=100');
    expect(audit.body.events.filter((e) => e.action === 'library.zotero.key')).toHaveLength(2);
    // No response (the audit log included), and no setting, ever carried the key.
    for (const body of seen) expect(body).not.toContain(zotero.apiKey);
    expect(JSON.stringify(rt!.db.sqlite.prepare('select * from settings').all())).not.toContain(zotero.apiKey);
  });
});

describe('contracts', () => {
  it('every library response parses with the schema the web client uses', async () => {
    await runtime();
    const ok = async <S extends z.ZodType>(schema: S, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown): Promise<z.infer<S>> => {
      const res = await call(method, url, body);
      expect(res.status, `${method} ${url}`).toBeLessThan(300);
      const parsed = schema.safeParse(res.body);
      expect(parsed.error?.issues ?? [], `${method} ${url}`).toEqual([]);
      return parsed.data as z.infer<S>;
    };
    const added = await ok(C.AddLibraryItemResponse, 'POST', '/library/items', { source: 'identifier', kind: 'doi', value: '10.1103/physreva.52.r2493', options: { tags: ['qec'] } });
    const manual = await ok(C.AddLibraryItemResponse, 'POST', '/library/items', { source: 'manual', reference: { title: 'Scheme for reducing decoherence in quantum computer memory', authors: [{ givenName: 'Peter', familyName: 'Shor', name: null }] } });
    const id = added.item.id;
    const job = await finished((await upload(`/library/items/${id}/attachments`, [{ name: 'shor.pdf', bytes: shorPdf }])).json<{ job: ImportJob }>().job);
    expect(C.ImportJobSchema.safeParse(job).success).toBe(true);
    const coll = await ok(C.CollectionResponse, 'POST', '/library/collections', { name: 'Codes' });
    await ok(C.CountResponse, 'POST', `/library/collections/${coll.collection.id}/items`, { itemIds: [id] });
    const project = (await call<{ project: { id: string } }>('POST', '/projects', { name: 'Contracts', template: 'empty' })).body.project;
    await ok(C.CountResponse, 'POST', `/projects/${project.id}/references/items`, { itemIds: [id] });

    await ok(C.LibraryOverviewResponse, 'GET', '/library/overview');
    await ok(C.LibraryItemPageSchema, 'GET', '/library/items?q=decoherence&hasPdf=true&sort=title-asc&limit=10');
    const item = await ok(C.LibraryItemResponse, 'GET', `/library/items/${id}`);
    expect(item.item.attachments).toHaveLength(1);
    await ok(C.LibraryItemResponse, 'PATCH', `/library/items/${id}`, { notes: 'Read section 3', isFavorite: true });
    await ok(C.BulkLibraryResponse, 'POST', '/library/items/bulk', { itemIds: [id], action: { kind: 'set-status', readingStatus: 'reading' } });
    await ok(C.TagsResponse, 'GET', '/library/tags');
    await ok(C.CollectionsResponse, 'GET', '/library/collections');
    await ok(C.CitationKeySuggestionsResponse, 'GET', `/library/items/${manual.item.id}/citation-keys`);
    await ok(C.RegenerateKeysResponse, 'POST', '/library/citation-keys/regenerate', { itemIds: [manual.item.id], replaceExisting: false });
    await ok(C.DuplicatesResponse, 'GET', '/library/duplicates');
    await ok(C.DeletionImpactResponse, 'POST', '/library/items/deletion-impact', { itemIds: [id] });
    await ok(C.ReferencePreviewResponse, 'POST', '/library/imports/references/preview', { format: 'ris', text: 'TY  - JOUR\nTI  - A title\nER  - \n' });
    await ok(C.ImportJobListResponse, 'GET', '/library/jobs');
    await ok(C.ExportResponse, 'POST', '/library/export', { format: 'bibtex', selection: { all: true } });
    await ok(C.LibraryPreferencesResponse, 'PATCH', '/library/preferences', { citationKeyFormat: 'author-year' });
    await ok(C.StorageReportResponse, 'POST', '/library/storage/sweep');
    await ok(C.ZoteroStatusResponse, 'GET', '/library/zotero');
    await ok(C.ProjectReferencesSchema, 'GET', `/projects/${project.id}/references`);
    await ok(C.ProjectReferenceSettingsResponse, 'PATCH', `/projects/${project.id}/references/settings`, { citeCommand: 'citep' });
    const preview = await ok(C.BibUpdatePreviewSchema, 'POST', `/projects/${project.id}/references/bib/preview`, {});
    await ok(C.BibApplyResponse, 'POST', `/projects/${project.id}/references/bib/apply`, { baseHash: preview.baseHash });
    await ok(C.MergeResponse, 'POST', '/library/merge', { keepId: id, dropId: manual.item.id });
    await ok(C.AttachmentResponse, 'PATCH', `/library/attachments/${item.item.attachments[0]!.id}`, { fileName: 'Shor - QEC.pdf' });
  });
});

describe('restart', () => {
  it('keeps items, files and collections, marks interrupted imports and clears temporary files', async () => {
    await runtime({ RS_LITERATURE: 'off' });
    const job = await finished((await upload('/library/imports/pdf', [{ name: 'notes.pdf', bytes: notesPdf }])).json<{ job: ImportJob }>().job);
    const itemId = job.items[0]!.libraryItemId!;
    const coll = (await call<{ collection: { id: string } }>('POST', '/library/collections', { name: 'Kept' })).body.collection;
    await call('POST', `/library/collections/${coll.id}/items`, { itemIds: [itemId] });

    // What an interrupted import leaves behind: a running job row and a partial upload.
    rt!.library.repo.insertJob({ id: 'job_interrupted', kind: 'pdf', status: 'running', total: 3, processed: 1, items: [], warnings: [], createdAt: new Date().toISOString() });
    await mkdir(path.join(rt!.config.library.storageDir, 'tmp'), { recursive: true });
    await writeFile(path.join(rt!.config.library.storageDir, 'tmp', 'upload-0123.part'), 'partial');

    rt = await rt!.restart();
    const item = (await call<{ item: LibraryItem }>('GET', `/library/items/${itemId}`)).body.item;
    expect(item.collections.map((c) => c.id)).toEqual([coll.id]);
    expect(item.attachments).toMatchObject([{ available: true }]);
    const content = await rt.request('GET', `/api/v1/library/attachments/${item.attachments[0]!.id}/content`);
    expect(Buffer.compare(content.rawPayload, notesPdf)).toBe(0);
    expect((await call<{ job: ImportJob }>('GET', '/library/jobs/job_interrupted')).body.job.status).toBe('interrupted');
    expect(await tmpFiles()).toEqual([]);
  });
});
