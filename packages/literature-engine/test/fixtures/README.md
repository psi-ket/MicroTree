# Literature provider fixtures

Real responses recorded from the four public APIs on **2026-11-02 (UTC)**, used
by the mocked-HTTP tests. `manifest.json` lists, for every file, the exact
request URL, HTTP status, retrieval time and the response headers that matter
(rate limits, content type).

- No API key or contact address (`mailto`) was sent. Keyless requests are
  enough for every file here.
- Responses are stored as returned (pretty-printed JSON; XML byte-for-byte).
  Nothing was edited, so the tests see real-world quirks: Semantic Scholar's
  trailing full stop in titles and its 2027 publication year on a citing paper,
  differing citation counts between providers, OpenAlex display names that are
  never split into given/family names.

## Files

| File | Request | Status |
| --- | --- | --- |
| `openalex/search-quantum-error-correction.json` | `/works?search=quantum error correction&per_page=3` | 200 |
| `openalex/work-doi-physreva.52.r2493.json` | `/works/doi:10.1103/PhysRevA.52.R2493` (Shor 1995) | 200 |
| `openalex/work-doi-arxiv-1706.03762.json` | `/works/doi:10.48550/arXiv.1706.03762` | 200 |
| `openalex/cites-W1999706070.json` | `/works?filter=cites:W1999706070&per_page=3` | 200 |
| `openalex/author-A5020744800.json` | `/authors/A5020744800` (Peter W. Shor) | 200 |
| `openalex/not-found.json` | `/works/W0000000000` | 404 |
| `semantic-scholar/paper-doi-physreva.52.r2493.json` | `/paper/DOI:10.1103/PhysRevA.52.R2493` | 200 |
| `semantic-scholar/paper-arxiv-1706.03762.json` | `/paper/ARXIV:1706.03762` | 200 |
| `semantic-scholar/citations-physreva.52.r2493.json` | `/paper/DOI:…/citations?limit=3` | 200 |
| `semantic-scholar/author-1741101.json` | `/author/1741101` | 200 |
| `semantic-scholar/rate-limited.json` | `/paper/search?query=quantum error correction` | 429 |
| `semantic-scholar/not-found.json` | `/paper/DOI:10.5555/does-not-exist-research-studio` | 404 |
| `arxiv/search-surface-code.xml` | `search_query=ti:"surface code" AND cat:quant-ph&max_results=3` | 200 |
| `arxiv/id-1706.03762v5.xml` | `id_list=1706.03762v5` | 200 |
| `arxiv/id-quant-ph-9605011.xml` | `id_list=quant-ph/9605011` (old-style ID) | 200 |
| `arxiv/error-bad-id.xml` | `id_list=not-an-id` (arXiv's Atom error entry) | 400 |
| `crossref/search-decoherence-shor.json` | `/works?query.bibliographic=scheme for reducing decoherence&query.author=Shor&rows=3` | 200 |
| `crossref/work-10.1103-physreva.52.r2493.json` | `/works/10.1103/PhysRevA.52.R2493` | 200 |
| `crossref/not-found.json` | `/works/10.5555/does-not-exist-research-studio` | 404 |
| `crossref/select-validation-failure.json` | `/works?rows=0&select=subtype` (recorded 2026-11-03; lists the valid `select` fields) | 400 |

## Gap: Semantic Scholar search

No successful keyless `/paper/search` response could be recorded: the last
recording run made thirteen attempts over about 26 minutes (20 s to 240 s
apart, after earlier runs had failed the same way), and all returned
`429 Too Many Requests` (kept as `rate-limited.json`). The search tests
therefore wrap the recorded paper (`paper-doi-physreva.52.r2493.json`) in the
documented `/paper/search` envelope `{ total, offset, next, data: [...] }`
(see the Graph API OpenAPI description). The search request itself is covered
by the opt-in live test.

## Re-recording

Fixtures were fetched with a small script outside the repository (plain GET
requests with a descriptive User-Agent, honouring each provider's published
rate limits: arXiv 3 s between requests, Crossref public pool 1 request/s,
Semantic Scholar retried with growing waits after 429). When re-recording,
keep the same requests so the assertions about well-known works (Shor 1995,
Vaswani et al. 2017) stay valid, and update `manifest.json`.

## Live smoke tests

`test/live.test.ts` sends real requests and is skipped unless
`RS_LITERATURE_LIVE=1`. Optional keys are read from `OPENALEX_API_KEY` and
`SEMANTIC_SCHOLAR_API_KEY`; CI never sets them.
