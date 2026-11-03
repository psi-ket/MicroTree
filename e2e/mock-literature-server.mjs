// Mock scholarly APIs for runtime and end-to-end tests. Answers with the
// responses recorded from the real providers (packages/literature-engine/
// test/fixtures), mounted under one prefix per provider:
//   /openalex  /s2  /arxiv/api/query  /crossref
// Control: POST /__scenario {"semantic-scholar":"rate_limited","openalex":"down"|"slow"|"ok"},
//          DELETE /__scenario (all "ok"), GET /__requests (recorded requests),
//          DELETE /__requests (clear), GET /__stats ({ abandoned }).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../packages/literature-engine/test/fixtures/', import.meta.url));
const fixture = (name) => readFileSync(`${FIXTURES}${name}`, 'utf8');

const S2_PAPER = JSON.parse(fixture('semantic-scholar/paper-doi-physreva.52.r2493.json'));

function openalex(path, query) {
  if (path === '/works') {
    if ((query.get('filter') ?? '').startsWith('cites:')) return [200, fixture('openalex/cites-W1999706070.json')];
    return [200, fixture('openalex/search-quantum-error-correction.json')];
  }
  if (path === '/works/doi:10.1103/physreva.52.r2493' || path === '/works/W1999706070') return [200, fixture('openalex/work-doi-physreva.52.r2493.json')];
  if (path === '/works/doi:10.48550/arxiv.1706.03762') return [200, fixture('openalex/work-doi-arxiv-1706.03762.json')];
  if (path === '/works/W2741809807') return [200, JSON.stringify({ id: 'https://openalex.org/W2741809807' })];
  if (path === '/authors/A5020744800') return [200, fixture('openalex/author-A5020744800.json')];
  return [404, fixture('openalex/not-found.json')];
}

function semanticScholar(path) {
  if (path === '/paper/search') return [200, JSON.stringify({ total: 1, offset: 0, data: [S2_PAPER] })];
  if (path === '/paper/DOI:10.1103/physreva.52.r2493/citations') return [200, fixture('semantic-scholar/citations-physreva.52.r2493.json')];
  if (path === '/paper/DOI:10.1103/physreva.52.r2493' || path === `/paper/${S2_PAPER.paperId}` || path === '/paper/649def34f8be52c8b66281af98ae884c09aef38b') {
    return [200, JSON.stringify(S2_PAPER)];
  }
  if (path === '/paper/ARXIV:1706.03762') return [200, fixture('semantic-scholar/paper-arxiv-1706.03762.json')];
  if (path === '/author/1741101') return [200, fixture('semantic-scholar/author-1741101.json')];
  if (path === '/author/1741101/papers') return [200, JSON.stringify({ data: [S2_PAPER] })];
  return [404, fixture('semantic-scholar/not-found.json')];
}

function arxiv(query) {
  const id = query.get('id_list');
  if (id === '1706.03762' || id === '1706.03762v5') return [200, fixture('arxiv/id-1706.03762v5.xml')];
  if (id === 'quant-ph/9605011') return [200, fixture('arxiv/id-quant-ph-9605011.xml')];
  if (query.has('search_query')) return [200, fixture('arxiv/search-surface-code.xml')];
  return [400, fixture('arxiv/error-bad-id.xml')];
}

function crossref(path) {
  if (path === '/works') return [200, fixture('crossref/search-decoherence-shor.json')];
  if (path === '/works/10.1103/physreva.52.r2493') return [200, fixture('crossref/work-10.1103-physreva.52.r2493.json')];
  return [404, fixture('crossref/not-found.json')];
}

const PREFIXES = [
  ['/openalex', 'openalex'],
  ['/s2', 'semantic-scholar'],
  ['/arxiv/api/query', 'arxiv'],
  ['/crossref', 'crossref'],
];

export async function startMockLiteratureServer({ port = 0, host = '127.0.0.1' } = {}) {
  const scenario = {};
  const requests = [];
  /** Requests in "slow" mode that the client gave up on (closed the connection). */
  const stats = { abandoned: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/__scenario' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      Object.assign(scenario, JSON.parse(raw || '{}'));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__scenario' && req.method === 'DELETE') {
      for (const key of Object.keys(scenario)) scenario[key] = 'ok';
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
      return;
    }
    if (url.pathname === '/__requests') {
      if (req.method === 'DELETE') requests.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests));
      return;
    }
    const match = PREFIXES.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const [prefix, provider] = match;
    const path = decodeURIComponent(url.pathname.slice(prefix.length)) || '/';
    requests.push({ provider, path, query: Object.fromEntries(url.searchParams), headers: { 'x-api-key': req.headers['x-api-key'] ?? null, 'user-agent': req.headers['user-agent'] ?? null } });

    const mode = scenario[provider] ?? 'ok';
    if (mode === 'rate_limited') {
      res.writeHead(429, { 'content-type': 'application/json' }).end(fixture('semantic-scholar/rate-limited.json'));
      return;
    }
    if (mode === 'down') {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('Service Unavailable');
      return;
    }
    if (mode === 'slow') {
      // Never answers; the client's deadline or cancellation must end the request.
      req.socket.on('close', () => {
        stats.abandoned++;
        res.destroy();
      });
      return;
    }
    const [status, body] =
      provider === 'openalex' ? openalex(path, url.searchParams) : provider === 'semantic-scholar' ? semanticScholar(path) : provider === 'arxiv' ? arxiv(url.searchParams) : crossref(path);
    res.writeHead(status, { 'content-type': provider === 'arxiv' ? 'application/atom+xml; charset=utf-8' : 'application/json' }).end(body);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    env: {
      RS_OPENALEX_URL: `${origin}/openalex`,
      RS_SEMANTIC_SCHOLAR_URL: `${origin}/s2`,
      RS_ARXIV_URL: `${origin}/arxiv/api/query`,
      RS_CROSSREF_URL: `${origin}/crossref`,
    },
    scenario,
    requests,
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = await startMockLiteratureServer({ port: Number(process.env.MOCK_LITERATURE_PORT ?? 4498) });
  console.info(`mock literature APIs on ${mock.origin}`);
}
