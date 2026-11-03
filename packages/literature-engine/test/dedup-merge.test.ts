import { describe, expect, it } from 'vitest';
import { deduplicate } from '../src/deduplication/deduplicate';
import { diceSimilarity, sameWorkByMetadata, titlesMatch } from '../src/deduplication/title-matching';
import { mergeRecords } from '../src/metadata/metadata-merger';
import { canonicalWorkId, parseWorkId, workKeys } from '../src/metadata/work-metadata';
import { ArxivProvider } from '../src/providers/arxiv/client';
import { CrossrefProvider } from '../src/providers/crossref/client';
import { OpenAlexProvider } from '../src/providers/openalex/client';
import { SemanticScholarProvider } from '../src/providers/semantic-scholar/client';
import { ctx, fakeFetch, fixture, json, record, testConfig, xml } from './helpers';

async function recordedShor() {
  const oa = await new OpenAlexProvider(testConfig(fakeFetch([[() => true, json(fixture('openalex/work-doi-physreva.52.r2493.json'))]]).fetch)).getByDoi('x', ctx());
  const cr = await new CrossrefProvider(testConfig(fakeFetch([[() => true, json(fixture('crossref/work-10.1103-physreva.52.r2493.json'))]]).fetch)).getByDoi('x', ctx());
  const s2 = await new SemanticScholarProvider(testConfig(fakeFetch([[() => true, json(fixture('semantic-scholar/paper-doi-physreva.52.r2493.json'))]]).fetch)).getByDoi('x', ctx());
  return { oa: oa!, cr: cr!, s2: s2! };
}

async function recordedAttention() {
  const s2 = await new SemanticScholarProvider(testConfig(fakeFetch([[() => true, json(fixture('semantic-scholar/paper-arxiv-1706.03762.json'))]]).fetch)).getByArxivId({ id: '1706.03762', version: null }, ctx());
  const oa = await new OpenAlexProvider(testConfig(fakeFetch([[() => true, json(fixture('openalex/work-doi-arxiv-1706.03762.json'))]]).fetch)).getByDoi('x', ctx());
  const ax = await new ArxivProvider(testConfig(fakeFetch([[() => true, xml(fixture('arxiv/id-1706.03762v5.xml'))]]).fetch)).getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
  return { oa: oa!, ax: ax!, s2: s2! };
}

describe('title matching', () => {
  it('matches equal and nearly equal titles only', () => {
    expect(titlesMatch('Scheme for reducing decoherence in quantum computer memory.', 'Scheme for Reducing Decoherence in Quantum Computer Memory')).toBe(true);
    expect(titlesMatch('Fault-tolerant quantum computation', 'Fault tolerant quantum computation')).toBe(true);
    expect(titlesMatch('Topological quantum memory', 'Topological quantum memories')).toBe(false); // below the 0.95 similarity bar
    expect(titlesMatch('Quantum error correction with the surface code, part I', 'Quantum error correction with the surface code, part II')).toBe(false);
    expect(titlesMatch('Advances in quantum error correction in 2019', 'Advances in quantum error correction in 2020')).toBe(false);
    expect(titlesMatch('A theory of quantum error-correcting codes', 'A theory of quantum error correcting codes for qudits')).toBe(false);
    expect(diceSimilarity('abc', 'abc')).toBe(1);
  });

  it('needs authors and years to agree as well', () => {
    const a = record('crossref', '1', 'Fault-tolerant quantum computation with local gates', { authorNames: ['Peter Shor'], publicationYear: 1996 });
    expect(sameWorkByMetadata(a, record('openalex', 'W1', 'Fault tolerant quantum computation with local gates', { authorNames: ['P. Shor'], publicationYear: 1997 }))).toBe(true);
    expect(sameWorkByMetadata(a, record('openalex', 'W2', 'Fault-tolerant quantum computation with local gates', { authorNames: ['A. Kitaev'], publicationYear: 1996 }))).toBe(false);
    expect(sameWorkByMetadata(a, record('openalex', 'W3', 'Fault-tolerant quantum computation with local gates', { authorNames: ['P. Shor'], publicationYear: 2005 }))).toBe(false);
    // No authors on one side: never merged on title alone.
    expect(sameWorkByMetadata(a, record('openalex', 'W4', 'Fault-tolerant quantum computation with local gates', { publicationYear: 1996 }))).toBe(false);
  });
});

describe('deduplicate', () => {
  it('merges the recorded Shor records from three providers by DOI', async () => {
    const { oa, cr, s2 } = await recordedShor();
    const groups = deduplicate([oa, cr, s2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((r) => r.provider).sort()).toEqual(['crossref', 'openalex', 'semantic-scholar']);
  });

  it('merges a preprint and its index record by arXiv ID, ignoring versions and the arXiv DOI', async () => {
    const { oa, ax } = await recordedAttention();
    const v1 = record('arxiv', '1706.03762v1', 'Attention Is All You Need', { identifiers: { arxivId: '1706.03762' }, version: 'v1' });
    expect(deduplicate([oa, ax, v1])).toHaveLength(1);
  });

  it('links a journal article to its preprint when one record carries both identifiers', () => {
    const preprint = record('arxiv', '2101.00001v2', 'A result', { identifiers: { arxivId: '2101.00001', doi: '10.1000/journal.1' } });
    const journal = record('crossref', '10.1000/journal.1', 'A result (journal version)', { identifiers: { doi: '10.1000/journal.1' } });
    const index = record('semantic-scholar', 'f'.repeat(40), 'A result', { identifiers: { arxivId: '2101.00001' } });
    expect(deduplicate([journal, preprint, index])).toHaveLength(1);
  });

  it('never merges records with different DOIs, even with identical metadata', () => {
    const article = record('crossref', '10.1000/a', 'Quantum error correction below the surface code threshold', {
      identifiers: { doi: '10.1000/a' },
      authorNames: ['A Author'],
      publicationYear: 2024,
    });
    const erratum = record('crossref', '10.1000/b', 'Quantum error correction below the surface code threshold', {
      identifiers: { doi: '10.1000/b' },
      authorNames: ['A Author'],
      publicationYear: 2024,
    });
    expect(deduplicate([article, erratum])).toHaveLength(2);
  });

  it('does not chain two DOIs together through a record without identifiers', () => {
    const meta = { authorNames: ['A Author'], publicationYear: 2024 };
    const a = record('crossref', '10.1000/a', 'Quantum error correction below the surface code threshold', { ...meta, identifiers: { doi: '10.1000/a' } });
    const bare = record('arxiv', '2408.13687v1', 'Quantum error correction below the surface code threshold', { ...meta, identifiers: { arxivId: null } });
    const b = record('crossref', '10.1000/b', 'Quantum error correction below the surface code threshold', { ...meta, identifiers: { doi: '10.1000/b' } });
    const groups = deduplicate([a, bare, b]);
    expect(groups).toHaveLength(2);
    expect(groups.flat()).toHaveLength(3);
  });

  it('keeps the newest copy of a repeated provider record and preserves first-seen order', () => {
    const old = record('openalex', 'W1', 'First', { retrievedAt: '2026-01-01T00:00:00Z' });
    const fresh = record('openalex', 'W1', 'First (updated)', { retrievedAt: '2026-02-01T00:00:00Z' });
    const other = record('openalex', 'W2', 'Second');
    const groups = deduplicate([old, other, fresh]);
    expect(groups.map((g) => g[0]!.title)).toEqual(['First (updated)', 'Second']);
  });
});

describe('mergeRecords', () => {
  it('applies the precedence tables to the recorded Shor records', async () => {
    const { oa, cr, s2 } = await recordedShor();
    const work = mergeRecords([s2, oa, cr]);
    expect(work.id).toBe('doi:10.1103/physreva.52.r2493');
    // Crossref (publisher-deposited) wins bibliographic fields.
    expect(work.title).toBe('Scheme for reducing decoherence in quantum computer memory');
    expect(work.venue).toBe('Physical Review A');
    expect(work.publisher).toBe('American Physical Society (APS)');
    expect(work.bibliographic).toMatchObject({ volume: '52', issue: '4', pages: 'R2493-R2496' });
    expect(work.bibliographic.issn).toEqual(expect.arrayContaining(['1050-2947', '1094-1622', '0556-2791']));
    expect(work.publicationDate).toBe('1995-10-01');
    expect(work.identifiers).toMatchObject({ doi: '10.1103/physreva.52.r2493', openAlexId: 'W1999706070', semanticScholarId: '067b1059f443e53276d39fc6eddbf273cc103531', pmid: '9912632' });
    // The Crossref author list is enriched from OpenAlex (ORCID, affiliation) and S2 (ID).
    expect(work.authors).toEqual([
      expect.objectContaining({
        name: 'Peter W. Shor',
        familyName: 'Shor',
        orcid: '0000-0003-4626-5648',
        affiliations: ['AT&T (United States)'],
        providerIds: { openalex: 'A5020744800', 'semantic-scholar': '1756931' },
      }),
    ]);
  });

  it('keeps every provider citation count, attributed, and shows OpenAlex first', async () => {
    const { oa, cr, s2 } = await recordedShor();
    const work = mergeRecords([cr, s2, oa]);
    expect(work.citation.citedBySource).toBe('openalex');
    expect(work.citation.citedByCount).toBe(oa.citedByCount);
    expect(work.citation.observations.map((o) => [o.provider, o.citedByCount])).toEqual([
      ['openalex', oa.citedByCount],
      ['semantic-scholar', s2.citedByCount],
      ['crossref', cr.citedByCount],
    ]);
    expect(new Set(work.citation.observations.map((o) => o.citedByCount)).size).toBe(3);
  });

  it('records conflicts instead of hiding them', async () => {
    const { oa, cr, s2 } = await recordedShor();
    const work = mergeRecords([oa, cr, s2]);
    const venue = work.conflicts.find((c) => c.field === 'venue');
    expect(venue).toMatchObject({ chosen: 'crossref' });
    expect(venue!.values.map((v) => v.value)).toContain('Physical Review A. Atomic, Molecular, and Optical Physics');
    // Titles that differ only in punctuation are not a conflict.
    expect(work.conflicts.find((c) => c.field === 'title')).toBeUndefined();
    expect(work.sourceRecords).toHaveLength(3);
  });

  it('prefers the arXiv abstract and dates for a preprint, and its open-access copy', async () => {
    const { oa, ax } = await recordedAttention();
    const work = mergeRecords([oa, ax]);
    expect(work.id).toBe('arxiv:1706.03762');
    expect(work.identifiers.doi).toBeNull();
    expect(work.abstractSource).toBe('arxiv');
    expect(work.dates).toMatchObject({ submitted: '2017-06-12', updated: '2017-12-06' });
    expect(work.urls.abstract).toBe('https://arxiv.org/abs/1706.03762v5');
    expect(work.openAccess.isOpenAccess).toBe(true);
    expect(work.citation.citedBySource).toBe('openalex');
  });

  it('records that Semantic Scholar files the preprint as a conference paper', async () => {
    const { oa, ax, s2 } = await recordedAttention();
    expect(deduplicate([s2, ax, oa])).toHaveLength(1);
    const work = mergeRecords([s2, ax, oa]);
    expect(work.title).toBe('Attention Is All You Need');
    expect(work.publicationType).toBe('preprint');
    const type = work.conflicts.find((c) => c.field === 'publicationType');
    expect(type?.chosen).toBe('openalex');
    expect(type?.values.map((v) => v.provider)).toContain('semantic-scholar');
    expect(work.conflicts.find((c) => c.field === 'venue')?.values.map((v) => v.value)).toContain('Neural Information Processing Systems');
  });

  it('does not let a review label be lost', () => {
    const cr = record('crossref', '10.1/r', 'A review of decoders', { identifiers: { doi: '10.1/r' }, publicationType: 'journal-article' });
    const oa = record('openalex', 'W9', 'A review of decoders', { identifiers: { doi: '10.1/r' }, publicationType: 'review' });
    expect(mergeRecords([cr, oa]).publicationType).toBe('review');
  });

  it('is independent of input order', async () => {
    const { oa, cr, s2 } = await recordedShor();
    const a = mergeRecords([oa, cr, s2]);
    const b = mergeRecords([s2, cr, oa]);
    expect(b).toEqual(a);
  });
});

describe('work IDs', () => {
  it('prefers DOI, then arXiv, then provider IDs', () => {
    const ids = { doi: null, arxivId: null, openAlexId: null, semanticScholarId: null, pmid: null };
    const fallback = { provider: 'openalex' as const, providerId: 'W1' };
    expect(canonicalWorkId({ ...ids, doi: '10.1/x', arxivId: '2101.00001' }, fallback)).toBe('doi:10.1/x');
    expect(canonicalWorkId({ ...ids, doi: '10.48550/arxiv.2101.00001', arxivId: '2101.00001' }, fallback)).toBe('arxiv:2101.00001');
    expect(canonicalWorkId({ ...ids, openAlexId: 'W1', semanticScholarId: 'a'.repeat(40) }, fallback)).toBe('openalex:W1');
    expect(canonicalWorkId({ ...ids, semanticScholarId: 'a'.repeat(40) }, fallback)).toBe(`semantic-scholar:${'a'.repeat(40)}`);
  });

  it('parses canonical IDs and bare identifiers', () => {
    expect(parseWorkId('doi:10.1103/PhysRevA.52.R2493')).toEqual({ scheme: 'doi', value: '10.1103/physreva.52.r2493' });
    expect(parseWorkId('doi:10.48550/arXiv.1706.03762')).toEqual({ scheme: 'arxiv', value: '1706.03762' });
    expect(parseWorkId('arxiv:1706.03762v5')).toEqual({ scheme: 'arxiv', value: '1706.03762' });
    expect(parseWorkId('openalex:W1999706070')).toEqual({ scheme: 'openalex', value: 'W1999706070' });
    expect(parseWorkId('10.1038/nature14539')).toEqual({ scheme: 'doi', value: '10.1038/nature14539' });
    expect(parseWorkId('quant-ph/9605011')).toEqual({ scheme: 'arxiv', value: 'quant-ph/9605011' });
    expect(parseWorkId('doi:garbage')).toBeNull();
    expect(parseWorkId('javascript:alert(1)')).toBeNull();
  });

  it('lists every key a merged work can be found by', async () => {
    const { oa, cr, s2 } = await recordedShor();
    expect(workKeys(mergeRecords([oa, cr, s2]))).toEqual([
      'doi:10.1103/physreva.52.r2493',
      'openalex:W1999706070',
      'semantic-scholar:067b1059f443e53276d39fc6eddbf273cc103531',
    ]);
  });
});
