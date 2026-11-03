import { describe, expect, it, vi } from 'vitest';
import {
  ClientMessageSchema,
  CreateProjectRequest,
  createRuntimeClient,
  LiteratureSearchRequestSchema,
  RuntimeApiError,
  ServerEventSchema,
  SynctexInverseRequest,
  UpdateProjectRequest,
  UpdateLiteraturePreferencesRequest,
  UpdateLiteratureProviderRequest,
  UpdateSettingsRequest,
} from '../src';

describe('request schemas', () => {
  it('applies defaults to project creation', () => {
    expect(CreateProjectRequest.parse({ name: '  My Paper ' })).toEqual({
      name: 'My Paper',
      template: 'article',
      engine: 'pdflatex',
    });
    expect(() => CreateProjectRequest.parse({ name: '   ' })).toThrow();
    expect(() => CreateProjectRequest.parse({ name: 'x', engine: 'tectonic' })).toThrow();
  });

  it('requires at least one field on update', () => {
    expect(() => UpdateProjectRequest.parse({})).toThrow();
    expect(UpdateProjectRequest.parse({ engine: 'lualatex' })).toEqual({ engine: 'lualatex' });
  });

  it('bounds settings and synctex inputs', () => {
    expect(() => UpdateSettingsRequest.parse({ autosaveDelayMs: 10 })).toThrow();
    expect(() => SynctexInverseRequest.parse({ page: 1, x: Number.NaN, y: 0 })).toThrow();
    expect(() => SynctexInverseRequest.parse({ page: 0, x: 1, y: 1 })).toThrow();
  });

  it('validates server events', () => {
    expect(ServerEventSchema.safeParse({ type: 'files.changed', projectId: 'p', paths: ['a'], originSessionId: null, source: 'runtime' }).success).toBe(true);
    const external = {
      type: 'files.changed',
      projectId: 'p',
      paths: ['a.tex', 'b.tex'],
      originSessionId: null,
      source: 'external',
      changes: [{ path: 'b.tex', change: 'renamed', from: 'a.tex' }],
    };
    expect(ServerEventSchema.safeParse(external).success).toBe(true);
    expect(ServerEventSchema.safeParse({ ...external, source: 'disk' }).success).toBe(false);
    expect(ServerEventSchema.safeParse({ ...external, changes: [{ path: 'a', change: 'moved' }] }).success).toBe(false);
    expect(ServerEventSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('validates client messages', () => {
    expect(ClientMessageSchema.safeParse({ type: 'project.watch', projectId: 'abc123' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'project.unwatch', projectId: 'abc123' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'project.watch', projectId: '../etc' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'project.watch' }).success).toBe(false);
  });
});

describe('createRuntimeClient', () => {
  it('sends bearer tokens and parses responses', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ projects: [] }, { status: 200 }),
    );
    const client = createRuntimeClient({
      baseUrl: 'http://127.0.0.1:4317/',
      getSessionToken: () => 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.listProjects()).resolves.toEqual({ projects: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4317/api/v1/projects');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('maps error bodies and reports 401s', async () => {
    const onUnauthorized = vi.fn();
    const client = createRuntimeClient({
      baseUrl: 'http://x',
      getSessionToken: () => 'expired',
      onUnauthorized,
      fetch: (async () =>
        Response.json({ error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, { status: 401 })) as unknown as typeof fetch,
    });
    const err = await client.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHORIZED', message: 'Session expired' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects responses that violate the contract', async () => {
    const client = createRuntimeClient({
      baseUrl: 'http://x',
      getSessionToken: () => null,
      fetch: (async () => Response.json({ projects: [{ id: 1 }] })) as unknown as typeof fetch,
    });
    await expect(client.listProjects()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('reports network failures', async () => {
    const client = createRuntimeClient({
      baseUrl: 'http://x',
      getSessionToken: () => null,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });
});

describe('literature contracts', () => {
  it('bounds search requests', () => {
    expect(LiteratureSearchRequestSchema.parse({ query: '  surface code ', filters: { yearFrom: 2010, yearTo: 2020 } })).toEqual({
      query: 'surface code',
      filters: { yearFrom: 2010, yearTo: 2020 },
    });
    expect(() => LiteratureSearchRequestSchema.parse({ query: '   ' })).toThrow();
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', filters: { yearFrom: 2021, yearTo: 2020 } })).toThrow(/start year/);
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', limit: 500 })).toThrow();
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', providers: ['google-scholar'] })).toThrow();
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', filters: { categories: ['quant-ph; DROP'] } })).toThrow();
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', filters: { unknown: 1 } })).toThrow();
    expect(() => LiteratureSearchRequestSchema.parse({ query: 'x', cursor: '../../etc' })).toThrow();
  });

  it('validates provider updates and preferences', () => {
    expect(() => UpdateLiteratureProviderRequest.parse({})).toThrow();
    expect(UpdateLiteratureProviderRequest.parse({ apiKey: null })).toEqual({ apiKey: null });
    expect(() => UpdateLiteratureProviderRequest.parse({ apiKey: 'has space inside' })).toThrow();
    expect(() => UpdateLiteraturePreferencesRequest.parse({})).toThrow();
    expect(() => UpdateLiteraturePreferencesRequest.parse({ providers: [] })).toThrow();
    expect(UpdateLiteraturePreferencesRequest.parse({ pageSize: 25 })).toEqual({ pageSize: 25 });
  });

  it('encodes identifiers in paths and passes the abort signal', async () => {
    const urls: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const client = createRuntimeClient({
      baseUrl: 'http://x',
      getSessionToken: () => 't',
      fetch: (async (url: URL, init: RequestInit) => {
        urls.push(url.toString());
        signals.push(init.signal ?? undefined);
        return Response.json({ works: [], providerStatus: [] });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    await client.literature.resolveDoi('10.1002/(SICI)1097-4636', controller.signal);
    await client.literature.resolveArxiv('quant-ph/9605011');
    expect(urls).toEqual([
      'http://x/api/v1/literature/resolve/doi/10.1002/(SICI)1097-4636',
      'http://x/api/v1/literature/resolve/arxiv/quant-ph/9605011',
    ]);
    expect(signals).toEqual([controller.signal, undefined]);
  });

  it('rejects with the abort error when a search is cancelled', async () => {
    const client = createRuntimeClient({
      baseUrl: 'http://x',
      getSessionToken: () => 't',
      fetch: ((_url: URL, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        })) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.literature.search({ query: 'surface code' }, controller.signal);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RuntimeApiError);
    expect((err as Error).name).toBe('AbortError');
  });
});
