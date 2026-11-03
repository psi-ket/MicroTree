import { describe, expect, it } from 'vitest';
import { ArxivProvider } from '../src/providers/arxiv/client';
import { CrossrefProvider } from '../src/providers/crossref/client';
import { OpenAlexProvider } from '../src/providers/openalex/client';
import { SemanticScholarProvider } from '../src/providers/semantic-scholar/client';
import { LiteratureSearchService } from '../src/search/search-service';

/**
 * Live smoke tests against the real APIs. Off by default (CI never needs
 * network or credentials): run with `RS_LITERATURE_LIVE=1 pnpm --filter
 * @research-studio/literature-engine test test/live.test.ts`.
 * Optional keys come from OPENALEX_API_KEY and SEMANTIC_SCHOLAR_API_KEY.
 * No contact address is sent (Crossref answers from its public pool).
 */
const LIVE = process.env.RS_LITERATURE_LIVE === '1';
const signal = () => ({ signal: AbortSignal.timeout(90_000) });
const SHOR_DOI = '10.1103/physreva.52.r2493';

describe.skipIf(!LIVE)('live providers', () => {
  it('OpenAlex: search and DOI lookup', { timeout: 120_000 }, async () => {
    const p = new OpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY || undefined });
    const page = await p.search({ text: 'quantum error correction', mode: 'all', filters: { yearFrom: 2020 }, sort: 'relevance', pageSize: 5, position: null }, signal());
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records.every((r) => (r.publicationYear ?? 0) >= 2020)).toBe(true);
    const shor = await p.getByDoi(SHOR_DOI, signal());
    expect(shor?.title).toMatch(/decoherence in quantum computer memory/i);
  });

  it('Semantic Scholar: DOI lookup and search', { timeout: 300_000 }, async () => {
    // Keyless requests share a public pool that often answers 429; allow long waits.
    const p = new SemanticScholarProvider({ apiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || undefined, maxRetries: 6, backoffBaseMs: 5000 });
    const shor = await p.getByDoi(SHOR_DOI, signal());
    expect(shor?.identifiers.doi).toBe(SHOR_DOI);
    const page = await p.search({ text: 'surface code decoder', mode: 'all', filters: {}, sort: 'relevance', pageSize: 5, position: null }, signal());
    expect(page.records.length).toBeGreaterThan(0);
  });

  it('arXiv: search and identifier lookup', { timeout: 120_000 }, async () => {
    const p = new ArxivProvider();
    const page = await p.search({ text: 'surface code', mode: 'title', filters: { categories: ['quant-ph'] }, sort: 'newest', pageSize: 5, position: null }, signal());
    expect(page.records.length).toBeGreaterThan(0);
    const attention = await p.getByArxivId({ id: '1706.03762', version: null }, signal());
    expect(attention?.title).toBe('Attention Is All You Need');
  });

  it('Crossref: search and DOI lookup', { timeout: 120_000 }, async () => {
    const p = new CrossrefProvider();
    const page = await p.search({ text: 'scheme for reducing decoherence', mode: 'title', filters: { authors: ['Shor'] }, sort: 'relevance', pageSize: 5, position: null }, signal());
    expect(page.records.map((r) => r.identifiers.doi)).toContain(SHOR_DOI);
    const shor = await p.getByDoi(SHOR_DOI, signal());
    expect(shor?.venue).toBe('Physical Review A');
  });

  it('all providers together: one merged work for a DOI', { timeout: 300_000 }, async () => {
    const service = new LiteratureSearchService({
      timeoutMs: 120_000,
      providers: [
        new OpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY || undefined }),
        new SemanticScholarProvider({ apiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || undefined, maxRetries: 6, backoffBaseMs: 5000 }),
        new ArxivProvider(),
        new CrossrefProvider(),
      ],
    });
    const res = await service.search({ query: `https://doi.org/${SHOR_DOI}` });
    expect(res.results[0]?.work.id).toBe(`doi:${SHOR_DOI}`);
    const providers = res.results[0]!.work.sourceRecords.map((r) => r.provider);
    expect(providers).toEqual(expect.arrayContaining(['openalex', 'crossref']));
    // Printed for the engineering report: which providers answered and how.
    console.info(JSON.stringify(res.providerStatus.map((s) => ({ provider: s.provider, status: s.status, results: s.resultCount, ms: s.durationMs, error: s.error ?? null }))));
  });
});
