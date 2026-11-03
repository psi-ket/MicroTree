import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@research-studio/database';
import { normalizeSearchText, type NormalizedDocument, type PassageDraft } from '@research-studio/document-intelligence';
import {
  DEFAULT_GROBID_CONFIGURATION,
  DEFAULT_PROCESSING_LIMITS,
  DocumentStore,
  GrobidClient,
  IngestionQueue,
  IngestionService,
  PyMuPdfClient,
  type IngestionDeps,
  type JobRow,
} from '../src';
import { lines, makeLayoutPdf } from '../../document-intelligence/test/fixtures/make-pdf';
import { MockGrobid } from './fixtures/mock-grobid';
import { SAMPLE_TEI } from './fixtures/tei';

const python = process.env.RS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const pyConfig = { python, timeoutMs: 60_000, memoryMb: 1536, maxPages: 500, maxOutputBytes: 64 * 1024 * 1024, concurrency: 2 };
const pymupdfAvailable = (await new PyMuPdfClient(pyConfig).status()).status === 'available';
const ts = '2026-11-03T10:00:00.000Z';

const textPdf = makeLayoutPdf([
  { texts: [{ x: 72, y: 720, text: 'Bosonic Codes and the Lindblad Master Equation', size: 18 }, ...lines(72, 660, Array.from({ length: 12 }, (_, i) => `Quantum error correction protects fragile states, sentence ${i}.`))] },
  { texts: lines(72, 700, Array.from({ length: 12 }, (_, i) => `Tensor networks simulate the dynamics efficiently, line ${i}.`)) },
]);
const scanPdf = makeLayoutPdf([{ image: true }, { image: true }]);

let handle: DatabaseHandle;
let store: DocumentStore;
let grobid: MockGrobid;
const files = new Map<string, Uint8Array>();
let n = 0;

function addAttachment(bytes: Uint8Array): string {
  n++;
  const sha = createHash('sha256').update(bytes).digest('hex');
  const s = handle.sqlite;
  s.prepare(`INSERT INTO scholarly_works (id, origin, work, title_key, created_at, updated_at) VALUES (?, 'manual', '{}', ?, ?, ?)`).run(`w${n}`, `w${n}`, ts, ts);
  s.prepare(`INSERT INTO library_items (id, scholarly_work_id, metadata_status, added_at, updated_at) VALUES (?, ?, 'manual', ?, ?)`).run(`li${n}`, `w${n}`, ts, ts);
  s.prepare(
    `INSERT INTO library_attachments (id, library_item_id, file_name, original_file_name, storage_key, mime_type, file_size, sha256, attachment_type, source, created_at, updated_at)
     VALUES (?, ?, 'p.pdf', 'p.pdf', ?, 'application/pdf', ?, ?, 'pdf', 'upload', ?, ?)`,
  ).run(`att${n}`, `li${n}`, `objects/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`, bytes.byteLength, sha, ts, ts);
  files.set(`att${n}`, bytes);
  return `att${n}`;
}

/** One passage per text block; enough to test the pipeline without the retrieval package. */
function segment(doc: NormalizedDocument, sha: string): PassageDraft[] {
  return doc.blocks
    .filter((b) => b.type !== 'heading' && b.type !== 'title' && b.plainText)
    .map((b, i) => ({
      order: i,
      kind: b.type === 'reference' ? 'reference' : 'body',
      sectionKey: b.sectionKey,
      sectionPath: doc.sections.find((s) => s.key === b.sectionKey)?.path ?? '',
      sectionType: doc.sections.find((s) => s.key === b.sectionKey)?.type ?? 'body',
      blockKeys: [b.key],
      text: b.plainText,
      normalizedText: normalizeSearchText(b.plainText),
      textHash: createHash('sha256').update(b.plainText).digest('hex'),
      stableKey: `${sha}:${i}`,
      pageStart: b.pageStart,
      pageEnd: b.pageEnd,
      coordinates: b.coordinates,
      tokenCount: 10,
      language: null,
      sentences: b.sentences.map((s) => ({ blockKey: b.key, order: s.order })),
    }));
}

const indexed: string[] = [];
function deps(over: Partial<IngestionDeps> = {}): IngestionDeps {
  return {
    store,
    limits: DEFAULT_PROCESSING_LIMITS,
    readPdf: async (a) => {
      const b = files.get(a.attachmentId);
      if (!b) throw new Error('missing');
      return b;
    },
    grobid: new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: grobid.url, busyRetryDelayMs: 10, maxRetries: 1 }),
    pymupdf: new PyMuPdfClient(pyConfig),
    segment,
    indexKeywords: (id) => indexed.push(id),
    configuration: () => ({ config: { test: true }, configHash: 'cfg-1' }),
    ...over,
  };
}

function queue(d: IngestionDeps, concurrency = 2, updates: JobRow[] = []) {
  return new IngestionQueue({ store, service: new IngestionService(d), concurrency, configHash: () => 'cfg-1', onUpdate: (j) => updates.push(j) });
}

beforeEach(async () => {
  handle = createDatabase(':memory:');
  store = new DocumentStore(handle.db);
  grobid = await new MockGrobid().start();
  indexed.length = 0;
});
afterEach(async () => {
  await grobid.stop();
  handle.close();
});

describe.skipIf(!pymupdfAvailable)('ingestion pipeline', () => {
  it('extracts with GROBID, keeps the TEI, stores structures and activates the extraction', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const att = addAttachment(textPdf);
    const updates: JobRow[] = [];
    const q = queue(deps(), 2, updates);
    const { job } = q.request(att);
    const done = (await q.wait(job.id))!;
    expect(done.status).toBe('completed');
    const x = store.activeExtraction(att)!;
    expect(x).toMatchObject({ extractor: 'grobid', extractorVersion: '0.8.2', configHash: 'cfg-1', isActive: true, pageCount: 2 });
    expect(x.pages[0]).toMatchObject({ width: 612, height: 792, rotation: 0 });
    expect(x.quality.textCoverage).toBeGreaterThan(0.6);
    expect(store.rawOutput(x.id)).toEqual({ format: 'tei-xml', content: SAMPLE_TEI });
    expect(store.sections(x.id).map((s) => s.sectionPath)).toContain('2 Model › 2.1 Cat codes');
    expect(store.references(x.id)).toHaveLength(2);
    expect(store.elements(x.id).map((e) => e.elementType)).toEqual(['equation', 'figure', 'table']);
    expect(store.passages(x.id).total).toBeGreaterThan(5);
    expect(indexed).toEqual([x.id]);
    expect(updates.map((u) => u.status)).toEqual(expect.arrayContaining(['queued', 'validating', 'extracting', 'normalizing', 'segmenting', 'indexing_keywords', 'completed']));
    const sentence = store.sentencesOf(store.passages(x.id).passages.find((p) => p.text.startsWith('Quantum'))!.id);
    expect(sentence.map((s) => s.text)).toHaveLength(2);
  });

  it('falls back to PyMuPDF when GROBID is unavailable, and says so', async () => {
    await grobid.stop();
    const att = addAttachment(textPdf);
    const q = queue(deps());
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done.status).toBe('partial');
    expect(done.notes.join('\n')).toMatch(/GROBID is not reachable[\s\S]*Fell back to PyMuPDF/);
    const x = store.activeExtraction(att)!;
    expect(x.extractor).toBe('pymupdf');
    expect(x.quality.structure).toBe('layout');
    expect(store.rawOutput(x.id)!.format).toBe('pymupdf-json');
    grobid = await new MockGrobid().start();
  });

  it('marks image-only PDFs as needing OCR without inventing text', async () => {
    grobid.fallback = { status: 204 };
    const att = addAttachment(scanPdf);
    const q = queue(deps());
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done.status).toBe('needs_ocr');
    expect(done.notes.join(' ')).toMatch(/OCR/);
    const x = store.activeExtraction(att)!;
    expect(x.status).toBe('needs_ocr');
    expect(store.passages(x.id).total).toBe(0);
  });

  it('fails an empty PDF permanently instead of calling it a scan', async () => {
    grobid.fallback = { status: 204 };
    const att = addAttachment(makeLayoutPdf([{}, {}]));
    const q = queue(deps());
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'empty', retryable: false });
  });

  it('keeps the existing extraction when reprocessing fails', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const att = addAttachment(textPdf);
    const q1 = queue(deps());
    await q1.wait(q1.request(att).job.id);
    const first = store.activeExtraction(att)!;
    // Second run: GROBID fails permanently and no fallback exists.
    grobid.fallback = { status: 500, body: 'boom' };
    const q2 = queue(deps({ pymupdf: null }));
    const done = (await q2.wait(q2.request(att, 'reprocess').job.id))!;
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'extractor-error' });
    expect(done.previousExtractionId).toBe(first.id);
    expect(store.activeExtraction(att)!.id).toBe(first.id);
    expect(store.passages(first.id).total).toBeGreaterThan(0);
  });

  it('replaces the active extraction after a successful reprocess', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const att = addAttachment(textPdf);
    const q = queue(deps());
    await q.wait(q.request(att).job.id);
    const first = store.activeExtraction(att)!;
    await q.wait(q.request(att, 'reprocess').job.id);
    const second = store.activeExtraction(att)!;
    expect(second.id).not.toBe(first.id);
    expect(store.getExtraction(first.id)).toBeNull();
    expect(store.passage(`${first.id}_p0`)).toBeNull();
  });

  it('removes a new extraction whose indexing failed and fails the job', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const att = addAttachment(textPdf);
    const q = queue(
      deps({
        indexKeywords: () => {
          throw new Error('disk full at /home/someone/data');
        },
      }),
    );
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done.status).toBe('failed');
    expect(done.error!.message).toBe('disk full at [path]');
    expect(store.activeExtraction(att)).toBeNull();
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM document_extractions').get()).toEqual({ n: 0 });
  });

  it('does not start a second job for the same attachment, and refuses non-PDF or missing attachments', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 100 };
    const att = addAttachment(textPdf);
    const q = queue(deps());
    const a = q.request(att);
    const b = q.request(att);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    await q.idle();
    expect(() => q.request('nope')).toThrow(/does not exist/);
  });

  it('cancels queued and running jobs, leaving no half-written extraction', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 300 };
    const a1 = addAttachment(textPdf);
    const a2 = addAttachment(textPdf);
    const q = queue(deps(), 1);
    const j1 = q.request(a1).job;
    const j2 = q.request(a2).job;
    expect(q.cancel(j2.id)!.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 50));
    q.cancel(j1.id);
    expect((await q.wait(j1.id))!.status).toBe('cancelled');
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM document_extractions').get()).toEqual({ n: 0 });
  });

  it('resumes unfinished jobs after a restart and gives up on jobs that keep crashing', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 300 };
    const att = addAttachment(textPdf);
    const q1 = queue(deps());
    const job = q1.request(att).job;
    await new Promise((r) => setTimeout(r, 50));
    await q1.stop(); // runtime shutdown mid-job
    expect(store.getJob(job.id)!.status).toBe('queued');
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const q2 = queue(deps());
    expect(q2.resume()).toBe(1);
    expect((await q2.wait(job.id))!.status).toBe('completed');
    expect(store.getJob(job.id)!.attempts).toBe(2);

    const att2 = addAttachment(textPdf);
    const crashing = store.createJob({ kind: 'process', attachment: store.attachmentInfo(att2)!, configHash: 'cfg-1', previousExtractionId: null });
    handle.sqlite.prepare('UPDATE document_jobs SET attempts = 3, status = ? WHERE id = ?').run('extracting', crashing.id);
    const q3 = queue(deps());
    q3.resume();
    expect((await q3.wait(crashing.id))!).toMatchObject({ status: 'failed', error: { code: 'internal' } });
  });

  it('runs embeddings after keyword indexing and reports their failure without losing the extraction', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const att = addAttachment(textPdf);
    const q = queue(deps({ embed: async () => ({ status: 'failed', message: 'model not found' }) }));
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done.status).toBe('partial');
    expect(done.error).toMatchObject({ code: 'embedding-failed', retryable: true });
    expect(store.activeExtraction(att)).not.toBeNull();
  });

  it('refuses a malformed PDF before any extractor runs', async () => {
    const att = addAttachment(new Uint8Array(Buffer.from('not a pdf at all')));
    const q = queue(deps());
    const done = (await q.wait(q.request(att).job.id))!;
    expect(done).toMatchObject({ status: 'failed', error: { code: 'malformed', retryable: false } });
    expect(grobid.requests).toHaveLength(0);
  });

  it('lists PDF attachments that have not been processed', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI };
    const a = addAttachment(textPdf);
    const b = addAttachment(textPdf);
    expect(store.unprocessedPdfAttachments().map((x) => x.attachmentId)).toEqual([a, b]);
    const q = queue(deps());
    await q.wait(q.request(a).job.id);
    expect(store.unprocessedPdfAttachments().map((x) => x.attachmentId)).toEqual([b]);
  });
});
