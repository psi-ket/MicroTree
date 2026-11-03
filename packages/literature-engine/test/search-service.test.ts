import type { LiteratureProviderId, ScholarlySourceRecord } from '@research-studio/shared-types';
import { describe, expect, it } from 'vitest';
import { LiteratureProviderError } from '../src/errors/provider-errors';
import { LiteratureRequestError } from '../src/search/pagination';
import { LiteratureCancelledError, LiteratureSearchService, LiteratureUnavailableError, type LiteratureCache } from '../src/search/search-service';
import type { LiteratureProvider, ProviderCapabilities, ProviderContext, ProviderSearchPage, ProviderSearchQuery } from '../src/types/provider';
import { record } from './helpers';

const ALL_NATIVE: ProviderCapabilities = {
  modes: { all: 'native', title: 'native', author: 'native', 'title-abstract': 'native' },
  filters: { authors: 'native', yearFrom: 'native', yearTo: 'native', publicationTypes: 'native', venues: 'native', openAccessOnly: 'native', categories: 'native' },
  sorts: ['relevance', 'newest', 'oldest', 'citations'],
  lookups: { doi: true, arxiv: true, openalex: true, semanticScholar: true },
  references: true,
  citations: true,
  authors: true,
  maxResults: 1000,
  maxPageSize: 100,
};

type SearchImpl = (q: ProviderSearchQuery, ctx: ProviderContext) => Promise<ProviderSearchPage>;

/** A scripted provider: pages of records by position, plus lookup tables. */
class FakeProvider implements LiteratureProvider {
  readonly searches: ProviderSearchQuery[] = [];
  readonly lookups: string[] = [];
  capabilities: ProviderCapabilities = structuredClone(ALL_NATIVE);
  byDoi = new Map<string, ScholarlySourceRecord>();
  byArxiv = new Map<string, ScholarlySourceRecord>();
  related: ScholarlySourceRecord[] = [];
  relatedError: Error | null = null;
  skipReason?: (q: ProviderSearchQuery) => string | null;
  impl: SearchImpl;

  constructor(
    readonly id: LiteratureProviderId,
    pages: ScholarlySourceRecord[][] = [],
  ) {
    this.impl = (q) => {
      const index = typeof q.position === 'number' ? q.position : 0;
      return Promise.resolve({ records: pages[index] ?? [], total: pages.flat().length, next: index + 1 < pages.length ? index + 1 : null, notes: [] });
    };
  }

  search(q: ProviderSearchQuery, ctx: ProviderContext) {
    this.searches.push(q);
    return this.impl(q, ctx);
  }

  getByDoi(doi: string) {
    this.lookups.push(`doi:${doi}`);
    return Promise.resolve(this.byDoi.get(doi) ?? null);
  }

  getByArxivId(id: { id: string }) {
    this.lookups.push(`arxiv:${id.id}`);
    return Promise.resolve(this.byArxiv.get(id.id) ?? null);
  }

  getById() {
    return Promise.resolve(null);
  }

  references() {
    return this.relatedError ? Promise.reject(this.relatedError) : Promise.resolve({ records: this.related, total: this.related.length });
  }

  citations() {
    return this.references();
  }

  check() {
    return Promise.resolve();
  }
}

const never: SearchImpl = (_q, ctx) =>
  new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new LiteratureProviderError('openalex', 'cancelled', 'request cancelled'))));

const work = (provider: LiteratureProviderId, n: number, patch: Parameters<typeof record>[3] = {}) =>
  record(provider, `${provider}-${n}`, `Surface code study number ${n}`, { identifiers: { doi: `10.1000/w${n}` }, authorNames: ['Ada Lovelace'], publicationYear: 2000 + n, ...patch });

describe('LiteratureSearchService', () => {
  it('queries providers in parallel and merges duplicates across them', async () => {
    const oa = new FakeProvider('openalex', [[work('openalex', 1), work('openalex', 2)]]);
    const cr = new FakeProvider('crossref', [[work('crossref', 2), work('crossref', 3)]]);
    const service = new LiteratureSearchService({ providers: [oa, cr] });
    const res = await service.search({ query: 'surface code' });
    expect(res.results.map((r) => r.work.id).sort()).toEqual(['doi:10.1000/w1', 'doi:10.1000/w2', 'doi:10.1000/w3']);
    const shared = res.results.find((r) => r.work.id === 'doi:10.1000/w2')!;
    expect(shared.work.sourceRecords.map((r) => r.provider)).toEqual(['openalex', 'crossref']);
    expect(shared.signals).toContain('found-by-2-providers');
    expect(res.providerStatus.map((s) => [s.provider, s.status, s.resultCount])).toEqual([
      ['openalex', 'success', 2],
      ['crossref', 'success', 2],
    ]);
    expect(res.query).toEqual({ kind: 'text', text: 'surface code', identifier: null });
  });

  it('returns partial results when a provider fails or is rate limited', async () => {
    const oa = new FakeProvider('openalex', [[work('openalex', 1)]]);
    const s2 = new FakeProvider('semantic-scholar');
    s2.impl = () => Promise.reject(new LiteratureProviderError('semantic-scholar', 'rate_limited', 'rate limit reached; try again later', 429));
    const cr = new FakeProvider('crossref');
    cr.impl = () => Promise.reject(new LiteratureProviderError('crossref', 'unavailable', 'service unavailable (HTTP 503)', 503));
    const res = await new LiteratureSearchService({ providers: [oa, s2, cr] }).search({ query: 'surface code' });
    expect(res.results).toHaveLength(1);
    expect(res.providerStatus).toEqual([
      expect.objectContaining({ provider: 'openalex', status: 'success' }),
      expect.objectContaining({ provider: 'semantic-scholar', status: 'rate_limited', error: 'Semantic Scholar: rate limit reached; try again later', resultCount: 0 }),
      expect.objectContaining({ provider: 'crossref', status: 'failed', error: 'Crossref: service unavailable (HTTP 503)', resultCount: 0 }),
    ]);
  });

  it('reports a provider that misses the deadline without waiting for it', async () => {
    const oa = new FakeProvider('openalex', [[work('openalex', 1)]]);
    const slow = new FakeProvider('arxiv');
    slow.impl = never;
    const started = Date.now();
    const res = await new LiteratureSearchService({ providers: [oa, slow], timeoutMs: 50 }).search({ query: 'surface code' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.results).toHaveLength(1);
    expect(res.providerStatus[1]).toMatchObject({ provider: 'arxiv', status: 'failed', error: 'arXiv did not answer in time' });
  });

  it('stops everything when the caller cancels', async () => {
    const slow = new FakeProvider('openalex');
    slow.impl = never;
    const controller = new AbortController();
    const pending = new LiteratureSearchService({ providers: [slow] }).search({ query: 'surface code' }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(LiteratureCancelledError);
  });

  it('skips providers that cannot serve the mode, a filter, or the type', async () => {
    const oa = new FakeProvider('openalex', [[work('openalex', 1)]]);
    const s2 = new FakeProvider('semantic-scholar', [[work('semantic-scholar', 2)]]);
    s2.capabilities.modes.author = 'unsupported';
    const cr = new FakeProvider('crossref', [[work('crossref', 3)]]);
    cr.capabilities.filters.openAccessOnly = 'unsupported';
    const ax = new FakeProvider('arxiv');
    ax.skipReason = () => 'arXiv only has preprints';
    const service = new LiteratureSearchService({ providers: [oa, s2, cr, ax] });
    const res = await service.search({ query: 'Lovelace', mode: 'author', filters: { openAccessOnly: true } });
    expect(res.providerStatus.map((s) => [s.provider, s.status, s.error ?? null])).toEqual([
      ['openalex', 'success', null],
      ['semantic-scholar', 'skipped', 'Semantic Scholar cannot search by author'],
      ['arxiv', 'skipped', 'arXiv only has preprints'],
      ['crossref', 'skipped', 'Crossref cannot filter by open access'],
    ]);
    expect(s2.searches).toHaveLength(0);
    expect(cr.searches).toHaveLength(0);
  });

  it('reports providers that are turned off when they are requested', async () => {
    const service = new LiteratureSearchService({ providers: [new FakeProvider('openalex', [[work('openalex', 1)]])] });
    const res = await service.search({ query: 'surface code', providers: ['openalex', 'crossref'] });
    expect(res.providerStatus[1]).toMatchObject({ provider: 'crossref', status: 'skipped', error: 'Crossref is turned off' });
  });

  it('applies every filter to every provider\'s results', async () => {
    const oa = new FakeProvider('openalex', [
      [
        work('openalex', 1, { publicationYear: 2019 }),
        work('openalex', 2, { publicationYear: 2021 }),
        work('openalex', 3, { publicationYear: null }),
        work('openalex', 4, { publicationYear: 2020, authorNames: ['Someone Else'] }),
      ],
    ]);
    const res = await new LiteratureSearchService({ providers: [oa] }).search({ query: 'surface code', filters: { yearFrom: 2020, authors: ['Lovelace'] } });
    expect(res.results.map((r) => r.work.publicationYear)).toEqual([2021]);
  });

  it('pages with single-use cursors and never repeats a work', async () => {
    const oa = new FakeProvider('openalex', [
      [work('openalex', 1), work('openalex', 2), work('openalex', 3)],
      [work('openalex', 4), work('openalex', 5)],
    ]);
    // Crossref returns the same works later in its list: they must not reappear on page 2.
    const cr = new FakeProvider('crossref', [[work('crossref', 6)], [work('crossref', 1), work('crossref', 7)]]);
    const service = new LiteratureSearchService({ providers: [oa, cr] });
    const seen: string[] = [];
    let res = await service.search({ query: 'surface code', limit: 3 });
    for (let guard = 0; guard < 10; guard++) {
      seen.push(...res.results.map((r) => r.work.id));
      if (!res.pagination.nextCursor) break;
      const cursor = res.pagination.nextCursor;
      res = await service.search({ query: 'surface code', limit: 3, cursor });
      await expect(service.search({ query: 'surface code', limit: 3, cursor })).rejects.toBeInstanceOf(LiteratureRequestError);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(['doi:10.1000/w1', 'doi:10.1000/w2', 'doi:10.1000/w3', 'doi:10.1000/w4', 'doi:10.1000/w5', 'doi:10.1000/w6', 'doi:10.1000/w7']);
    expect(res.pagination).toEqual({ hasMore: false, nextCursor: null });
  });

  it('rejects a cursor used with a different search or after it expires', async () => {
    let clock = 0;
    const oa = new FakeProvider('openalex', [[work('openalex', 1), work('openalex', 2)], [work('openalex', 3)]]);
    const service = new LiteratureSearchService({ providers: [oa], cursorTtlMs: 1000, now: () => clock });
    const first = await service.search({ query: 'surface code', limit: 1 });
    await expect(service.search({ query: 'other words', limit: 1, cursor: first.pagination.nextCursor! })).rejects.toThrow(/different search/);
    const second = await service.search({ query: 'surface code', limit: 1 });
    clock += 1001;
    await expect(service.search({ query: 'surface code', limit: 1, cursor: second.pagination.nextCursor! })).rejects.toThrow(/expired/);
    await expect(service.search({ query: '   ' })).rejects.toThrow(/Enter a search query/);
  });

  it('sorts newest first with unknown dates last', async () => {
    const oa = new FakeProvider('openalex', [[work('openalex', 1, { publicationYear: 1999 }), work('openalex', 2, { publicationYear: null }), work('openalex', 3, { publicationYear: 2024 })]]);
    const res = await new LiteratureSearchService({ providers: [oa] }).search({ query: 'surface code', sort: 'newest' });
    expect(res.results.map((r) => r.work.publicationYear)).toEqual([2024, 1999, null]);
  });

  it('serves repeated searches from the cache', async () => {
    const store = new Map<string, unknown>();
    const cache: LiteratureCache = {
      get: (key) => Promise.resolve(store.has(key) ? { value: store.get(key), retrievedAt: 'then' } : null),
      set: (key, entry) => {
        store.set(key, entry.value);
        return Promise.resolve();
      },
    };
    const oa = new FakeProvider('openalex', [[work('openalex', 1)]]);
    const service = new LiteratureSearchService({ providers: [oa], cache });
    await service.search({ query: 'surface code' });
    const again = await service.search({ query: 'surface code' });
    expect(oa.searches).toHaveLength(1);
    expect(again.providerStatus[0]).toMatchObject({ status: 'success', fromCache: true });
    expect(again.results).toHaveLength(1);
  });

  it('keeps working when the cache fails', async () => {
    const cache: LiteratureCache = { get: () => Promise.reject(new Error('disk')), set: () => Promise.reject(new Error('disk')) };
    const oa = new FakeProvider('openalex', [[work('openalex', 1)]]);
    const res = await new LiteratureSearchService({ providers: [oa], cache }).search({ query: 'surface code' });
    expect(res.results).toHaveLength(1);
  });

  describe('identifier queries', () => {
    it('resolves a DOI exactly, following the arXiv ID the first answer reveals', async () => {
      const journal = record('crossref', '10.1103/x', 'A result', { identifiers: { doi: '10.1103/x' }, authorNames: ['Ada Lovelace'] });
      const indexed = record('openalex', 'W1', 'A result', { identifiers: { doi: '10.1103/x', arxivId: '2101.00001', openAlexId: 'W1' } });
      const preprint = record('arxiv', '2101.00001v2', 'A result', { identifiers: { arxivId: '2101.00001' }, version: 'v2' });
      const cr = new FakeProvider('crossref');
      cr.byDoi.set('10.1103/x', journal);
      const oa = new FakeProvider('openalex');
      oa.byDoi.set('10.1103/x', indexed);
      const ax = new FakeProvider('arxiv');
      ax.capabilities.lookups.doi = false;
      ax.byArxiv.set('2101.00001', preprint);
      const res = await new LiteratureSearchService({ providers: [oa, ax, cr] }).search({ query: 'https://doi.org/10.1103/X' });
      expect(res.query).toEqual({ kind: 'doi', text: 'https://doi.org/10.1103/X', identifier: '10.1103/x' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0]!.signals).toEqual(['exact-identifier']);
      expect(res.results[0]!.score).toBeNull();
      expect(res.results[0]!.work.sourceRecords.map((r) => r.provider).sort()).toEqual(['arxiv', 'crossref', 'openalex']);
      expect(ax.lookups).toEqual(['arxiv:2101.00001']);
      expect(oa.searches).toHaveLength(0);
    });

    it('resolves arXiv identifiers, with versions, and skips providers that cannot', async () => {
      const ax = new FakeProvider('arxiv');
      ax.byArxiv.set('1706.03762', record('arxiv', '1706.03762v5', 'Attention Is All You Need', { identifiers: { arxivId: '1706.03762' } }));
      const cr = new FakeProvider('crossref');
      cr.capabilities.lookups.arxiv = false;
      const res = await new LiteratureSearchService({ providers: [ax, cr] }).search({ query: 'arXiv:1706.03762v5' });
      expect(res.query.kind).toBe('arxiv');
      expect(res.results[0]!.work.id).toBe('arxiv:1706.03762');
      expect(res.providerStatus[1]).toMatchObject({ provider: 'crossref', status: 'skipped', error: 'Crossref cannot look up arXiv identifiers' });
    });

    it('distinguishes "not found" from "nobody answered"', async () => {
      const oa = new FakeProvider('openalex');
      const service = new LiteratureSearchService({ providers: [oa] });
      await expect(service.getWork('doi:10.1000/missing')).resolves.toMatchObject({ work: null });
      oa.getByDoi = () => Promise.reject(new LiteratureProviderError('openalex', 'network', 'could not connect'));
      await expect(service.getWork('doi:10.1000/missing')).rejects.toBeInstanceOf(LiteratureUnavailableError);
      await expect(service.getWork('not an id')).resolves.toEqual({ work: null, outcomes: [] });
    });
  });

  describe('related works', () => {
    it('falls back to Semantic Scholar when OpenAlex fails', async () => {
      const target = record('openalex', 'W1', 'A result', { identifiers: { doi: '10.1000/a', openAlexId: 'W1' } });
      const oa = new FakeProvider('openalex');
      oa.byDoi.set('10.1000/a', target);
      oa.relatedError = new LiteratureProviderError('openalex', 'unavailable', 'service unavailable (HTTP 503)', 503);
      const s2 = new FakeProvider('semantic-scholar');
      s2.related = [record('semantic-scholar', 'a'.repeat(40), 'Citing paper', { identifiers: { semanticScholarId: 'a'.repeat(40) } })];
      const res = await new LiteratureSearchService({ providers: [oa, s2] }).citations('doi:10.1000/a');
      expect(res.provider).toBe('semantic-scholar');
      expect(res.works.map((w) => w.title)).toEqual(['Citing paper']);
      expect(res.outcomes.map((o) => [o.provider, o.status])).toEqual([
        ['openalex', 'failed'],
        ['semantic-scholar', 'success'],
      ]);
    });

    it('raises when no provider could answer', async () => {
      const target = record('openalex', 'W1', 'A result', { identifiers: { doi: '10.1000/a', openAlexId: 'W1' } });
      const oa = new FakeProvider('openalex');
      oa.byDoi.set('10.1000/a', target);
      oa.relatedError = new LiteratureProviderError('openalex', 'timeout', 'no response');
      await expect(new LiteratureSearchService({ providers: [oa] }).references('doi:10.1000/a')).rejects.toBeInstanceOf(LiteratureUnavailableError);
    });
  });
});
