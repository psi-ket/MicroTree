import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importBibtex } from '../src/imports/bibtex-importer';
import { emptyReference } from '../src/library/library-types';
import { resolveReference } from '../src/metadata/metadata-resolver';
import { createTestLibrary, type TestLibrary } from './fixtures/library';
import { fakeWork } from './fixtures/works';

const shor = fakeWork({
  title: 'Scheme for reducing decoherence in quantum computer memory',
  authors: [['Peter W.', 'Shor']],
  year: 1995,
  doi: '10.1103/physreva.52.r2493',
  venue: 'Physical Review A',
  publicationType: 'journal-article',
});
const attention = fakeWork({ title: 'Attention Is All You Need', authors: [['Ashish', 'Vaswani'], ['Noam', 'Shazeer']], year: 2017, arxivId: '1706.03762', publicationType: 'preprint' });
const steane = fakeWork({ title: 'Error Correcting Codes in Quantum Theory', authors: [['Andrew', 'Steane']], year: 1996, doi: '10.1103/physrevlett.77.793' });

let t: TestLibrary;
beforeEach(async () => {
  t = await createTestLibrary([shor, attention, steane]);
});
afterEach(async () => {
  await t.close();
});

describe('adding papers', () => {
  it('adds a search result once; adding it again returns the same item', async () => {
    const first = await t.library.addWork(shor, { tags: ['QEC'], readingStatus: 'important' });
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({ origin: 'providers', metadataStatus: 'resolved', citationKey: 'shor1995scheme', readingStatus: 'important', tags: ['QEC'] });
    expect(first.item.work.id).toBe('doi:10.1103/physreva.52.r2493');
    const again = await t.library.addWork(shor);
    expect(again).toMatchObject({ created: false, duplicateReason: 'Already in the library' });
    expect(again.item.id).toBe(first.item.id);
    expect(t.library.query({}).total).toBe(1);
  });

  it('adds by DOI and arXiv ID through the literature engine, and recognises papers already present', async () => {
    const a = await t.library.addByIdentifier('arxiv', 'https://arxiv.org/abs/1706.03762v5');
    expect(a.item.work.identifiers.arxivId).toBe('1706.03762');
    expect(t.lookup.calls).toEqual(['arxiv:1706.03762']);
    const b = await t.library.addByIdentifier('arxiv', 'arXiv:1706.03762');
    expect(b.created).toBe(false);
    expect(t.lookup.calls).toHaveLength(1); // no second provider call
    await expect(t.library.addByIdentifier('doi', 'not a doi')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.library.addByIdentifier('doi', '10.5555/unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('imports a BibTeX record as is when no provider confirms it, keeping the key and extra fields', async () => {
    const { references } = importBibtex('@article{mine2024, title={A Study of Things}, author={Doe, Jane}, year=2024, mynote={kept}}');
    const r = await t.library.addReference(references[0]!, null);
    expect(r.item).toMatchObject({ origin: 'bibtex', metadataStatus: 'manual', citationKey: 'mine2024', bibtexType: 'article' });
    expect(r.item.work.id).toMatch(/^library:wrk_/);
    expect(r.item.bibtexExtra).toEqual([{ name: 'mynote', value: 'kept' }]);
    expect(r.item.localSource).toMatchObject({ format: 'bibtex', key: 'mine2024' });
    // Nothing invented.
    expect(r.item.work).toMatchObject({ abstract: null, venue: null, publicationDate: '2024' }); // the year only
    expect(r.item.work.identifiers.doi).toBeNull();
  });

  it('uses the provider work for a record whose DOI resolves exactly, keeping the record as provenance', async () => {
    const { references } = importBibtex('@article{shor95, title={Scheme for reducing decoherence in quantum computer memory}, author={Shor, P.}, doi={10.1103/PhysRevA.52.R2493}, groups={x}}');
    const ref = references[0]!;
    const outcome = await resolveReference(ref, t.lookup, { searchTitle: false });
    expect(outcome.confidence).toBe('exact-doi');
    const r = await t.library.addReference(ref, outcome);
    expect(r.item).toMatchObject({ origin: 'bibtex', metadataStatus: 'resolved', citationKey: 'shor95' });
    expect(r.item.work.id).toBe(shor.id);
    expect(r.item.work.venue).toBe('Physical Review A');
    expect(r.item.bibtexExtra).toEqual([{ name: 'groups', value: 'x' }]);
    expect(r.item.localSource).toMatchObject({ key: 'shor95' });
  });

  it('does not attach an ambiguous title match: the item waits for review with its candidates', async () => {
    const ref = { ...emptyReference('ris'), title: 'Attention Is All You Need', authors: [{ givenName: 'X.', familyName: 'Someone', name: null }] };
    const outcome = await resolveReference(ref, t.lookup, { searchTitle: true });
    expect(outcome.automatic).toBeNull();
    expect(outcome.confidence).toBe('possible');
    const r = await t.library.addReference(ref, outcome);
    expect(r.item.metadataStatus).toBe('needs-review');
    expect(r.item.work.id).toMatch(/^library:/);
    expect(r.item.match?.candidates.map((c) => c.work.id)).toEqual([attention.id]);
    const accepted = await t.library.acceptCandidate(r.item.id, attention.id);
    expect(accepted).toMatchObject({ metadataStatus: 'resolved', workId: attention.id });
    expect(accepted.match?.decidedAt).not.toBeNull();
    expect(accepted.localSource).toEqual(ref.localSource);
  });

  it('refuses candidates the runtime did not find', async () => {
    const r = await t.library.addReference({ ...emptyReference('manual'), title: 'Something else entirely' }, null);
    await expect(t.library.acceptCandidate(r.item.id, shor.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports likely duplicates without merging them', async () => {
    await t.library.addWork(shor);
    const ref = { ...emptyReference('bibtex'), title: 'Scheme for reducing decoherence in quantum computer memory', authors: [{ givenName: 'P.', familyName: 'Shor', name: null }], publicationYear: 1995 };
    const r = await t.library.addReference(ref, null);
    expect(r.created).toBe(true);
    expect(r.likelyDuplicates).toHaveLength(1);
    expect(r.likelyDuplicates[0]!.reason).toMatch(/Same title and first author and year/);
    expect(t.library.duplicateGroups()).toHaveLength(1);
  });

  it('generates unique keys and replaces unusable or taken requested keys with a notice', async () => {
    const a = await t.library.addReference({ ...emptyReference('manual'), title: 'Quantum things', authors: [{ givenName: 'A', familyName: 'Smith', name: null }], publicationYear: 2025 }, null);
    const b = await t.library.addReference({ ...emptyReference('manual'), title: 'Quantum stuff', authors: [{ givenName: 'B', familyName: 'Smith', name: null }], publicationYear: 2025 }, null);
    expect([a.item.citationKey, b.item.citationKey]).toEqual(['smith2025quantum', 'smith2025quantuma']);
    const c = await t.library.addReference({ ...emptyReference('manual'), title: 'Other', citationKey: 'SMITH2025QUANTUM' }, null);
    expect(c.item.citationKey).not.toBe('SMITH2025QUANTUM');
    expect(c.notices[0]).toMatch(/already used/);
  });

  it('refuses an item without a title', async () => {
    await expect(t.library.addReference(emptyReference('manual'), null)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('editing', () => {
  it('keeps corrections apart from the source metadata, can undo them, and keeps them across a refresh', async () => {
    const { item } = await t.library.addWork(shor);
    const edited = await t.library.update(item.id, { edits: { title: 'Scheme for reducing decoherence (corrected)', pages: 'R2493' } });
    expect(edited.work.title).toBe('Scheme for reducing decoherence (corrected)');
    expect(edited.edits).toEqual({ title: 'Scheme for reducing decoherence (corrected)', pages: 'R2493' });
    expect(t.library.query({ q: 'corrected' }).total).toBe(1);
    const refreshed = await t.library.refresh(item.id);
    expect(refreshed.work.title).toBe('Scheme for reducing decoherence (corrected)');
    const reverted = await t.library.update(item.id, { revertFields: ['title'] });
    expect(reverted.work.title).toBe(shor.title);
    expect(reverted.edits).toEqual({ pages: 'R2493' });
  });

  it('refuses a corrected DOI that another item already has', async () => {
    await t.library.addWork(shor);
    const { item } = await t.library.addWork(steane);
    await expect(t.library.update(item.id, { edits: { doi: 'https://doi.org/10.1103/PhysRevA.52.R2493' } })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('never changes the reading status when an item is opened', async () => {
    const { item } = await t.library.addWork(shor);
    t.library.markOpened(item.id);
    const after = await t.library.getItem(item.id);
    expect(after.readingStatus).toBe('to-read');
    expect(after.lastOpenedAt).not.toBeNull();
    expect(t.library.overview().recentlyOpened.map((s) => s.id)).toEqual([item.id]);
  });

  it('archives, favourites and tags in bulk', async () => {
    const a = (await t.library.addWork(shor)).item.id;
    const b = (await t.library.addWork(steane)).item.id;
    await t.library.bulk([a, b], { kind: 'add-tags', tags: ['qec', 'QEC', 'codes'] });
    expect((await t.library.getItem(a)).tags).toEqual(['codes', 'qec']);
    await t.library.bulk([a], { kind: 'archive', value: true });
    expect(t.library.query({}).items.map((i) => i.id)).toEqual([b]);
    expect(t.library.query({ archived: 'archived' }).items.map((i) => i.id)).toEqual([a]);
    await t.library.bulk([b], { kind: 'favorite', value: true });
    expect(t.library.overview()).toMatchObject({ total: 1, archived: 1, favorites: 1 });
    await expect(t.library.bulk([a, 'missing'], { kind: 'favorite', value: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('citation keys', () => {
  it('needs confirmation to change a key that a project may cite', async () => {
    const { item } = await t.library.addWork(shor);
    const project = t.addProject('Thesis');
    t.repo.linkProject(project, [item.id], () => 'plk_1', '2026-11-03T10:00:00.000Z');
    await expect(t.library.setCitationKey(item.id, 'shor95')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'KEY_IN_USE' } });
    expect((await t.library.setCitationKey(item.id, 'shor95', true)).citationKey).toBe('shor95');
  });

  it('refuses taken keys with a free suggestion', async () => {
    await t.library.addWork(shor);
    const { item } = await t.library.addWork(steane);
    await expect(t.library.setCitationKey(item.id, 'Shor1995Scheme')).rejects.toMatchObject({ code: 'ALREADY_EXISTS', details: { suggestion: 'Shor1995Schemea' } });
    await expect(t.library.setCitationKey(item.id, 'has space')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('regenerates keys in a new format but keeps keys of items linked to projects', async () => {
    const a = (await t.library.addWork(shor)).item.id;
    const b = (await t.library.addWork(steane)).item.id;
    t.repo.linkProject(t.addProject('Paper'), [a], () => 'plk_2', '2026-11-03T10:00:00.000Z');
    t.prefs.citationKeyFormat = 'author-year';
    const res = t.library.regenerateCitationKeys([a, b], true);
    expect(res.changed).toEqual([{ id: b, from: 'steane1996error', to: 'steane1996' }]);
    expect(res.kept).toEqual([a]);
    // Already in the current format: nothing to do.
    expect(t.library.regenerateCitationKeys([b], true).changed).toEqual([]);
  });
});

describe('collections', () => {
  it('creates, renames, moves papers between collections and deletes without losing papers', async () => {
    const a = (await t.library.addWork(shor)).item.id;
    const b = (await t.library.addWork(steane)).item.id;
    const reading = t.collections.create({ name: 'Reading group', color: '#336699' });
    const thesis = t.collections.create({ name: 'Thesis' });
    expect(() => t.collections.create({ name: 'reading GROUP' })).toThrow(/already exists/);
    t.collections.addItems(reading.id, [a, b]);
    expect(t.collections.get(reading.id).itemCount).toBe(2);
    t.collections.moveItems(reading.id, thesis.id, [a]);
    expect(t.library.query({ collectionId: thesis.id }).items.map((i) => i.id)).toEqual([a]);
    expect(t.library.query({ collectionId: reading.id }).items.map((i) => i.id)).toEqual([b]);
    t.collections.update(thesis.id, { name: 'PhD thesis' });
    t.collections.delete(thesis.id);
    expect(t.library.query({}).total).toBe(2);
    expect((await t.library.getItem(a)).collections).toEqual([]);
  });
});

describe('search, filters and sorting', () => {
  it('filters by text, author, year, status and sorts by year and title', async () => {
    const a = (await t.library.addWork(shor)).item.id;
    const b = (await t.library.addWork(attention)).item.id;
    const c = (await t.library.addWork(steane, { readingStatus: 'read' })).item.id;
    expect(t.library.query({ q: 'decoherence memory' }).items.map((i) => i.id)).toEqual([a]);
    expect(t.library.query({ q: '1706.03762' }).items.map((i) => i.id)).toEqual([b]);
    expect(t.library.query({ q: 'steane1996error' }).items.map((i) => i.id)).toEqual([c]);
    expect(t.library.query({ author: 'shazeer' }).items.map((i) => i.id)).toEqual([b]);
    expect(t.library.query({ yearFrom: 1996 }).items.map((i) => i.id).sort()).toEqual([b, c].sort());
    expect(t.library.query({ readingStatus: 'read' }).items.map((i) => i.id)).toEqual([c]);
    expect(t.library.query({ sort: 'year-asc' }).items.map((i) => i.year)).toEqual([1995, 1996, 2017]);
    expect(t.library.query({ sort: 'title-asc' }).items.map((i) => i.title[0])).toEqual(['A', 'E', 'S']);
    expect(t.library.query({ q: '100%_' }).total).toBe(0);
    const project = t.addProject('Thesis');
    t.repo.linkProject(project, [b], () => 'plk_q', '2026-11-03T10:00:00.000Z');
    expect(t.library.query({ projectId: project }).items.map((i) => i.id)).toEqual([b]);
    expect(t.library.query({ hasPdf: false }).total).toBe(3);
  });
});

describe('merging and deleting', () => {
  it('merges a duplicate into the item to keep', async () => {
    const keep = (await t.library.addWork(shor, { tags: ['a'] })).item.id;
    const dupRef = { ...emptyReference('bibtex'), title: shor.title, citationKey: 'old95', authors: [{ givenName: 'P', familyName: 'Shor', name: null }] };
    const drop = (await t.library.addReference(dupRef, null, { tags: ['b'], notes: 'from the old library' })).item.id;
    const col = t.collections.create({ name: 'C' });
    t.collections.addItems(col.id, [drop]);
    const { item, droppedKey } = await t.library.merge(keep, drop);
    expect(droppedKey).toBe('old95');
    expect(item.tags).toEqual(['a', 'b']);
    expect(item.collections.map((c) => c.id)).toEqual([col.id]);
    expect(item.notes).toBe('from the old library');
    expect(t.library.query({}).total).toBe(1);
  });

  it('reports what a deletion affects and removes items, works and unused tags', async () => {
    const a = (await t.library.addWork(shor, { tags: ['only-here'] })).item.id;
    const project = t.addProject('Thesis');
    t.repo.linkProject(project, [a], () => 'plk_3', '2026-11-03T10:00:00.000Z');
    expect(t.library.deletionImpact([a])).toEqual({ items: 1, attachments: 0, projects: [{ id: project, name: 'Thesis', items: 1 }], externalLinks: 0 });
    expect(await t.library.deleteItems([a])).toBe(1);
    expect(t.library.query({ archived: 'all' }).total).toBe(0);
    expect(t.repo.findWorkByDoi(shor.identifiers.doi!)).toBeNull();
    expect(t.repo.listTags()).toEqual([]);
    // The same paper can be added again afterwards.
    expect((await t.library.addWork(shor)).created).toBe(true);
  });
});

describe('export', () => {
  it('exports the whole library, a collection or a project as BibTeX and RIS', async () => {
    const a = (await t.library.addWork(shor)).item.id;
    await t.library.addWork(attention);
    const col = t.collections.create({ name: 'QEC' });
    t.collections.addItems(col.id, [a]);
    const all = t.library.exportBibtex({ all: true });
    expect(all.count).toBe(2);
    expect(all.text).toMatch(/@article\{shor1995scheme,/);
    expect(all.text).toMatch(/@misc\{vaswani2017attention,/);
    const one = t.library.exportBibtex({ collectionId: col.id });
    expect(one.count).toBe(1);
    expect(importBibtex(one.text).references[0]!.doi).toBe('10.1103/physreva.52.r2493');
    expect(t.library.exportRis({ itemIds: [a] }).text).toMatch(/^TY {2}- JOUR/m);
  });

  it('works without the literature engine, except for lookups', async () => {
    const offline = await createTestLibrary([], { withLookup: false });
    try {
      const r = await offline.library.addReference({ ...emptyReference('manual'), title: 'Offline entry' }, null);
      expect(r.created).toBe(true);
      await expect(offline.library.addByIdentifier('doi', '10.1103/physreva.52.r2493')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    } finally {
      await offline.close();
    }
  });
});
