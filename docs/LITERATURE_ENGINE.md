# Literature engine (M3.1)

How Research Studio searches OpenAlex, Semantic Scholar, arXiv and Crossref,
turns their answers into one list of works, and keeps track of where every
value came from. Code: `packages/literature-engine` (framework-free, injectable
`fetch`), wired into the runtime by `apps/runtime/src/services/literature-service.ts`.
Routes: [`API_SPECIFICATION.md`](API_SPECIFICATION.md).

```
Browser ──POST /api/v1/literature/search──▶ Runtime: LiteratureService
                                                │  keys from SecretStore / env, cache + history + health in SQLite
                                                ▼
                                   LiteratureSearchService (engine)
                     ┌──────────────┬──────────┴───────┬──────────────┐
                 OpenAlex    Semantic Scholar        arXiv         Crossref     one client per provider,
                     └──────────────┴────────┬─────────┴──────────────┘         each behind its own ProviderHttp
                          normalise → filter → deduplicate → merge → rank → page
```

The browser never contacts a provider: the production CSP limits it to the
loopback runtime, and provider keys never leave the runtime.

## 1. Providers

| | OpenAlex | Semantic Scholar | arXiv | Crossref |
| --- | --- | --- | --- | --- |
| Base URL (override) | `https://api.openalex.org` (`RS_OPENALEX_URL`) | `https://api.semanticscholar.org/graph/v1` (`RS_SEMANTIC_SCHOLAR_URL`) | `https://export.arxiv.org/api/query` (`RS_ARXIV_URL`) | `https://api.crossref.org` (`RS_CROSSREF_URL`) |
| Search | `/works?search=` / `filter=title.search:`, `title_and_abstract.search:`, `raw_author_name.search:` | `/paper/search` | `search_query` (`all:`, `ti:`, `abs:`, `au:`, `cat:`) | `/works?query.bibliographic=` / `query.author=` |
| Lookups | `/works/doi:…`, `/works/W…`, `/authors/A…`, `filter=cites:` / `cited_by:` | `/paper/DOI:…`, `/paper/ARXIV:…`, `/paper/{id}`, `/citations`, `/references`, `/author/{id}` (+ `/papers`) | `id_list=` (new and old style, versions kept) | `/works/{doi}` |
| Key | Optional, `api_key` query parameter | Optional, `x-api-key` header | none | none |
| Contact address | `mailto` if `RS_LITERATURE_MAILTO` is set | never sent | never sent | `mailto` if set (polite pool) |
| Pacing | 150 ms between starts, 2 at a time | 1.1 s between starts, 1 at a time | 3 s after the previous response ends, 1 at a time | public pool 1 s, 1 at a time; polite pool 350 ms, 3 at a time |
| Request timeout | 15 s | 15 s | 20 s | 15 s |
| Retries | 2 | 2 | 1 | 2 |

Pacing follows each provider's published terms (checked 2026-11-02): arXiv
asks for one request every 3 seconds on one connection; Crossref's public pool
allows 1 list request per second at concurrency 1 (3/s and 3 with a contact
address); Semantic Scholar's keyless pool is shared and often answers 429, a
key gives 1 request per second; OpenAlex meters usage in dollars ($0.10/day
without a key, $1/day with a free key; a search costs $0.001).

What each provider cannot do is reported, not hidden:

- arXiv only has preprints: a search filtered to other types skips it
  (`skipped`, "arXiv only has preprints"). It reports no citation counts, so
  "Most cited" leaves its results in relevance order (a note says so), and it
  sorts by first submission date.
- Semantic Scholar has no title-only search: titles are checked after
  retrieval (note). Categories are approximated by its fields of study, and
  OpenAlex's by its fields (note naming the fields used).
- Crossref's title mode filters titles locally; some of its records carry no
  abstract.

## 2. HTTP layer (`providers/http.ts`)

One `ProviderHttp` per provider:

- **Queue.** A `RateGate` enforces the minimum interval and concurrency
  above, measured from request start (or, for arXiv, from the end of the
  previous response). The gate lives as long as the engine, so separate
  searches share it.
- **Timeouts and cancellation.** Each request has its own timeout and follows
  the caller's `AbortSignal`. The runtime ties that signal to the HTTP
  connection: closing the tab or pressing **Cancel** aborts the provider
  requests (tested end to end: the mock provider sees its connection close).
  A whole search also has a deadline (`RS_LITERATURE_TIMEOUT_MS`, default
  25 s); providers still running then are reported as failed ("… did not
  answer in time") and the others' results are returned.
- **Retries.** Only for HTTP 429, 5xx and network errors. Waits honour
  `Retry-After` (seconds or HTTP date); otherwise exponential backoff of
  1 s · 2ⁿ plus up to 25 % jitter. 4xx other than 429 are never retried.
- **Limits.** Responses over 8 MB are refused, checked against
  `Content-Length` and while streaming.
- **Redaction.** `api_key` and `mailto` are removed from every URL before it
  is stored (source records keep a `requestUrl`), logged or put in an error.
- **Observations.** Every response is reported to the runtime as provider
  health (last success, last error and its kind) together with the rate-limit
  headers the provider sent (OpenAlex `x-ratelimit-*-usd`, Semantic Scholar
  `x-ratelimit-*`, Crossref `x-rate-limit-*` and `x-api-pool`). The Sources
  dialog shows them as reported.

Errors are typed (`LiteratureProviderError` with `kind`: `rate_limited`,
`timeout`, `cancelled`, `network`, `unavailable`, `bad_request`,
`unauthorized`, `invalid_response`) and their messages start with the
provider's name. A lookup that finds nothing is not an error: it returns no
record (cached for an hour).

## 3. Query interpretation

`interpretQuery` recognises, in this order: arXiv IDs (new style
`2106.15928v2`, old style `quant-ph/9605011`, `arXiv:` prefixes, arxiv.org
URLs and arXiv DOIs `10.48550/arXiv.…`), DOIs (bare, `doi:`, `doi.org` URLs),
OpenAlex work IDs (`W…`, openalex.org URLs) and Semantic Scholar paper IDs. An
identifier is resolved exactly through every provider that supports that
identifier, never searched as text. Anything else is a text query; its
*intent* (a year such as `2019`, "recent"/"latest", "review"/"survey")
nudges ranking but is not turned into filters.

## 4. Normalisation

Every provider record becomes a `ScholarlySourceRecord` (one provider's view,
not merged):

- DOIs lower-cased without prefix or URL; arXiv IDs without version (the
  version is kept separately); OpenAlex IDs as `W…`/`A…`.
- Dates kept as published, online, print, submitted, updated (`YYYY`,
  `YYYY-MM` or `YYYY-MM-DD`); invalid parts are dropped (`2017-13-01` →
  `2017`), never guessed.
- Authors with given/family names where the provider splits them; family keys
  keep particles (`van Beethoven` → `vanbeethoven`) for matching.
- JATS/HTML markup stripped from titles and abstracts (Crossref); OpenAlex's
  inverted-index abstracts rebuilt.
- Publication types mapped to one list (`journal-article`, `preprint`,
  `conference-paper`, …); the provider's own label stays in `rawType`.
- Records that do not match the provider's documented format, or that the
  mapper cannot use, are left out and counted: the provider's status becomes
  `partial` with "N incomplete or unreadable record(s) left out".

Filters are re-checked on every record after normalisation, whatever the
provider claims to have applied. A record with no year (or no type) does not
pass a year (or type) filter.

## 5. Deduplication (`deduplication/`)

Records are grouped with union-find. Two records are the same work when, in
this order:

1. their normalised DOIs are equal (arXiv DOIs excluded, they are arXiv IDs),
2. their arXiv IDs are equal (any version),
3. a stable provider ID matches (OpenAlex, Semantic Scholar, PubMed),
4. title, authors and year all agree: titles nearly identical (Dice
   coefficient ≥ 0.95 on character bigrams of the normalised title, lengths
   within 10 %, and exactly the same numbers and numerals, so "Part 1" never
   matches "Part 2"); first authors' family names equal, or at least half of
   the shorter author list shared (records without authors never match on
   title); years at most one apart (unknown years do not block).

A merge is refused whenever the group would hold two different DOIs or two
different arXiv IDs: a preprint and its journal version, which carry
different DOIs and an arXiv ID, are joined only through that arXiv ID, and
two works never collapse because of similar titles alone.

## 6. Merging (`metadata/`)

Each field of the merged `ScholarlyWork` comes from the first provider in its
precedence list that has a value:

| Field | Precedence |
| --- | --- |
| Title, venue, publisher, dates, volume/issue/pages, DOI | Crossref, OpenAlex, Semantic Scholar, arXiv |
| Authors | Crossref, OpenAlex, arXiv, Semantic Scholar |
| Abstract | arXiv, Semantic Scholar, OpenAlex, Crossref |
| Publication type | Crossref, OpenAlex, Semantic Scholar, arXiv |
| Open access | OpenAlex, Semantic Scholar, arXiv, Crossref |
| PDF link | OpenAlex, arXiv, Semantic Scholar, Crossref |
| Cited-by count | OpenAlex, Semantic Scholar, Crossref |
| Reference count | OpenAlex, Crossref, Semantic Scholar |

Provenance is kept, not flattened:

- `sourceRecords`: every provider record, with its provider ID, record page,
  redacted request URL and retrieval time.
- `abstractSource` and `citation.citedBySource` name the provider behind the
  abstract and the count shown; `citation.observations` keeps every
  provider's counts with their retrieval times. Counts are never added up or
  averaged.
- `conflicts`: fields where providers disagree beyond formatting (title,
  number of authors, year, full publication date, venue, type, open access),
  with each provider's value and which one is shown.
- Author lists are taken from one provider; other providers only add missing
  ORCID iDs, affiliations and provider author IDs to the matching author.

Canonical work ID: `doi:<doi>` if there is a (non-arXiv) DOI, else
`arxiv:<id>`, else `openalex:W…`, else `semantic-scholar:<id>`. Every form
resolves again through `GET /literature/works/:id`.

## 7. Ranking and sorting (`search/ranking.ts`)

Relevance is a deterministic score; the same results always come out in the
same order:

| Signal | Points |
| --- | --- |
| Title equals the query | 60 |
| Title contains the query as a phrase (2+ words) | 30 |
| Share of query terms in the title (a term also matches a word extending it by up to 3 letters: code → codes) | up to 30 |
| Share of query terms in the abstract; phrase in the abstract | up to 12; +6 |
| Author match: author mode (share of name words) / a query word is an author's family name | up to 40 / 10 |
| Best position in a provider's own ranking | up to 10 |
| Returned by more than one provider | 3 per extra provider, up to 6 |
| Year named in the query; "recent" (newer is better); "review" and the work is a review | 8; up to 6; 8 |

Citation counts are not a relevance signal. Sorts: **Relevance** (score,
then newest, then title), **Newest/Oldest** (best known date; works without
a date last), **Most cited** (shown count; works without one last). Ties
always fall back to score, date, title and ID.

## 8. Pagination

The first request asks every selected provider for one page. Results are
merged, ranked, and the first `limit` (default 20, at most 50) are returned
with a cursor. The cursor names server-side state: each provider's position,
the records fetched but not yet shown, and the IDs already returned. "Load
more" asks the providers that still have results for their next page only
when fewer than `limit` records are held, and never returns a work twice (a
work whose DOI, arXiv ID or provider ID was already returned is dropped). Cursors expire after 30 minutes (at most
200 are kept); a cursor from another search or an expired one is a 400
`VALIDATION_FAILED`. `total` is the largest total any provider reported, an
estimate, since providers count differently.

## 9. Caching and persistence

SQLite tables (migration `packages/database/migrations/0001_literature.sql`):

| Table | Contents | Limits |
| --- | --- | --- |
| `literature_cache` | Provider answers: `search:<provider>:<hash of the request>` and `record:<provider>:<scheme>:<id>`, with provider, kind, JSON value, retrieval and expiry times, size | Searches 1 h (arXiv 6 h), records 7 days, "not found" 1 h. Expired rows purged at start and hourly; at most 5 000 rows (those expiring soonest are dropped first). A key change clears that provider's rows. **Clear saved answers** clears all. |
| `literature_search_history` | Query, request (filters, sort, sources), result count, per-provider status, time | 200 rows. Off: nothing is recorded and existing rows are deleted. |
| `literature_provider_state` | Last success, last error (kind, message), last rate-limit headers | Reset when the provider's key changes. |

Cached search results report `fromCache: true` per provider. Preferences
(default sources, sort, page size, history on/off) and the per-provider on/off
switches live in the `settings` table under scope `literature`. API keys are
only in the `SecretStore` (`literature:openalex`, `literature:semantic-scholar`).

## 10. Citations and BibTeX (`format/`, browser-safe)

- `toBibTeX`: entry type from the publication type (`article`,
  `inproceedings`, `incollection`, `book`, `phdthesis`, `techreport`, `misc`
  for preprints and datasets), fields only from the merged work (title,
  authors as `Family, Given`, journal/booktitle, year, volume, number, pages
  with `--`, publisher/school/institution, DOI, arXiv `eprint` with
  `archivePrefix` and `primaryClass`, URL when there is no DOI). LaTeX special
  characters are escaped; control characters become spaces.
- `citationKey`: `familyYearWord`, ASCII only (`shor1995scheme`; ø, æ, ß and
  accents folded).
- `formatCitation`: an APA-like reference (`Shor, P. W. (1995). Title.
  Venue, 52(4), R2493–R2496. https://doi.org/…`).
- `safeExternalUrl`: only `http(s)` URLs become links.

The web app imports only `@research-studio/literature-engine/format`; no
provider or HTTP code reaches the browser bundle.

## 11. Testing

- **Fixtures.** Real responses recorded from the four APIs on 2026-11-02/03
  without keys, unedited, documented with request URL, status and headers in
  `packages/literature-engine/test/fixtures/README.md` and `manifest.json`.
  One gap: Semantic Scholar answered every keyless `/paper/search` with 429,
  so its search tests use the documented search envelope around a recorded
  paper.
- **Engine** (`pnpm --filter @research-studio/literature-engine test`): HTTP
  layer (pacing, retries, `Retry-After`, timeouts, cancellation, size cap,
  redaction), every mapper against the fixtures, normalisers, deduplication
  and merge cases, ranking and sorts, query parsing, cursors, partial failures
  and deadlines, BibTeX and citations. `fetch` is injected; no network.
- **Runtime** (`apps/runtime/test/literature.test.ts`): the real app against
  `e2e/mock-literature-server.mjs`, which serves the fixtures and can be told
  to rate-limit, fail or hang. Covers search, merging, caching, DOI/arXiv
  resolution, authors, partial failure, 502/404/400 mapping, deadline,
  cancellation on client disconnect, keys (secret store, header only, audit,
  never echoed), environment keys, contact address only to OpenAlex and
  Crossref, provider switches, preferences, history and `RS_LITERATURE=off`.
- **Web** (`apps/web/test/literature.test.tsx`, jsdom): search, provenance,
  provider status, live-region announcements, details, safe links, BibTeX,
  citation and `.bib` download, keyboard navigation, cancellation (button and
  Esc), filter validation, re-runs, paging, errors, the Sources dialog, and
  axe-core audits.
- **End to end** (`e2e/literature.spec.ts`): the real runtime and web app
  against the mock APIs: search and details, clipboard and download, DOI
  resolution, related works, history and cache, rate limits, cancellation
  reaching the provider, key storage and header-only use, a phone-sized dark
  layout, and axe audits.
- **Live** (`test/live.test.ts`, only with `RS_LITERATURE_LIVE=1`): one real
  search and one lookup per provider, plus a DOI lookup merged across all
  providers.

## 12. Known limitations

- Without keys, Semantic Scholar's shared pool often answers 429; the search
  continues without it and says so. A free key fixes this.
- OpenAlex without a key has a small daily allowance shared by everyone
  behind the same IP address.
- Relevance across providers is approximate: each provider ranks by its own
  rules, and the merged score uses only the metadata returned.
- Provider category filters other than arXiv's are approximations by field.
- Only the first 8 authors are listed in details before "+N more"; BibTeX
  always lists all authors the chosen provider returned.

## 13. Use by the personal library (M3.2)

The library (`packages/research-library`, see [`LIBRARY.md`](LIBRARY.md))
does not call providers. The runtime gives it a `ScholarlyLookup` built on
`LiteratureService`: `resolveDoi`, `resolveArxiv`, `work(id)` and `search`
(with `saveHistory: false`, so the library's own lookups never appear in the
search history). It reuses the engine's normalisers (`normalizeDoi`,
`parseArxivId`, `titleKey`) and the `format` module's BibTeX writer, and
stores the merged `ScholarlyWork` (with its source records) as the durable copy
of a paper's metadata. With `RS_LITERATURE=off` the library still works without
lookups.
