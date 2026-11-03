import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportJobRunner } from '../src/imports/import-jobs';
import { importPdf } from '../src/imports/pdf-importer';
import { parseIdentifierList, parseReferences, previewReferences, runIdentifierImport, runReferenceImport } from '../src/imports/reference-import';
import { createTestLibrary, type TestLibrary } from './fixtures/library';
import { makePdf } from './fixtures/make-pdf';
import { fakeWork } from './fixtures/works';

const shor = fakeWork({ title: 'Scheme for reducing decoherence in quantum computer memory', authors: [['Peter W.', 'Shor']], year: 1995, doi: '10.1103/physreva.52.r2493' });
const ekert = fakeWork({ title: 'Quantum cryptography based on Bell theorem', authors: [['Artur K.', 'Ekert']], year: 1991, doi: '10.1103/physrevlett.67.661' });
const attention = fakeWork({ title: 'Attention Is All You Need', authors: [['Ashish', 'Vaswani']], year: 2017, arxivId: '1706.03762' });
const attentionTwin = fakeWork({ id: 'openalex:W2', title: 'Attention Is All You Need', authors: [['Other', 'Person']], year: 2020 });

let t: TestLibrary;
beforeEach(async () => {
  t = await createTestLibrary([shor, ekert, attention, attentionTwin]);
});
afterEach(async () => {
  await t.close();
});

async function receive(bytes: Buffer, name: string) {
  return t.attachments.receive(bytes, { originalFileName: name, declaredType: 'application/pdf', attachmentType: 'pdf' });
}

describe('PDF import', () => {
  it('identifies a PDF by the DOI in its metadata and adds the provider record with the file', async () => {
    const pdf = makePdf({ xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' }, pages: [[{ text: 'Scheme for reducing decoherence', size: 18 }]] });
    const r = await importPdf(t.library, await receive(pdf, 'shor.pdf'));
    expect(r).toMatchObject({ outcome: 'added', confidence: 'exact-doi' });
    const item = await t.library.getItem(r.libraryItemId!);
    expect(item).toMatchObject({ origin: 'pdf', metadataStatus: 'resolved', workId: shor.id });
    expect(item.attachments).toHaveLength(1);
    expect(item.localSource).toMatchObject({ format: 'pdf', fileName: 'shor.pdf' });
    expect(t.lookup.calls).toEqual(['doi:10.1103/physreva.52.r2493']);
  });

  it('accepts a DOI printed in the text only when the title is also in the PDF (a cited DOI is not enough)', async () => {
    const own = makePdf({ pages: [[{ text: 'Scheme for reducing decoherence in quantum computer memory', size: 18 }, { text: 'doi:10.1103/PhysRevA.52.R2493' }]] });
    expect((await importPdf(t.library, await receive(own, 'own.pdf'))).confidence).toBe('exact-doi');

    const citing = makePdf({ pages: [[{ text: 'A survey of entanglement distribution', size: 18 }, { text: '[1] Ekert, doi:10.1103/PhysRevLett.67.661' }]] });
    const r = await importPdf(t.library, await receive(citing, 'survey.pdf'));
    expect(r.outcome).toBe('needs-review');
    const item = await t.library.getItem(r.libraryItemId!);
    expect(item.work.id).toMatch(/^library:/);
    expect(item.work.title).toBe('survey'); // from the file name: the PDF has no metadata title
    expect(item.match?.candidates[0]).toMatchObject({ confidence: 'possible', reasons: [expect.stringMatching(/may be a cited work/)] });
  });

  it('identifies by the arXiv stamp', async () => {
    const pdf = makePdf({ pages: [[{ text: 'arXiv:1706.03762v5 [cs.CL] 6 Dec 2017' }, { text: 'Attention Is All You Need', size: 18 }]] });
    expect(await importPdf(t.library, await receive(pdf, 'a.pdf'))).toMatchObject({ outcome: 'added', confidence: 'exact-arxiv' });
  });

  it('never picks between two works with the same title: the user decides', async () => {
    const pdf = makePdf({ info: { Title: 'Attention Is All You Need' }, pages: [[{ text: 'Attention Is All You Need', size: 18 }]] });
    const r = await importPdf(t.library, await receive(pdf, 'attention.pdf'));
    expect(r.outcome).toBe('needs-review');
    const item = await t.library.getItem(r.libraryItemId!);
    expect(item.match?.candidates.map((c) => c.work.id).sort()).toEqual([attention.id, attentionTwin.id].sort());
    const accepted = await t.library.acceptCandidate(item.id, attention.id);
    expect(accepted.metadataStatus).toBe('resolved');
    expect(accepted.attachments).toHaveLength(1);
  });

  it('keeps an unidentified PDF with only what the file states', async () => {
    const pdf = makePdf({ info: { Title: 'Lecture notes on topological codes', Author: 'J. Doe' }, pages: [[{ text: 'Lecture notes', size: 18 }]] });
    const r = await importPdf(t.library, await receive(pdf, 'notes.pdf'));
    expect(r.outcome).toBe('unresolved');
    const item = await t.library.getItem(r.libraryItemId!);
    expect(item).toMatchObject({ metadataStatus: 'unresolved', origin: 'pdf' });
    expect(item.work).toMatchObject({ title: 'Lecture notes on topological codes', abstract: null, publicationYear: null, venue: null });
    expect(item.work.authors.map((a) => a.name)).toEqual(['J. Doe']);
    expect(item.work.identifiers.doi).toBeNull();
  });

  it('imports without the literature engine and reports why it is unresolved', async () => {
    const offline = await createTestLibrary([], { withLookup: false });
    try {
      const file = await offline.attachments.receive(makePdf({ pages: [[{ text: 'x' }]] }), { originalFileName: 'scan.pdf', attachmentType: 'pdf' });
      const r = await importPdf(offline.library, file);
      expect(r).toMatchObject({ outcome: 'unresolved', message: expect.stringMatching(/not available/) });
    } finally {
      await offline.close();
    }
  });

  it('recognises a file already in the library and an exact match to an existing paper', async () => {
    const pdf = makePdf({ xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' }, pages: [[{ text: 'Scheme', size: 18 }]] });
    const first = await importPdf(t.library, await receive(pdf, 'a.pdf'));
    const again = await importPdf(t.library, await receive(pdf, 'copy.pdf'));
    expect(again).toMatchObject({ outcome: 'duplicate', libraryItemId: first.libraryItemId });
    // A different file of the same paper is attached to the existing item.
    const v2 = makePdf({ xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' }, pages: [[{ text: 'Scheme (accepted version)', size: 18 }]] });
    const other = await importPdf(t.library, await receive(v2, 'accepted.pdf'));
    expect(other).toMatchObject({ outcome: 'attached', libraryItemId: first.libraryItemId });
    expect((await t.library.getItem(first.libraryItemId!)).attachments).toHaveLength(2);
    expect(t.library.query({}).total).toBe(1);
  });

  it('attaches to a chosen item without looking anything up', async () => {
    const { item } = await t.library.addWork(ekert);
    t.lookup.calls = [];
    const r = await importPdf(t.library, await receive(makePdf({ pages: [[{ text: 'x' }]] }), 'ekert.pdf'), { targetItemId: item.id });
    expect(r.outcome).toBe('attached');
    expect(t.lookup.calls).toEqual([]);
  });

  it('records provider failures and still keeps the paper', async () => {
    t.lookup.failWith = Object.assign(new Error('Crossref is not answering'), { code: 'PROVIDER_ERROR' });
    const r = await importPdf(t.library, await receive(makePdf({ xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' }, pages: [[{ text: 'Scheme', size: 18 }]] }), 's.pdf'));
    expect(r.outcome).toBe('unresolved');
    expect(r.message).toMatch(/Crossref is not answering/);
  });
});

describe('BibTeX/RIS import', () => {
  const BIB = `@article{shor95, title={Scheme for reducing decoherence in quantum computer memory}, author={Shor, Peter}, doi={10.1103/PhysRevA.52.R2493}}
@misc{own, title={My unpublished notes}, author={Doe, Jane}, year=2026}
@misc{notitle, author={Nobody}}
@article{broken, title={Unclosed`;

  it('previews new records, duplicates and invalid records without writing', async () => {
    await t.library.addWork(shor);
    const preview = previewReferences(t.library, 'bibtex', BIB);
    expect(preview.entries.map((e) => [e.label, e.state])).toEqual([
      ['shor95', 'duplicate'],
      ['own', 'new'],
      ['notitle', 'invalid'],
    ]);
    expect(preview.warnings[0]).toMatch(/^Line 4:/);
    expect(t.library.query({}).total).toBe(1);
  });

  it('imports the chosen records in a job, resolving DOIs exactly', async () => {
    const runner = new ImportJobRunner(t.repo);
    const refs = parseReferences('bibtex', BIB).references;
    const job = runner.start('bibtex', refs.length, (ctx) => runReferenceImport(t.library, refs, { only: [0, 1, 2], resolveIdentifiers: true, searchTitles: false }, ctx));
    expect(['queued', 'running']).toContain(job.status);
    const done = await runner.wait(job.id);
    expect(done.status).toBe('completed');
    expect(done.items.map((i) => [i.label, i.outcome, i.confidence])).toEqual([
      ['shor95', 'added', 'exact-doi'],
      ['own', 'added', null],
      ['notitle', 'failed', null],
    ]);
    expect(done.processed).toBe(3);
    const shorItem = await t.library.getItem(done.items[0]!.libraryItemId!);
    expect(shorItem).toMatchObject({ citationKey: 'shor95', metadataStatus: 'resolved' });
  });

  it('cancels between records, keeping what was imported', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new ImportJobRunner(t.repo);
    const refs = parseReferences('bibtex', '@misc{a, title={First record here}}\n@misc{b, title={Second record here}}').references;
    const job = runner.start('bibtex', 2, async (ctx) => {
      await runReferenceImport(t.library, refs.slice(0, 1), { resolveIdentifiers: false, searchTitles: false }, ctx);
      await gate;
      await runReferenceImport(t.library, refs.slice(1), { resolveIdentifiers: false, searchTitles: false }, ctx);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.cancel(job.id)).toBe(true);
    release();
    const done = await runner.wait(job.id);
    expect(done.status).toBe('cancelled');
    expect(done.items).toHaveLength(1);
    expect(t.library.query({}).total).toBe(1);
  });

  it('marks jobs interrupted by a restart', () => {
    t.repo.insertJob({ id: 'job_old', kind: 'pdf', status: 'running', total: 5, processed: 2, items: [], warnings: [], createdAt: '2026-11-03T09:00:00.000Z' });
    const runner = new ImportJobRunner(t.repo);
    expect(runner.recoverInterrupted()).toBe(1);
    expect(runner.get('job_old')).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/stopped/) });
  });

  it('adds papers from a list of identifiers', async () => {
    const ids = parseIdentifierList('10.1103/PhysRevA.52.R2493\narXiv:1706.03762, https://doi.org/10.1103/physreva.52.r2493; nonsense 10.5555/missing');
    expect(ids.map((i) => [i.kind, i.value])).toEqual([
      ['doi', '10.1103/physreva.52.r2493'],
      ['arxiv', '1706.03762'],
      ['doi', ''],
      ['doi', '10.5555/missing'],
    ]);
    const runner = new ImportJobRunner(t.repo);
    const job = runner.start('identifiers', ids.length, (ctx) => runIdentifierImport(t.library, ids, undefined, ctx));
    const done = await runner.wait(job.id);
    expect(done.items.map((i) => i.outcome)).toEqual(['added', 'added', 'failed', 'failed']);
  });
});
