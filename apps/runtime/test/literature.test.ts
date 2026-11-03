import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LiteratureProviderStatus, LiteratureSearchResult, ScholarlyWork } from '@research-studio/shared-types';
import { createTestRuntime, ORIGIN, type TestRuntime } from './helpers';

interface MockLiterature {
  origin: string;
  env: Record<string, string>;
  scenario: Record<string, string>;
  requests: { provider: string; path: string; query: Record<string, string>; headers: Record<string, string | null> }[];
  stats: { abandoned: number };
  close(): Promise<void>;
}

const mockModule = pathToFileURL(new URL('../../../e2e/mock-literature-server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;

let mock: MockLiterature;
let rt: TestRuntime | null = null;

beforeAll(async () => {
  const { startMockLiteratureServer } = (await import(mockModule)) as { startMockLiteratureServer: () => Promise<MockLiterature> };
  mock = await startMockLiteratureServer();
});

afterAll(() => mock.close());

afterEach(async () => {
  await rt?.dispose();
  rt = null;
  for (const p of ['openalex', 'semantic-scholar', 'arxiv', 'crossref']) mock.scenario[p] = 'ok';
  mock.requests.length = 0;
});

/** A runtime pointed at the mock APIs, without the providers' request spacing. */
async function runtime(config: Record<string, string> = {}, env: Record<string, string> = {}): Promise<TestRuntime> {
  rt = await createTestRuntime({
    config: { ...mock.env, RS_LITERATURE_TIMEOUT_MS: '5000', ...config },
    env,
    literature: { providerConfig: { minIntervalMs: 0, backoffBaseMs: 1, maxRetries: 1 } },
  });
  return rt;
}

const search = async (r: TestRuntime, body: Record<string, unknown>) => {
  const res = await r.request('POST', '/api/v1/literature/search', { body });
  return { status: res.statusCode, body: res.json<LiteratureSearchResult & { error?: { code: string; message: string } }>() };
};

describe('literature API', () => {
  it('lists providers without exposing configuration secrets', async () => {
    const r = await runtime({ RS_LITERATURE_MAILTO: 'team@example.org' });
    const res = await r.request('GET', '/api/v1/literature/providers');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ providers: LiteratureProviderStatus[]; contactConfigured: boolean; cache: { entries: number } }>();
    expect(body.providers.map((p) => [p.id, p.enabled, p.connection, p.acceptsApiKey, p.apiKeySource])).toEqual([
      ['openalex', true, 'unknown', true, null],
      ['semantic-scholar', true, 'unknown', true, null],
      ['arxiv', true, 'unknown', false, null],
      ['crossref', true, 'unknown', false, null],
    ]);
    expect(body.contactConfigured).toBe(true);
    expect(res.body).not.toContain('team@example.org');
    expect(body.providers.find((p) => p.id === 'crossref')!.limits).toMatch(/Polite pool/);
  });

  it('searches all providers, merges duplicates and records history', async () => {
    const r = await runtime();
    const { status, body } = await search(r, { query: 'quantum error correction' });
    expect(status).toBe(200);
    expect(body.query.kind).toBe('text');
    expect(body.providerStatus.map((s) => [s.provider, s.status])).toEqual([
      ['openalex', 'success'],
      ['semantic-scholar', 'success'],
      ['arxiv', 'success'],
      ['crossref', 'success'],
    ]);
    expect(body.results.length).toBeGreaterThan(5);
    // The recorded Shor 1995 paper comes back from Semantic Scholar and Crossref: one result, two sources.
    const shor = body.results.find((x) => x.work.id === 'doi:10.1103/physreva.52.r2493')!;
    expect(shor.work.sourceRecords.map((s) => s.provider).sort()).toEqual(['crossref', 'semantic-scholar']);
    expect(new Set(body.results.map((x) => x.work.id)).size).toBe(body.results.length);

    const history = (await r.request('GET', '/api/v1/literature/history')).json<{ entries: { query: string; providers: unknown[] }[] }>();
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ query: 'quantum error correction' });

    const providers = (await r.request('GET', '/api/v1/literature/providers')).json<{ providers: LiteratureProviderStatus[] }>();
    expect(providers.providers.every((p) => p.connection === 'ok')).toBe(true);
  });

  it('serves repeated searches from the cache until it is cleared', async () => {
    const r = await runtime();
    await search(r, { query: 'surface code', providers: ['arxiv'] });
    const again = await search(r, { query: 'surface code', providers: ['arxiv'] });
    expect(again.body.providerStatus[0]).toMatchObject({ provider: 'arxiv', fromCache: true });
    expect(mock.requests.filter((q) => q.provider === 'arxiv')).toHaveLength(1);
    const cleared = await r.request('DELETE', '/api/v1/literature/cache');
    expect(cleared.json<{ cleared: number }>().cleared).toBeGreaterThan(0);
    const third = await search(r, { query: 'surface code', providers: ['arxiv'] });
    expect(third.body.providerStatus[0]!.fromCache).toBe(false);
  });

  it('resolves a DOI query to one merged work from every provider that knows it', async () => {
    const r = await runtime();
    const { body } = await search(r, { query: 'https://doi.org/10.1103/PhysRevA.52.R2493' });
    expect(body.query).toMatchObject({ kind: 'doi', identifier: '10.1103/physreva.52.r2493' });
    expect(body.results).toHaveLength(1);
    const work = body.results[0]!.work;
    expect(work.sourceRecords.map((s) => s.provider)).toEqual(['openalex', 'semantic-scholar', 'crossref']);
    expect(work.venue).toBe('Physical Review A');
    expect(work.citation.observations).toHaveLength(3);
    expect(body.providerStatus.find((s) => s.provider === 'arxiv')).toMatchObject({ status: 'skipped' });
  });

  it('resolves DOIs and arXiv IDs through wildcard routes, and works by canonical ID', async () => {
    const r = await runtime();
    const doi = await r.request('GET', '/api/v1/literature/resolve/doi/10.1103/PhysRevA.52.R2493');
    expect(doi.statusCode).toBe(200);
    expect(doi.json<{ works: ScholarlyWork[] }>().works[0]!.id).toBe('doi:10.1103/physreva.52.r2493');

    const old = await r.request('GET', '/api/v1/literature/resolve/arxiv/quant-ph/9605011');
    expect(old.json<{ works: ScholarlyWork[] }>().works[0]).toMatchObject({ id: 'arxiv:quant-ph/9605011', title: 'Fault-tolerant quantum computation' });

    const attention = await r.request('GET', '/api/v1/literature/resolve/arxiv/1706.03762v5');
    const works = attention.json<{ works: ScholarlyWork[] }>().works;
    expect(works[0]!.id).toBe('arxiv:1706.03762');
    expect(works[0]!.sourceRecords.map((s) => s.provider).sort()).toEqual(['arxiv', 'openalex', 'semantic-scholar']);

    const byId = await r.request('GET', `/api/v1/literature/works/${encodeURIComponent('doi:10.1103/physreva.52.r2493')}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.json<{ work: ScholarlyWork }>().work.title).toBe('Scheme for reducing decoherence in quantum computer memory');

    const citing = await r.request('GET', `/api/v1/literature/works/${encodeURIComponent('doi:10.1103/physreva.52.r2493')}/citations?limit=3`);
    expect(citing.json<{ provider: string; works: unknown[] }>()).toMatchObject({ provider: 'openalex' });
    expect(citing.json<{ works: unknown[] }>().works).toHaveLength(3);

    const missing = await r.request('GET', '/api/v1/literature/resolve/doi/10.5555/does-not-exist-research-studio');
    expect(missing.statusCode).toBe(404);
    const invalid = await r.request('GET', '/api/v1/literature/resolve/doi/not-a-doi');
    expect(invalid.statusCode).toBe(400);
  });

  it('returns author profiles', async () => {
    const r = await runtime();
    const res = await r.request('GET', '/api/v1/literature/authors/openalex:A5020744800');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ author: { name: string; works: unknown[] } }>().author).toMatchObject({ name: 'Peter W. Shor' });
    expect((await r.request('GET', '/api/v1/literature/authors/openalex:not-an-id')).statusCode).toBe(400);
  });

  it('keeps going when a provider is rate limited or down, and says so', async () => {
    const r = await runtime();
    mock.scenario['semantic-scholar'] = 'rate_limited';
    mock.scenario.crossref = 'down';
    const { status, body } = await search(r, { query: 'quantum error correction' });
    expect(status).toBe(200);
    expect(body.providerStatus.map((s) => [s.provider, s.status])).toEqual([
      ['openalex', 'success'],
      ['semantic-scholar', 'rate_limited'],
      ['arxiv', 'success'],
      ['crossref', 'failed'],
    ]);
    expect(body.results.length).toBeGreaterThan(0);
    const providers = (await r.request('GET', '/api/v1/literature/providers')).json<{ providers: LiteratureProviderStatus[] }>().providers;
    expect(providers.find((p) => p.id === 'semantic-scholar')).toMatchObject({ connection: 'rate_limited' });
    expect(providers.find((p) => p.id === 'crossref')).toMatchObject({ connection: 'error' });
  });

  it('reports 502 when no provider can be reached for a lookup', async () => {
    const r = await runtime();
    for (const p of ['openalex', 'semantic-scholar', 'arxiv', 'crossref']) mock.scenario[p] = 'down';
    const res = await r.request('GET', '/api/v1/literature/resolve/doi/10.1103/PhysRevA.52.R2493');
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('PROVIDER_ERROR');
  });

  it('ends a search at the deadline when a provider never answers', async () => {
    const r = await runtime({ RS_LITERATURE_TIMEOUT_MS: '3000' });
    mock.scenario.openalex = 'slow';
    const started = Date.now();
    const { body } = await search(r, { query: 'quantum error correction' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(body.providerStatus[0]).toMatchObject({ provider: 'openalex', status: 'failed', error: 'OpenAlex did not answer in time' });
    expect(body.results.length).toBeGreaterThan(0);
  }, 20_000);

  it('cancels provider requests when the client disconnects', async () => {
    const r = await runtime();
    mock.scenario.openalex = 'slow';
    await r.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = r.app.server.address() as AddressInfo;
    const before = mock.stats.abandoned;
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/v1/literature/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${r.token}`, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'quantum error correction', providers: ['openalex'] }),
      signal: controller.signal,
    }).catch((err: unknown) => err);
    await expect.poll(() => mock.requests.some((q) => q.provider === 'openalex'), { timeout: 5000 }).toBe(true);
    controller.abort();
    await pending;
    // The runtime closes its upstream request well before the 5 s deadline.
    await expect.poll(() => mock.stats.abandoned, { timeout: 2000 }).toBeGreaterThan(before);
  });

  it('stores API keys in the secret store, sends them only as headers, and audits the change', async () => {
    const r = await runtime();
    const res = await r.request('PATCH', '/api/v1/literature/providers/semantic-scholar', { body: { apiKey: 's2-test-key-0123456789' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('s2-test-key');
    expect(res.json<{ provider: LiteratureProviderStatus }>().provider).toMatchObject({ apiKeySource: 'stored' });
    expect(await r.secrets.get('literature:semantic-scholar')).toBe('s2-test-key-0123456789');

    await search(r, { query: 'quantum error correction', providers: ['semantic-scholar'] });
    const s2 = mock.requests.filter((q) => q.provider === 'semantic-scholar');
    expect(s2.length).toBeGreaterThan(0);
    expect(s2.every((q) => q.headers['x-api-key'] === 's2-test-key-0123456789')).toBe(true);
    expect(JSON.stringify(s2.map((q) => q.query))).not.toContain('s2-test-key');

    const audit = (await r.request('GET', '/api/v1/audit?limit=20')).json<{ events: { action: string; details: unknown }[] }>().events;
    const event = audit.find((e) => e.action === 'literature.provider.update')!;
    expect(event.details).toEqual({ apiKey: 'stored' });
    expect(JSON.stringify(audit)).not.toContain('s2-test-key');
    // Nothing about the key reaches the database file.
    const dump = r.db.sqlite.prepare("SELECT group_concat(value, '') AS v FROM settings").get() as { v: string | null };
    expect(dump.v ?? '').not.toContain('s2-test-key');

    const removed = await r.request('PATCH', '/api/v1/literature/providers/semantic-scholar', { body: { apiKey: null } });
    expect(removed.json<{ provider: LiteratureProviderStatus }>().provider.apiKeySource).toBeNull();
    expect(await r.secrets.get('literature:semantic-scholar')).toBeNull();
  });

  it('uses keys from the environment when none is stored', async () => {
    const r = await runtime({}, { OPENALEX_API_KEY: 'oa-env-key-0123456789' });
    const providers = (await r.request('GET', '/api/v1/literature/providers')).json<{ providers: LiteratureProviderStatus[] }>().providers;
    expect(providers.find((p) => p.id === 'openalex')).toMatchObject({ apiKeySource: 'environment' });
    await search(r, { query: 'quantum error correction', providers: ['openalex'] });
    expect(mock.requests.find((q) => q.provider === 'openalex')!.query.api_key).toBe('oa-env-key-0123456789');
    // The key is never stored with cached results or shown in source records.
    const { body } = await search(r, { query: 'quantum error correction', providers: ['openalex'] });
    expect(JSON.stringify(body)).not.toContain('oa-env-key');
  });

  it('sends the contact address only to OpenAlex and Crossref', async () => {
    const r = await runtime({ RS_LITERATURE_MAILTO: 'team@example.org' });
    await search(r, { query: 'quantum error correction' });
    const byProvider = (p: string) => mock.requests.filter((q) => q.provider === p);
    expect(byProvider('openalex').every((q) => q.query.mailto === 'team@example.org')).toBe(true);
    expect(byProvider('crossref').every((q) => q.query.mailto === 'team@example.org')).toBe(true);
    expect(byProvider('semantic-scholar').some((q) => 'mailto' in q.query)).toBe(false);
    expect(byProvider('arxiv').some((q) => 'mailto' in q.query)).toBe(false);
  });

  it('rejects keys for providers without keys, and turns providers off', async () => {
    const r = await runtime();
    expect((await r.request('PATCH', '/api/v1/literature/providers/arxiv', { body: { apiKey: 'some-key-0123456789' } })).statusCode).toBe(400);
    const off = await r.request('PATCH', '/api/v1/literature/providers/crossref', { body: { enabled: false } });
    expect(off.json<{ provider: LiteratureProviderStatus }>().provider).toMatchObject({ enabled: false, connection: 'disabled' });
    const { body } = await search(r, { query: 'surface code' });
    expect(body.providerStatus.find((s) => s.provider === 'crossref')).toMatchObject({ status: 'skipped', error: 'Crossref is turned off' });
    expect(mock.requests.some((q) => q.provider === 'crossref')).toBe(false);
  });

  it('keeps preferences, and stops recording history when asked', async () => {
    const r = await runtime();
    await search(r, { query: 'first search', providers: ['arxiv'] });
    const prefs = await r.request('PATCH', '/api/v1/literature/preferences', { body: { saveHistory: false, sort: 'newest', pageSize: 10 } });
    expect(prefs.json<{ preferences: Record<string, unknown> }>().preferences).toMatchObject({ saveHistory: false, sort: 'newest', pageSize: 10 });
    expect((await r.request('GET', '/api/v1/literature/history')).json<{ entries: unknown[] }>().entries).toEqual([]);
    await search(r, { query: 'second search', providers: ['arxiv'] });
    expect((await r.request('GET', '/api/v1/literature/history')).json<{ entries: unknown[] }>().entries).toEqual([]);
    expect((await r.request('PATCH', '/api/v1/literature/preferences', { body: { providers: [] } })).statusCode).toBe(400);
  });

  it('validates requests', async () => {
    const r = await runtime();
    expect((await search(r, { query: '' })).status).toBe(400);
    expect((await search(r, { query: 'x', limit: 1000 })).status).toBe(400);
    expect((await search(r, { query: 'x', cursor: 'AAAAAAAAAAAAAAAAAAAAAAAA' })).body.error?.code).toBe('VALIDATION_FAILED');
    expect((await r.request('GET', '/api/v1/literature/providers/google/test')).statusCode).toBe(404);
    expect((await r.request('POST', '/api/v1/literature/providers/google/test')).statusCode).toBe(400);
  });

  it('requires a session', async () => {
    const r = await runtime();
    expect((await r.request('POST', '/api/v1/literature/search', { body: { query: 'x' }, auth: false })).statusCode).toBe(401);
  });

  it('is off when RS_LITERATURE=off', async () => {
    const r = await runtime({ RS_LITERATURE: 'off' });
    const res = await search(r, { query: 'surface code' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('NOT_CONFIGURED');
    expect(mock.requests).toHaveLength(0);
  });
});
