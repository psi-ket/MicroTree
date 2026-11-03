import { describe, expect, it } from 'vitest';
import { LiteratureProviderError } from '../src/errors/provider-errors';
import { ArxivProvider, buildArxivQuery } from '../src/providers/arxiv/client';
import { parseXml, XmlError } from '../src/providers/arxiv/xml';
import { CrossrefProvider } from '../src/providers/crossref/client';
import { crossrefType } from '../src/providers/crossref/mapper';
import { CROSSREF_SELECT } from '../src/providers/crossref/schemas';
import { OpenAlexProvider } from '../src/providers/openalex/client';
import { abstractFromInvertedIndex } from '../src/providers/openalex/mapper';
import { SemanticScholarProvider } from '../src/providers/semantic-scholar/client';
import type { ProviderSearchQuery } from '../src/types/provider';
import { ctx, fakeFetch, fixture, json, testConfig, xml } from './helpers';

const query = (patch: Partial<ProviderSearchQuery> = {}): ProviderSearchQuery => ({
  text: 'quantum error correction',
  mode: 'all',
  filters: {},
  sort: 'relevance',
  pageSize: 3,
  position: null,
  ...patch,
});

async function failure(p: Promise<unknown>): Promise<LiteratureProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LiteratureProviderError) return err;
    throw err;
  }
  throw new Error('expected a provider error');
}

describe('OpenAlex', () => {
  const routes = () =>
    fakeFetch([
      [(u) => u.pathname === '/works/doi:10.1103/physreva.52.r2493', json(fixture('openalex/work-doi-physreva.52.r2493.json'))],
      [(u) => u.pathname === '/works/doi:10.48550/arxiv.1706.03762', json(fixture('openalex/work-doi-arxiv-1706.03762.json'))],
      [(u) => u.pathname === '/works/W1999706070', json(fixture('openalex/work-doi-physreva.52.r2493.json'))],
      [(u) => u.pathname.startsWith('/works/'), json(fixture('openalex/not-found.json'), 404)],
      [(u) => u.pathname === '/authors/A5020744800', json(fixture('openalex/author-A5020744800.json'))],
      [(u) => u.pathname === '/works' && (u.searchParams.get('filter') ?? '').startsWith('cites:'), json(fixture('openalex/cites-W1999706070.json'))],
      [(u) => u.pathname === '/works', json(fixture('openalex/search-quantum-error-correction.json'))],
    ]);

  it('maps a recorded work (Shor 1995)', async () => {
    const p = new OpenAlexProvider(testConfig(routes().fetch));
    const r = await p.getByDoi('10.1103/physreva.52.r2493', ctx());
    expect(r).toMatchObject({
      provider: 'openalex',
      providerId: 'W1999706070',
      title: 'Scheme for reducing decoherence in quantum computer memory',
      publicationYear: 1995,
      venue: 'Physical Review A',
      publicationType: 'journal-article',
      identifiers: { doi: '10.1103/physreva.52.r2493', openAlexId: 'W1999706070', pmid: '9912632', arxivId: null },
      bibliographic: { volume: '52', issue: '4', pages: 'R2493-R2496' },
      openAccess: { isOpenAccess: false },
    });
    expect(r!.dates.published).toBe('1995-10-01');
    expect(r!.authors[0]).toMatchObject({ name: 'Peter W. Shor', orcid: '0000-0003-4626-5648', providerIds: { openalex: 'A5020744800' } });
    expect(r!.abstract).toMatch(/^Recently, it was realized/);
    expect(r!.citedByCount).toBeGreaterThan(0);
  });

  it('recognises arXiv works by their DataCite DOI', async () => {
    const p = new OpenAlexProvider(testConfig(routes().fetch));
    const r = await p.getByArxivId({ id: '1706.03762', version: null }, ctx());
    expect(r).toMatchObject({ title: 'Attention Is All You Need', publicationType: 'preprint', identifiers: { arxivId: '1706.03762' } });
  });

  it('returns null for an unknown work and its own ID lookups', async () => {
    const p = new OpenAlexProvider(testConfig(routes().fetch));
    await expect(p.getByDoi('10.5555/does-not-exist', ctx())).resolves.toBeNull();
    await expect(p.getById('W1999706070', ctx())).resolves.toMatchObject({ providerId: 'W1999706070' });
    await expect(p.getById('not-an-id', ctx())).resolves.toBeNull();
  });

  it('builds search requests from modes, filters and sorts', async () => {
    const f = routes();
    const p = new OpenAlexProvider(testConfig(f.fetch, { apiKey: 'OA-KEY' }));
    const page = await p.search(
      query({
        mode: 'title',
        filters: { yearFrom: 2010, yearTo: 2020, openAccessOnly: true, publicationTypes: ['review'], categories: ['quant-ph'], authors: ['Shor'] },
        sort: 'newest',
      }),
      ctx(),
    );
    const u = f.calls[0]!.url;
    expect(u.searchParams.get('search')).toBeNull();
    expect(u.searchParams.get('filter')).toBe(
      'title.search:quantum error correction,raw_author_name.search:Shor,publication_year:2010-2020,is_oa:true,type:review,primary_topic.field.id:fields/31',
    );
    expect(u.searchParams.get('sort')).toBe('publication_date:desc');
    expect(u.searchParams.get('per_page')).toBe('3');
    expect(u.searchParams.get('api_key')).toBe('OA-KEY');
    expect(page.notes).toEqual(['Categories approximated by OpenAlex fields: Physics']);
    // The key never reaches stored records.
    expect(JSON.stringify(page.records)).not.toContain('OA-KEY');
  });

  it('pages by page number until the reported total', async () => {
    const p = new OpenAlexProvider(testConfig(routes().fetch));
    const page = await p.search(query(), ctx());
    expect(page.records.length).toBe(3);
    expect(page.total).toBeGreaterThan(1000);
    expect(page.next).toBe(2);
    expect(page.records.map((r) => r.title)).toContain('Quantum error correction for beginners');
  });

  it('lists citing works and an author profile', async () => {
    const p = new OpenAlexProvider(testConfig(routes().fetch));
    const shor = (await p.getByDoi('10.1103/physreva.52.r2493', ctx()))!;
    const citing = await p.citations(shor, 3, ctx());
    expect(citing.records.length).toBe(3);
    expect(citing.total).toBeGreaterThan(1000);
    const author = await p.getAuthor('https://openalex.org/A5020744800', ctx());
    expect(author).toMatchObject({ id: 'openalex:A5020744800', name: 'Peter W. Shor', orcid: '0000-0003-4626-5648' });
    expect(author!.works.length).toBeGreaterThan(0);
  });

  it('rebuilds abstracts from the inverted index', () => {
    expect(abstractFromInvertedIndex({ world: [1], Hello: [0], again: [3], hello: [2] })).toBe('Hello world hello again');
    expect(abstractFromInvertedIndex(null)).toBeNull();
  });

  it('rejects a response that is not an OpenAlex list', async () => {
    const p = new OpenAlexProvider(testConfig(fakeFetch([[() => true, json({ unexpected: true })]]).fetch));
    expect((await failure(p.search(query(), ctx()))).kind).toBe('invalid_response');
  });
});

describe('Semantic Scholar', () => {
  const paper = JSON.parse(fixture('semantic-scholar/paper-doi-physreva.52.r2493.json')) as Record<string, unknown>;
  // The documented /paper/search envelope around a recorded paper (see fixtures/README.md).
  const searchBody = { total: 4213, offset: 0, next: 1, data: [paper] };
  const routes = () =>
    fakeFetch([
      [(u) => u.pathname.endsWith('/paper/search'), json(searchBody)],
      [(u) => u.pathname.endsWith('/citations'), json(fixture('semantic-scholar/citations-physreva.52.r2493.json'))],
      [(u) => u.pathname.endsWith('/author/1741101'), json(fixture('semantic-scholar/author-1741101.json'))],
      [(u) => u.pathname.endsWith('/author/1741101/papers'), json({ data: [paper] })],
      [(u) => u.pathname.includes('DOI:10.5555'), json(fixture('semantic-scholar/not-found.json'), 404)],
      [(u) => u.pathname.includes('/paper/'), json(paper)],
    ]);

  it('maps a recorded paper', async () => {
    const f = routes();
    const p = new SemanticScholarProvider(testConfig(f.fetch, { apiKey: 'S2-KEY' }));
    const r = await p.getByDoi('10.1103/physreva.52.r2493', ctx());
    expect(r).toMatchObject({
      provider: 'semantic-scholar',
      title: 'Scheme for reducing decoherence in quantum computer memory.',
      publicationYear: 1995,
      publicationType: 'journal-article',
      identifiers: { doi: '10.1103/physreva.52.r2493', semanticScholarId: '067b1059f443e53276d39fc6eddbf273cc103531' },
    });
    expect(f.calls[0]!.url.pathname).toBe('/graph/v1/paper/DOI:10.1103/physreva.52.r2493');
    expect(f.calls[0]!.headers.get('x-api-key')).toBe('S2-KEY');
    expect(f.calls[0]!.url.search).not.toContain('S2-KEY');
  });

  it('looks up arXiv papers by their arXiv ID', async () => {
    const f = fakeFetch([[() => true, json(fixture('semantic-scholar/paper-arxiv-1706.03762.json'))]]);
    const r = await new SemanticScholarProvider(testConfig(f.fetch)).getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
    expect(f.calls[0]!.url.pathname).toBe('/graph/v1/paper/ARXIV:1706.03762');
    expect(r).toMatchObject({ title: 'Attention is All you Need', publicationYear: 2017, identifiers: { arxivId: '1706.03762' } });
  });

  it('sends plain-text queries and native filters', async () => {
    const f = routes();
    const p = new SemanticScholarProvider(testConfig(f.fetch));
    await p.search(query({ text: '"surface-code" decoders', filters: { yearFrom: 2019, publicationTypes: ['review'], openAccessOnly: true, categories: ['cs.LG'] } }), ctx());
    const u = f.calls[0]!.url;
    expect(u.searchParams.get('query')).toBe('surface code decoders');
    expect(u.searchParams.get('year')).toBe('2019-');
    expect(u.searchParams.get('publicationTypes')).toBe('Review,MetaAnalysis');
    expect(u.searchParams.has('openAccessPdf')).toBe(true);
    expect(u.searchParams.get('fieldsOfStudy')).toBe('Computer Science');
    expect(f.calls[0]!.headers.get('x-api-key')).toBeNull();
  });

  it('checks titles locally in title mode', async () => {
    const p = new SemanticScholarProvider(testConfig(routes().fetch));
    const hit = await p.search(query({ text: 'reducing decoherence', mode: 'title' }), ctx());
    expect(hit.records).toHaveLength(1);
    expect(hit.notes[0]).toMatch(/no title-only search/);
    const miss = await p.search(query({ text: 'surface code', mode: 'title' }), ctx());
    expect(miss.records).toHaveLength(0);
  });

  it('lists citing works with the reported citation count', async () => {
    const p = new SemanticScholarProvider(testConfig(routes().fetch));
    const shor = (await p.getByDoi('10.1103/physreva.52.r2493', ctx()))!;
    const citing = await p.citations(shor, 3, ctx());
    expect(citing.records).toHaveLength(3);
    expect(citing.total).toBe(shor.citedByCount);
  });

  it('reads an author profile', async () => {
    const p = new SemanticScholarProvider(testConfig(routes().fetch));
    const a = await p.getAuthor('semantic-scholar:1741101', ctx());
    expect(a).toMatchObject({ id: 'semantic-scholar:1741101', provider: 'semantic-scholar' });
    expect(a!.works).toHaveLength(1);
    await expect(p.getAuthor('not-numeric', ctx())).resolves.toBeNull();
  });

  it('returns null for unknown papers and reports rate limits', async () => {
    const p = new SemanticScholarProvider(testConfig(routes().fetch));
    await expect(p.getByDoi('10.5555/does-not-exist-research-studio', ctx())).resolves.toBeNull();
    const limited = new SemanticScholarProvider(testConfig(fakeFetch([[() => true, json(fixture('semantic-scholar/rate-limited.json'), 429)]]).fetch));
    const err = await failure(limited.search(query(), ctx()));
    expect(err.kind).toBe('rate_limited');
    expect(err.provider).toBe('semantic-scholar');
  });
});

describe('arXiv', () => {
  const routes = () =>
    fakeFetch([
      [(u) => u.searchParams.get('id_list') === '1706.03762v5', xml(fixture('arxiv/id-1706.03762v5.xml'))],
      [(u) => u.searchParams.get('id_list') === 'quant-ph/9605011', xml(fixture('arxiv/id-quant-ph-9605011.xml'))],
      [(u) => u.searchParams.get('id_list') === 'not-an-id', xml(fixture('arxiv/error-bad-id.xml'), 400)],
      [(u) => u.searchParams.has('search_query'), xml(fixture('arxiv/search-surface-code.xml'))],
    ]);

  it('maps new- and old-style entries with versions', async () => {
    const p = new ArxivProvider(testConfig(routes().fetch));
    const attention = await p.getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
    expect(attention).toMatchObject({
      provider: 'arxiv',
      providerId: '1706.03762v5',
      title: 'Attention Is All You Need',
      version: 'v5',
      publicationType: 'preprint',
      identifiers: { arxivId: '1706.03762' },
      dates: { submitted: '2017-06-12', updated: '2017-12-06' },
      openAccess: { isOpenAccess: true, pdfUrl: 'https://arxiv.org/pdf/1706.03762v5' },
    });
    expect(attention!.authors).toHaveLength(8);
    expect(attention!.categories[0]).toEqual({ scheme: 'arxiv', value: 'cs.CL' });

    const ft = await p.getByArxivId({ id: 'quant-ph/9605011', version: null }, ctx());
    expect(ft).toMatchObject({ title: 'Fault-tolerant quantum computation', identifiers: { arxivId: 'quant-ph/9605011' }, version: 'v2' });
    expect(ft!.authors[0]).toMatchObject({ name: 'Peter W. Shor', affiliations: ['AT&T Research'] });
  });

  it('turns an arXiv error feed into a bad-request error', async () => {
    const p = new ArxivProvider(testConfig(routes().fetch));
    const err = await failure(p.getByArxivId({ id: 'not-an-id', version: null }, ctx()));
    expect(err.kind).toBe('bad_request');
    expect(err.message).toMatch(/incorrect id format/i);
  });

  it('searches with field prefixes and pages by start index', async () => {
    const f = routes();
    const p = new ArxivProvider(testConfig(f.fetch));
    const page = await p.search(query({ text: 'surface code', mode: 'title', filters: { categories: ['quant-ph'] } }), ctx());
    expect(f.calls[0]!.url.searchParams.get('search_query')).toBe('ti:surface AND ti:code AND cat:quant-ph');
    expect(page.records.map((r) => r.title)).toContain('The XZZX Surface Code');
    expect(page.total).toBeGreaterThan(3);
    expect(page.next).toBe(3);
  });

  it('builds queries for every mode and filter', () => {
    expect(buildArxivQuery({ text: '"surface code" decoder', mode: 'all', filters: {} })).toBe('all:"surface code" AND all:decoder');
    expect(buildArxivQuery({ text: 'surface code', mode: 'title-abstract', filters: {} })).toBe('(ti:surface OR abs:surface) AND (ti:code OR abs:code)');
    expect(buildArxivQuery({ text: 'Peter Shor', mode: 'author', filters: {} })).toBe('au:Peter AND au:Shor');
    expect(
      buildArxivQuery({ text: 'qubit', mode: 'all', filters: { categories: ['math', 'quant-ph', 'bad category!'], yearFrom: 2020, authors: ['Kitaev'] } }),
    ).toBe('all:qubit AND au:Kitaev AND ((cat:math OR cat:math.*) OR cat:quant-ph) AND submittedDate:[202001010000 TO 299912312359]');
    expect(buildArxivQuery({ text: '   ', mode: 'all', filters: {} })).toBeNull();
  });

  it('maps sorts and explains the ones it cannot do', async () => {
    const f = routes();
    const p = new ArxivProvider(testConfig(f.fetch));
    const oldest = await p.search(query({ sort: 'oldest' }), ctx());
    expect(f.calls[0]!.url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(f.calls[0]!.url.searchParams.get('sortOrder')).toBe('ascending');
    expect(oldest.notes).toEqual(['arXiv sorts by first submission date']);
    const cited = await p.search(query({ sort: 'citations' }), ctx());
    expect(f.calls[1]!.url.searchParams.get('sortBy')).toBe('relevance');
    expect(cited.notes[0]).toMatch(/does not report citations/);
  });

  it('skips queries for publication types arXiv does not have', () => {
    const p = new ArxivProvider(testConfig(routes().fetch));
    expect(p.skipReason(query({ filters: { publicationTypes: ['journal-article'] } }))).toMatch(/only has preprints/);
    expect(p.skipReason(query({ filters: { publicationTypes: ['preprint', 'journal-article'] } }))).toBeNull();
    expect(p.skipReason(query())).toBeNull();
  });

  it('waits three seconds after each response by default', async () => {
    let clock = 0;
    const waits: number[] = [];
    const p = new ArxivProvider({
      fetch: routes().fetch,
      now: () => clock,
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    await p.getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
    await p.getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
    expect(waits).toEqual([3000]);
  });
});

describe('arXiv XML reader', () => {
  it('refuses documents with a DTD (no entity expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><feed>&lol;</feed>';
    expect(() => parseXml(bomb)).toThrow(XmlError);
  });

  it('decodes the five XML entities and numeric references only', () => {
    const doc = parseXml('<a x="1 &amp; 2"><b>&lt;&#x3B1;&#946;&gt;</b><c><![CDATA[<raw>]]></c></a>');
    expect(doc.name).toBe('a');
    expect(doc.attributes.x).toBe('1 & 2');
    expect(() => parseXml('<a>&custom;</a>')).toThrow(XmlError);
  });

  it('rejects malformed documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a>')).toThrow(XmlError);
    expect(() => parseXml('')).toThrow(XmlError);
  });
});

describe('Crossref', () => {
  const routes = () =>
    fakeFetch([
      [(u) => u.pathname === '/works/10.1103/physreva.52.r2493', json(fixture('crossref/work-10.1103-physreva.52.r2493.json'))],
      [(u) => u.pathname.startsWith('/works/'), new Response(fixture('crossref/not-found.json'), { status: 404 })],
      [(u) => u.pathname === '/works', json(fixture('crossref/search-decoherence-shor.json'))],
    ]);

  it('maps a recorded work with print/online dates and ISSNs', async () => {
    const p = new CrossrefProvider(testConfig(routes().fetch));
    const r = await p.getByDoi('10.1103/physreva.52.r2493', ctx());
    expect(r).toMatchObject({
      provider: 'crossref',
      providerId: '10.1103/physreva.52.r2493',
      title: 'Scheme for reducing decoherence in quantum computer memory',
      venue: 'Physical Review A',
      publisher: 'American Physical Society (APS)',
      publicationType: 'journal-article',
      dates: { published: '1995-10-01', publishedOnline: '1995-10-01' },
      bibliographic: { volume: '52', issue: '4', pages: 'R2493-R2496', issn: ['1050-2947', '1094-1622'] },
      openAccess: { isOpenAccess: null },
    });
    expect(r!.authors[0]).toMatchObject({ name: 'Peter W. Shor', givenName: 'Peter W.', familyName: 'Shor' });
  });

  it('selects only fields the /works list route accepts', () => {
    // Crossref's own list of valid selects, from a recorded validation failure.
    const failure = JSON.parse(fixture('crossref/select-validation-failure.json')) as { message: { message: string }[] };
    const valid = new Set(failure.message[0]!.message.split('are:')[1]!.split(',').map((s) => s.trim()));
    expect(valid.size).toBeGreaterThan(20);
    expect(CROSSREF_SELECT.split(',').filter((field) => !valid.has(field))).toEqual([]);
  });

  it('maps posted content without a subtype (list results) to preprints', () => {
    expect(crossrefType('posted-content', undefined)).toBe('preprint');
    expect(crossrefType('posted-content', 'preprint')).toBe('preprint');
    expect(crossrefType('posted-content', 'working_paper')).toBe('other');
    expect(crossrefType('proceedings-article', null)).toBe('conference-paper');
  });

  it('returns null for an unknown DOI', async () => {
    const p = new CrossrefProvider(testConfig(routes().fetch));
    await expect(p.getByDoi('10.5555/does-not-exist-research-studio', ctx())).resolves.toBeNull();
  });

  it('builds searches with field queries, filters and sorts', async () => {
    const f = routes();
    const p = new CrossrefProvider(testConfig(f.fetch, { mailto: 'team@example.org' }));
    const page = await p.search(
      query({
        text: 'scheme for reducing decoherence',
        mode: 'title',
        filters: { authors: ['Shor'], yearFrom: 1990, yearTo: 2000, publicationTypes: ['journal-article', 'preprint'], venues: ['Physical Review A'] },
        sort: 'citations',
      }),
      ctx(),
    );
    const u = f.calls[0]!.url;
    expect(u.searchParams.get('query.bibliographic')).toBe('scheme for reducing decoherence');
    expect(u.searchParams.get('query.author')).toBe('Shor');
    expect(u.searchParams.get('query.container-title')).toBe('Physical Review A');
    expect(u.searchParams.get('filter')).toBe('from-pub-date:1990,until-pub-date:2000,type:journal-article,type:posted-content');
    expect(u.searchParams.get('sort')).toBe('is-referenced-by-count');
    expect(u.searchParams.get('order')).toBe('desc');
    expect(u.searchParams.get('mailto')).toBe('team@example.org');
    // Title mode keeps only works whose title has the words; the contact address is not stored.
    expect(page.records.map((r) => r.identifiers.doi)).toEqual(['10.1103/physreva.52.r2493']);
    expect(page.records[0]!.requestUrl).not.toContain('mailto');
    expect(page.total).toBe(16);
  });

  it('uses the public pool rate (1 request/s, one at a time) without a contact address', async () => {
    let clock = 0;
    const waits: number[] = [];
    const p = new CrossrefProvider({ fetch: routes().fetch, now: () => clock, sleep: (ms) => (waits.push(ms), (clock += ms), Promise.resolve()) });
    await Promise.all([p.getByDoi('10.1103/physreva.52.r2493', ctx()), p.getByDoi('10.1103/physreva.52.r2493', ctx())]);
    expect(waits).toEqual([1000]);
  });

  it('skips queries for types Crossref cannot filter', () => {
    const p = new CrossrefProvider(testConfig(routes().fetch));
    expect(p.skipReason(query({ filters: { publicationTypes: ['review'] } }))).toMatch(/no matching publication types/);
    expect(p.skipReason(query({ filters: { publicationTypes: ['review', 'journal-article'] } }))).toBeNull();
  });
});
