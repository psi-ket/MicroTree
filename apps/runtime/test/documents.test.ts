import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@research-studio/api-contracts';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { z } from 'zod';
import type { ImportJob, LibraryItem } from '@research-studio/shared-types';
import { PyMuPdfClient } from '@research-studio/paper-ingestion';
import { lines, makeLayoutPdf } from '../../../packages/document-intelligence/test/fixtures/make-pdf';
import { MockGrobid } from '../../../packages/paper-ingestion/test/fixtures/mock-grobid';
import { SAMPLE_TEI } from '../../../packages/paper-ingestion/test/fixtures/tei';
import { MockOllamaEmbeddings } from '../../../packages/research-retrieval/test/fixtures/mock-ollama';
import { createTestRuntime, type TestRuntime } from './helpers';

const python = process.env.RS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const pymupdf = (await new PyMuPdfClient({ python, timeoutMs: 30_000, memoryMb: 1024, maxPages: 10, maxOutputBytes: 1e7, concurrency: 1 }).status()).status === 'available';

// A PDF whose text layer contains the words of the synthetic TEI, so coverage is measured as complete.
const paperPdf = makeLayoutPdf([
  {
    texts: [
      { x: 72, y: 720, text: 'Bosonic Codes and the Lindblad Master Equation', size: 18 },
      ...lines(72, 680, [
        'We study bosonic codes under the Lindblad master equation. The cat code & the GKP code are compared.',
        'Quantum error correction protects fragile states [1]. Majorana zero modes are a different route [2].',
        'The density matrix evolves under a Hamiltonian H_2 with loss rate. Cat codes use superpositions of coherent states.',
      ]),
    ],
  },
  { texts: lines(72, 700, ['Tensor networks simulate the dynamics efficiently. Hamiltonian simulation needs fewer gates.', 'A footnote about topological phases.']) },
]);

let grobid: MockGrobid;
let ollama: MockOllamaEmbeddings;
let rt: TestRuntime | null = null;
let seen: string[] = [];

beforeAll(async () => {
  grobid = await new MockGrobid().start();
  ollama = await new MockOllamaEmbeddings().start();
});
afterAll(async () => {
  await grobid.stop();
  await ollama.stop();
});
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

async function runtime(config: Record<string, string> = {}): Promise<TestRuntime> {
  rt = await createTestRuntime({
    config: { RS_LITERATURE: 'off', RS_GROBID_URL: grobid.url, RS_OLLAMA_URL: ollama.url, ...config },
    documents: { grobidBusyDelayMs: 10 },
  });
  return rt;
}

async function call<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, auth = true): Promise<{ status: number; body: T }> {
  const res = await rt!.request(method, `/api/v1${url}`, { ...(body === undefined ? {} : { body }), auth });
  seen.push(res.body);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
}

async function addPdf(bytes: Uint8Array, name = 'paper.pdf'): Promise<{ itemId: string; attachmentId: string }> {
  const boundary = `----rs${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await rt!.request('POST', '/api/v1/library/imports/pdf', { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  expect(res.statusCode).toBeLessThan(300);
  const job = (await rt!.library.jobs.wait((res.json() as { job: ImportJob }).job.id))!;
  const itemId = job.items[0]!.libraryItemId!;
  const item = (await call<{ item: LibraryItem }>('GET', `/library/items/${itemId}`)).body.item;
  return { itemId, attachmentId: item.attachments[0]!.id };
}

async function processPdf(attachmentId: string) {
  const r = await call<z.infer<typeof C.DocumentJobResponse>>('POST', `/documents/${attachmentId}/process`);
  expect(r.status).toBe(202);
  return (await rt!.documents.waitForJob(r.body.job.id))!;
}

describe.skipIf(!pymupdf)('documents and research search (mock GROBID, mock Ollama, real PyMuPDF)', () => {
  it('processes a library PDF and serves its structure, passages, references and elements', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    await runtime();
    const events: ServerEvent[] = [];
    rt!.events.subscribe((e) => events.push(e));
    const { attachmentId } = await addPdf(paperPdf);

    const providers = await call<z.infer<typeof C.RetrievalProvidersResponse>>('GET', '/retrieval/providers?probe=1');
    expect(C.RetrievalProvidersResponse.safeParse(providers.body).success).toBe(true);
    expect(providers.body.grobid).toMatchObject({ status: 'available', version: '0.8.2', remote: false, consolidation: false });
    expect(providers.body.pymupdf.status).toBe('available');
    expect(providers.body.embeddings).toMatchObject({ enabled: false, status: 'disabled' });

    const before = await call('GET', `/documents/${attachmentId}/structure`);
    expect(before.status).toBe(404);

    const job = await processPdf(attachmentId);
    expect(job).toMatchObject({ status: 'completed', progress: 1, error: null });
    expect(events.filter((e) => e.type === 'documents.job').map((e) => (e as { job: { status: string } }).job.status)).toEqual(
      expect.arrayContaining(['queued', 'validating', 'extracting', 'segmenting', 'indexing_keywords', 'completed']),
    );

    const status = await call<z.infer<typeof C.DocumentStatusResponse>>('GET', `/documents/${attachmentId}/status`);
    expect(C.DocumentStatusResponse.safeParse(status.body).success).toBe(true);
    expect(status.body.extraction).toMatchObject({ status: 'completed', extractor: 'grobid', extractorVersion: '0.8.2', pageCount: 2, stale: [] });
    expect(status.body.extraction!.quality.textCoverage).toBeGreaterThan(0.6);

    const structure = await call<z.infer<typeof C.DocumentStructureResponse>>('GET', `/documents/${attachmentId}/structure`);
    expect(C.DocumentStructureResponse.safeParse(structure.body).success).toBe(true);
    expect(structure.body.sections.map((s) => s.path)).toContain('2 Model › 2.1 Cat codes');
    expect(structure.body.pages[0]).toMatchObject({ pageNumber: 1, width: 612, height: 792, rotation: 0 });
    expect(structure.body.elements.map((e) => e.type)).toEqual(['equation', 'figure', 'table']);
    expect(structure.body.references[0]).toMatchObject({ doi: '10.1103/physreva.52.r2493', resolutionStatus: 'unresolved', linkedLibraryItemId: null });

    const passages = await call<z.infer<typeof C.DocumentPassagesResponse>>('GET', `/documents/${attachmentId}/passages?offset=1&limit=2`);
    expect(passages.body.passages).toHaveLength(2);
    expect(passages.body.passages[0]!.order).toBe(1);
    expect(passages.body.total).toBeGreaterThan(3);
    expect((await call<z.infer<typeof C.DocumentSectionsResponse>>('GET', `/documents/${attachmentId}/sections`)).body.sections.length).toBe(structure.body.sections.length);
    expect((await call<z.infer<typeof C.DocumentReferencesResponse>>('GET', `/documents/${attachmentId}/references`)).body.references).toHaveLength(2);
    expect((await call<z.infer<typeof C.DocumentElementsResponse>>('GET', `/documents/${attachmentId}/elements`)).body.elements).toHaveLength(3);
    // Sent to GROBID with consolidation off.
    expect(MockGrobid.fields(grobid.requests.at(-1)!, 'consolidateHeader')).toEqual(['0']);
  });

  it('searches by keyword with filters, returns exact passages with provenance, and locates them in the PDF', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    await runtime();
    const { attachmentId, itemId } = await addPdf(paperPdf);
    await processPdf(attachmentId);

    const r = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: '"Lindblad master equation"', mode: 'keyword' });
    expect(r.status).toBe(200);
    expect(C.ResearchSearchResponse.safeParse(r.body).success).toBe(true);
    const hit = r.body.results[0]!;
    expect(hit).toMatchObject({ matchedBy: 'keyword', keywordRank: 1, semanticRank: null, attachmentId, kind: 'abstract', sectionPath: 'Abstract', pageStart: 1, hasCoordinates: true });
    expect(hit.text).toContain('We study bosonic codes under the Lindblad master equation.');
    expect(hit.paper.libraryItemId).toBe(itemId);
    expect(hit.provenance).toMatchObject({ attachmentId, extractor: 'grobid', extractorVersion: '0.8.2', attachmentSource: 'upload' });
    expect(hit.provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.papersSearched).toBe(1);

    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks section:results', mode: 'keyword' })).body.results[0]!.sectionPath).toBe('3 Results');
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks', mode: 'keyword', filters: { sectionTypes: ['methods'] } })).body.results).toEqual([]);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor', mode: 'keyword', filters: { yearFrom: 2100 } })).body.results).toEqual([]);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor', mode: 'keyword', scope: { kind: 'papers', libraryItemIds: [itemId] } })).body.results.length).toBeGreaterThan(0);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor', mode: 'keyword', scope: { kind: 'papers', libraryItemIds: ['li_none'] } })).body.results).toEqual([]);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'Shor decoherence', mode: 'keyword' })).body.results).toEqual([]);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'Shor decoherence', mode: 'keyword', filters: { includeReferences: true } })).body.results[0]!.kind).toBe('reference');

    const hybrid = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks' });
    expect(hybrid.body.mode).toBe('hybrid');
    expect(hybrid.body.semantic.used).toBe(false);
    expect(hybrid.body.warnings.join(' ')).toMatch(/semantic search is not available/);

    const loc = await call<z.infer<typeof C.PassageLocationResponse>>('GET', `/research/passages/${hit.passageId}/location`);
    expect(C.PassageLocationResponse.safeParse(loc.body).success).toBe(true);
    expect(loc.body).toMatchObject({ attachmentId, pageNumber: 1 });
    expect(loc.body.coordinates[0]).toMatchObject({ pageNumber: 1, x: 72, y: 150, coordinateSystem: 'pdf-points', origin: 'top-left' });
    expect(loc.body.pages[0]).toMatchObject({ pageNumber: 1, width: 612 });

    const detail = await call<z.infer<typeof C.PassageDetailResponse>>('GET', `/research/passages/${hit.passageId}`);
    expect(C.PassageDetailResponse.safeParse(detail.body).success).toBe(true);
    expect(detail.body.after.length).toBe(1);
    expect(detail.body.sentences.map((s) => s.text)).toEqual(['We study bosonic codes under the Lindblad master equation.', 'The cat code & the GKP code are compared.']);
    expect((await call('GET', '/research/passages/dex_nope_p0')).status).toBe(404);
  });

  it('builds an embedding index, runs hybrid search, and isolates a changed model until reindexing', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    await runtime();
    const { attachmentId } = await addPdf(paperPdf);
    await processPdf(attachmentId);

    expect((await call('PATCH', '/retrieval/settings', { embeddingBaseUrl: 'https://embeddings.example.org' })).status).toBe(400);
    const settings = await call<z.infer<typeof C.RetrievalProvidersResponse>>('PATCH', '/retrieval/settings', { embeddingsEnabled: true, embeddingModel: 'nomic-embed-text' });
    expect(settings.body.embeddings).toMatchObject({ enabled: true, status: 'available', dimensions: 64, version: 'sha256:nomic-embed-text' });

    const started = await call<z.infer<typeof C.IndexStatusResponse>>('POST', '/retrieval/reindex', {});
    expect(started.status).toBe(202);
    await rt!.documents.waitForReindex();
    const status = await call<z.infer<typeof C.IndexStatusResponse>>('GET', '/retrieval/index/status');
    expect(C.IndexStatusResponse.safeParse(status.body).success).toBe(true);
    expect(status.body.embeddings.activeSpace).toMatchObject({ model: 'nomic-embed-text', dimensions: 64 });
    expect(status.body.embeddings.indexedPassages).toBe(status.body.embeddings.embeddablePassages);
    expect(status.body.embeddings.reindex).toMatchObject({ status: 'completed' });
    expect(status.body.documents).toMatchObject({ pdfAttachments: 1, processed: 1, failed: 0, waiting: 0 });

    const hybrid = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks dynamics', mode: 'hybrid' });
    expect(hybrid.body.semantic).toMatchObject({ used: true, model: 'nomic-embed-text' });
    expect(hybrid.body.results[0]).toMatchObject({ matchedBy: 'hybrid', sectionPath: '3 Results' });
    const semantic = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks dynamics', mode: 'semantic' });
    expect(semantic.body.results.every((x) => x.matchedBy === 'semantic' && x.keywordRank === null)).toBe(true);
    const similar = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search/passage', { passageId: hybrid.body.results[0]!.passageId, limit: 3 });
    expect(similar.body.results.length).toBeGreaterThan(0);
    expect(similar.body.results.some((x) => x.passageId === hybrid.body.results[0]!.passageId)).toBe(false);

    // A different model: the old index keeps answering only once the query model matches; nothing is mixed.
    await call('PATCH', '/retrieval/settings', { embeddingModel: 'other-embed' });
    const mismatch = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks', mode: 'semantic' });
    expect(mismatch.body.semantic.used).toBe(false);
    expect(mismatch.body.results).toEqual([]);
    await call('POST', '/retrieval/reindex', {});
    await rt!.documents.waitForReindex();
    const after = await call<z.infer<typeof C.IndexStatusResponse>>('GET', '/retrieval/index/status');
    expect(after.body.embeddings.activeSpace).toMatchObject({ model: 'other-embed', dimensions: 32 });
    expect(rt!.documents.vectors.spaces().map((s) => s.model)).toEqual(['other-embed']);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor networks', mode: 'semantic' })).body.semantic.used).toBe(true);
  });

  it('falls back to PyMuPDF when GROBID is down, keeps the old extraction when reprocessing fails, and removes everything with the attachment', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    await runtime();
    const { attachmentId } = await addPdf(paperPdf);
    await processPdf(attachmentId);
    const first = (await call<z.infer<typeof C.DocumentStatusResponse>>('GET', `/documents/${attachmentId}/status`)).body.extraction!;

    grobid.fallback = { status: 500, body: 'internal failure' };
    const re = await call<z.infer<typeof C.DocumentJobResponse>>('POST', `/documents/${attachmentId}/reprocess`);
    const done = (await rt!.documents.waitForJob(re.body.job.id))!;
    // PyMuPDF took over: the reprocess succeeded with the layout fallback and replaced the extraction.
    expect(done.status).toBe('partial');
    expect(done.notes.join(' ')).toMatch(/GROBID failed on this document/);
    const second = (await call<z.infer<typeof C.DocumentStatusResponse>>('GET', `/documents/${attachmentId}/status`)).body.extraction!;
    expect(second.id).not.toBe(first.id);
    expect(second.extractor).toBe('pymupdf');

    // Deleting the attachment removes extraction, passages and index rows.
    expect((await call('DELETE', `/library/attachments/${attachmentId}`)).status).toBe(204);
    expect((await call('GET', `/documents/${attachmentId}/status`)).status).toBe(404);
    expect((await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'tensor', mode: 'keyword' })).body.results).toEqual([]);
    expect(rt!.documents.engine.keyword.count()).toBe(0);
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
  });

  it('marks scans as needing OCR, refuses bad input, requires a session and survives a restart', async () => {
    grobid.fallback = { status: 204 };
    await runtime();
    const scan = makeLayoutPdf([{ image: true }, { image: true }]);
    const { attachmentId: scanId } = await addPdf(scan, 'scan.pdf');
    const job = await processPdf(scanId);
    expect(job.status).toBe('needs_ocr');
    expect(job.notes.join(' ')).toMatch(/OCR/);
    const idx = await call<z.infer<typeof C.IndexStatusResponse>>('GET', '/retrieval/index/status');
    expect(idx.body.documents.needsOcr).toBe(1);

    expect((await call('POST', '/documents/..%2F..%2Fetc/process')).status).toBe(400);
    expect((await call('POST', '/documents/att_unknown/process')).status).toBe(404);
    expect((await call('POST', '/research/search', { query: '' })).status).toBe(400);
    expect((await call('POST', '/research/search', { query: 'x', mode: 'magic' })).status).toBe(400);
    expect((await call('GET', '/retrieval/index/status', undefined, false)).status).toBe(401);
    expect((await call('POST', '/research/search', { query: 'x' }, false)).status).toBe(401);

    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const { attachmentId } = await addPdf(paperPdf);
    const all = await call<z.infer<typeof C.ProcessAllResponse>>('POST', '/documents/process-all');
    expect(all.body.queued).toBe(1);
    await rt!.documents.queue.idle();
    rt = await rt!.restart();
    const r = await call<z.infer<typeof C.ResearchSearchResponse>>('POST', '/research/search', { query: 'Majorana zero modes', mode: 'keyword' });
    expect(r.body.results[0]!.attachmentId).toBe(attachmentId);
    const jobs = await call<z.infer<typeof C.DocumentJobListResponse>>('GET', '/documents/jobs');
    expect(jobs.body.jobs.length).toBe(2);
    const audit = (rt!.db.sqlite.prepare('SELECT action FROM audit_events').all() as { action: string }[]).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['documents.process']));
  });
});
