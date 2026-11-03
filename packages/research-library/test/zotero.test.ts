import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportJobRunner } from '../src/imports/import-jobs';
import { ZoteroClient } from '../src/integrations/zotero/zotero-client';
import { previewZoteroExport, runZoteroExport } from '../src/integrations/zotero/zotero-export';
import { previewZoteroImport, resolveZoteroConflict, runZoteroImport, type ZoteroContext } from '../src/integrations/zotero/zotero-import';
import { extraValues, referenceFromZotero, zoteroDataFromWork, zoteroDate } from '../src/integrations/zotero/zotero-mapper';
import { createTestLibrary, type TestLibrary } from './fixtures/library';
import { makePdf } from './fixtures/make-pdf';
import { MockZotero } from './fixtures/mock-zotero';
import { fakeWork } from './fixtures/works';

const shor = fakeWork({ title: 'Scheme for reducing decoherence in quantum computer memory', authors: [['Peter W.', 'Shor']], year: 1995, doi: '10.1103/physreva.52.r2493', venue: 'Physical Review A', publicationType: 'journal-article' });

describe('Zotero mapping', () => {
  it('reads Zotero items without inventing anything', () => {
    const { reference, tags, collections } = referenceFromZotero(
      {
        key: 'ABCD1234',
        version: 7,
        data: {
          itemType: 'preprint',
          title: 'Attention Is All You Need',
          creators: [
            { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
            { creatorType: 'editor', firstName: 'Ed', lastName: 'Itor' },
            { creatorType: 'author', name: 'Google Brain' },
          ],
          repository: 'arXiv',
          archiveID: 'arXiv:1706.03762',
          date: '2017-06-12',
          extra: 'Citation Key: vaswani2017\nOther: x',
          tags: [{ tag: 'transformers' }, { tag: 'nlp', type: 1 }],
          collections: ['COLL0001'],
        },
      },
      'users/4242',
    );
    expect(reference).toMatchObject({
      origin: 'zotero',
      title: 'Attention Is All You Need',
      authors: [
        { givenName: 'Ashish', familyName: 'Vaswani', name: null },
        { givenName: null, familyName: null, name: 'Google Brain' },
      ],
      arxivId: '1706.03762',
      publicationDate: '2017-06-12',
      publicationYear: 2017,
      publisher: 'arXiv',
      publicationType: 'preprint',
      citationKey: 'vaswani2017',
      doi: null,
      abstract: null,
      venue: null,
    });
    expect(reference.localSource).toMatchObject({ format: 'zotero', key: 'ABCD1234', version: 7 });
    expect(tags).toEqual(['transformers', 'nlp']);
    expect(collections).toEqual(['COLL0001']);
  });

  it('reads free-text dates and the extra field', () => {
    expect(zoteroDate('June 2017')).toEqual({ date: '2017', year: 2017 });
    expect(zoteroDate('2017-6-3')).toEqual({ date: '2017-06-03', year: 2017 });
    expect(zoteroDate('n.d.')).toEqual({ date: null, year: null });
    expect(extraValues('DOI: 10.1/x\narXiv: 2101.00001')).toEqual({ doi: '10.1/x', arxiv: '2101.00001' });
  });

  it('writes only fields the item type has', () => {
    const data = zoteroDataFromWork(shor, { citationKey: 'shor95', tags: ['qec'], collections: [] });
    expect(data).toMatchObject({ itemType: 'journalArticle', publicationTitle: 'Physical Review A', DOI: '10.1103/physreva.52.r2493', citationKey: 'shor95', tags: [{ tag: 'qec' }] });
    const preprint = zoteroDataFromWork(fakeWork({ title: 'X', arxivId: '2101.00001', publicationType: 'preprint' }), { citationKey: null, tags: [], collections: [] });
    expect(preprint).toMatchObject({ itemType: 'preprint', repository: 'arXiv', archiveID: 'arXiv:2101.00001' });
    expect(preprint).not.toHaveProperty('publicationTitle');
    expect(preprint).not.toHaveProperty('abstractNote');
  });
});

describe('Zotero web API (mock server)', () => {
  let t: TestLibrary;
  let z: MockZotero;
  let ctx: ZoteroContext;
  let runner: ImportJobRunner;
  const pdf = makePdf({ pages: [[{ text: 'Shor 1995', size: 16 }]] });

  beforeEach(async () => {
    t = await createTestLibrary([shor]);
    z = new MockZotero();
    await z.start();
    const client = new ZoteroClient({ mode: 'web', baseUrl: z.baseUrl, apiKey: z.apiKey, sleep: async () => {} });
    ctx = { library: t.library, collections: t.collections, client, userId: z.userId, libraryId: `users/${z.userId}` };
    runner = new ImportJobRunner(t.repo);
  });
  afterEach(async () => {
    await z.stop();
    await t.close();
  });

  const importAll = async (opts: Partial<Parameters<typeof runZoteroImport>[1]> = {}) => {
    const job = runner.start('zotero', 0, (j) => runZoteroImport(ctx, { importCollections: true, importPdfs: true, resolveIdentifiers: true, ...opts }, j));
    return runner.wait(job.id);
  };

  it('checks the key without exposing it', async () => {
    expect(await ctx.client.keyInfo()).toEqual({ userId: '4242', username: 'tester', canRead: true, canWrite: true, canReadFiles: true });
    const bad = new ZoteroClient({ mode: 'web', baseUrl: z.baseUrl, apiKey: 'wrong', sleep: async () => {} });
    await expect(bad.keyInfo()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('previews, then imports items, collections and PDFs, resolving DOIs exactly', async () => {
    const coll = z.addCollection('Quantum');
    const sub = z.addCollection('Codes', coll);
    const a = z.addItem({ itemType: 'journalArticle', title: shor.title, DOI: '10.1103/PhysRevA.52.R2493', creators: [{ creatorType: 'author', firstName: 'P.', lastName: 'Shor' }], collections: [sub], tags: [{ tag: 'qec' }] });
    z.addPdf(a.key, pdf, 'Shor 1995.pdf');
    z.addItem({ itemType: 'book', title: 'My own book', creators: [{ creatorType: 'author', name: 'A Lab' }], date: '2020' });
    z.addItem({ itemType: 'note', note: 'ignored' } as never);

    const preview = await previewZoteroImport(ctx);
    expect(preview.items.map((i) => [i.title, i.state, i.hasPdf])).toEqual([
      [shor.title, 'new', true],
      ['My own book', 'new', false],
    ]);
    expect(preview.collections.map((c) => c.name)).toEqual(['Quantum', 'Quantum › Codes']);
    expect(t.library.query({}).total).toBe(0);

    const done = await importAll();
    expect(done.status).toBe('completed');
    expect(done.items.map((i) => [i.outcome, i.confidence])).toEqual([
      ['added', 'exact-doi'],
      ['added', null],
    ]);
    const item = await t.library.getItem(done.items[0]!.libraryItemId!);
    expect(item).toMatchObject({ origin: 'zotero', metadataStatus: 'resolved', tags: ['qec'] });
    expect(item.collections.map((c) => c.name)).toEqual(['Quantum › Codes']);
    expect(item.attachments).toMatchObject([{ originalFileName: 'Shor 1995.pdf', source: 'zotero' }]);
    expect(item.external).toMatchObject([{ provider: 'zotero', externalItemId: a.key, externalVersion: a.version, syncStatus: 'synced' }]);
    // The key never appears in anything the library stores.
    expect(JSON.stringify(await t.library.items(t.repo.allItemIds()))).not.toContain(z.apiKey);

    // A second import changes nothing.
    const again = await importAll();
    expect(again.items.map((i) => i.outcome)).toEqual(['skipped', 'skipped']);
    expect((await t.library.getItem(item.id)).attachments).toHaveLength(1);
  });

  it('links Zotero items to papers already in the library instead of duplicating them', async () => {
    const existing = (await t.library.addWork(shor)).item.id;
    z.addItem({ itemType: 'journalArticle', title: shor.title, DOI: '10.1103/physreva.52.r2493' });
    expect((await previewZoteroImport(ctx)).items[0]).toMatchObject({ state: 'duplicate', libraryItemId: existing });
    const done = await importAll();
    expect(done.items[0]).toMatchObject({ outcome: 'duplicate', libraryItemId: existing });
    expect(t.library.query({}).total).toBe(1);
    expect((await t.library.getItem(existing)).external).toHaveLength(1);
  });

  it('applies remote changes, and detects conflicts when both sides changed', async () => {
    const a = z.addItem({ itemType: 'book', title: 'Draft title of the book', date: '2020' });
    const b = z.addItem({ itemType: 'book', title: 'Another book entirely', date: '2021' });
    await importAll({ resolveIdentifiers: false });
    const [ia, ib] = [t.repo.linkByExternal('zotero', ctx.libraryId, a.key)!.libraryItemId, t.repo.linkByExternal('zotero', ctx.libraryId, b.key)!.libraryItemId];

    z.editItem(a.key, { title: 'Final title of the book' });
    z.editItem(b.key, { title: 'Another book, retitled in Zotero' });
    await t.library.update(ib, { edits: { title: 'Another book, retitled here' } });

    const preview = await previewZoteroImport(ctx);
    expect(preview.items.map((i) => i.state)).toEqual(['remote-changes', 'conflict']);
    const done = await importAll({ resolveIdentifiers: false });
    expect(done.items.map((i) => i.outcome)).toEqual(['updated', 'conflict']);
    expect((await t.library.getItem(ia)).work.title).toBe('Final title of the book');
    const conflicted = await t.library.getItem(ib);
    expect(conflicted.work.title).toBe('Another book, retitled here');
    expect(conflicted.external[0]).toMatchObject({ syncStatus: 'conflict', conflict: { fields: [{ field: 'title', local: 'Another book, retitled here', remote: 'Another book, retitled in Zotero' }] } });

    // Keep the local version: the next export sends it.
    await resolveZoteroConflict(ctx, ib, 'local');
    expect(await previewZoteroExport(ctx, [ib])).toMatchObject([{ action: 'update' }]);
    const exported = await runner.wait(runner.start('zotero', 1, (j) => runZoteroExport(ctx, [ib], j)).id);
    expect(exported.items[0]).toMatchObject({ outcome: 'updated' });
    expect(z.items.get(b.key)!.data.title).toBe('Another book, retitled here');
  });

  it('exports new papers to Zotero, and refuses to overwrite changes made in Zotero', async () => {
    const id = (await t.library.addWork(shor, { tags: ['qec'] })).item.id;
    expect(await previewZoteroExport(ctx, [id])).toMatchObject([{ action: 'create', externalItemId: null }]);
    const done = await runner.wait(runner.start('zotero', 1, (j) => runZoteroExport(ctx, [id], j)).id);
    expect(done.items[0]).toMatchObject({ outcome: 'added' });
    const link = t.repo.linkByItem('zotero', ctx.libraryId, id)!;
    expect(z.items.get(link.externalItemId)!.data).toMatchObject({ itemType: 'journalArticle', title: shor.title, DOI: '10.1103/physreva.52.r2493', tags: [{ tag: 'qec' }] });
    expect(await previewZoteroExport(ctx, [id])).toMatchObject([{ action: 'unchanged' }]);

    // Edited on both sides: not exported.
    z.editItem(link.externalItemId, { title: 'Edited in Zotero' });
    await t.library.update(id, { edits: { pages: 'R2493' } });
    expect(await previewZoteroExport(ctx, [id])).toMatchObject([{ action: 'conflict' }]);
    const second = await runner.wait(runner.start('zotero', 1, (j) => runZoteroExport(ctx, [id], j)).id);
    expect(second.items[0]).toMatchObject({ outcome: 'conflict' });
    expect(z.items.get(link.externalItemId)!.data.title).toBe('Edited in Zotero');
  });

  it('retries after 429, and pages through large libraries', async () => {
    for (let i = 0; i < 230; i++) z.addItem({ itemType: 'document', title: `Item number ${i}` });
    z.rateLimitNext = 2;
    const { items } = await ctx.client.items(z.userId);
    expect(items).toHaveLength(230);
    expect(z.requests.filter((r) => r.startsWith('GET /users/4242/items')).length).toBe(5); // 2 refused + 3 pages
  });

  it('cannot write through a read-only key', async () => {
    z.canWrite = false;
    expect((await ctx.client.keyInfo()).canWrite).toBe(false);
    const id = (await t.library.addWork(shor)).item.id;
    const done = await runner.wait(runner.start('zotero', 1, (j) => runZoteroExport(ctx, [id], j)).id);
    expect(done).toMatchObject({ status: 'failed', error: expect.stringMatching(/does not allow/) });
  });

  it('refuses local-API addresses that are not on this computer, and writes through the local API', async () => {
    expect(() => new ZoteroClient({ mode: 'local', baseUrl: 'http://example.org:23119/api' })).toThrow(/on this computer/);
    const local = new ZoteroClient({ mode: 'local', baseUrl: 'http://127.0.0.1:1/api' });
    await expect(local.createItems('0', [])).rejects.toThrow(/read-only/);
    await expect(local.ping()).rejects.toThrow(/Start Zotero/);
  });
});
