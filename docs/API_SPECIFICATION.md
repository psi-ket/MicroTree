# Runtime API — literature (M3.1) and library (M3.2) routes

Library routes are described in [Library routes (M3.2)](#library-routes-m32) below.

All routes live under `/api/v1`, need a session (`Authorization: Bearer
<session token>`) and pass the runtime's Host and Origin checks, like every
other route. Bodies and responses are JSON. The Zod schemas in
`packages/api-contracts/src/literature.ts` are the source of truth; they are
pinned to the TypeScript types in `packages/shared-types/src/literature.ts`
by compile-time equality checks, and the typed client exposes every route as
`client.literature.*`.

Data types (`ScholarlyWork`, `ScholarlySourceRecord`, `ProviderSearchOutcome`,
`LiteratureProviderStatus`, …) are described in
[`LITERATURE_ENGINE.md`](LITERATURE_ENGINE.md) and in the type definitions.

## Errors

```json
{ "error": { "code": "PROVIDER_ERROR", "message": "No provider could be reached…", "details": { "providerStatus": [ … ] } } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Invalid body, parameter or query; invalid DOI/arXiv ID/author ID; unknown, expired or foreign cursor |
| `BAD_REQUEST` | 400 | The request was cancelled while the response was being prepared |
| `UNAUTHORIZED` | 401 | No or invalid session |
| `NOT_FOUND` | 404 | No provider knows the work, identifier or author; unknown history entry |
| `NOT_CONFIGURED` | 409 | Literature search is off (`RS_LITERATURE=off`), or the provider named is turned off |
| `RATE_LIMITED` | 429 | Every provider that answered was rate limited (lookups, related works), or the author's provider is |
| `PROVIDER_ERROR` | 502 | No provider could answer (`details.providerStatus` says why for each) |
| `TIMEOUT` | 504 | An author lookup ran out of time |

A search where *some* providers fail is not an error: it returns 200 with
the failures in `providerStatus`.

## Providers

### `GET /literature/providers`

```json
{
  "providers": [LiteratureProviderStatus, …],   // always in the order openalex, semantic-scholar, arxiv, crossref
  "contactConfigured": false,                    // RS_LITERATURE_MAILTO is set (the address itself is never returned)
  "cache": { "entries": 42, "bytes": 183211 }
}
```

`LiteratureProviderStatus`: `id`, `name`, `enabled`, `authentication`
(plain-language requirement), `acceptsApiKey`, `apiKeySource` (`stored` |
`environment` | `null`; the key is never returned), `connection` (`unknown` |
`ok` | `rate_limited` | `error` | `disabled`), `lastSuccessAt`,
`lastErrorAt`, `lastError`, `limits` (documented limits for the current
configuration), `rateLimit` (rate-limit headers last reported by the
provider, or `null`), `homepage`, `termsUrl`.

### `PATCH /literature/providers/:providerId`

Body (at least one field): `{ "enabled"?: boolean, "apiKey"?: string | null }`.
`apiKey` is 8–256 printable ASCII characters; `null` removes the stored key.
Keys are accepted only by `openalex` and `semantic-scholar` (400 otherwise),
stored in the runtime's secret store as `literature:<provider>`, and never
returned. Setting or removing a key clears that provider's cache and health
record. Audited as `literature.provider.update` with `{ enabled }` and/or
`{ apiKey: "stored" | "removed" }`.

Response: `{ "provider": LiteratureProviderStatus }`.

### `POST /literature/providers/:providerId/test`

Makes one cheap real request (a known lookup) and returns the updated
`{ "provider": LiteratureProviderStatus }`. A failed test is still a 200: the
failure is in `connection` and `lastError`. 409 if the provider is off.

## Search

### `POST /literature/search`

```json
{
  "query": "surface code decoder",            // 1–500 characters; a DOI or arXiv ID is resolved exactly
  "mode": "all",                              // all | title | author | title-abstract
  "providers": ["openalex", "arxiv"],         // default: preferences.providers
  "filters": {
    "authors": ["Fowler, Austin"],            // up to 5
    "yearFrom": 2015, "yearTo": 2024,         // 1000–2999, yearFrom ≤ yearTo
    "publicationTypes": ["journal-article", "preprint"],
    "venues": ["Physical Review Letters"],    // up to 5
    "openAccessOnly": true,
    "categories": ["quant-ph", "cs.LG"]       // arXiv categories or archives; up to 20
  },
  "sort": "relevance",                        // relevance | newest | oldest | citations; default: preferences.sort
  "limit": 20,                                // 1–50; default: preferences.pageSize
  "cursor": "…"                               // from a previous response; the other fields must match that search
}
```

Unknown fields are rejected. Body limit 16 KiB.

```json
{
  "results": [{ "work": ScholarlyWork, "score": 87.5, "signals": ["title-phrase", "found-by-2-providers"] }],
  "total": 264717,                                         // largest total a provider reported (estimate)
  "pagination": { "hasMore": true, "nextCursor": "…" },
  "providerStatus": [
    { "provider": "openalex", "status": "success", "resultCount": 20, "total": 264717, "durationMs": 412, "fromCache": false },
    { "provider": "semantic-scholar", "status": "rate_limited", "resultCount": 0, "total": null,
      "error": "Semantic Scholar: rate limit reached; try again later", "durationMs": 3120, "fromCache": false },
    { "provider": "arxiv", "status": "skipped", "resultCount": 0, "total": null, "error": "arXiv only has preprints", "durationMs": 0, "fromCache": false },
    { "provider": "crossref", "status": "success", "resultCount": 18, "total": 9120, "notes": ["…"], "durationMs": 1210, "fromCache": true }
  ],
  "query": { "kind": "text", "text": "surface code decoder", "identifier": null }
}
```

- `status`: `success`, `partial` (some records unreadable; `error` says how
  many), `failed`, `rate_limited`, `skipped` (not asked: turned off, not
  selected, or unable to serve the filters).
- `notes`: how a provider handled the request where it differs from it
  (approximate category filter, unsupported sort).
- `score` is `null` for exact identifier matches.
- `query.kind`: `text`, `doi`, `arxiv`, `openalex`, `semantic-scholar`.
- The whole search ends after `RS_LITERATURE_TIMEOUT_MS` (default 25 s);
  providers still running are reported as `failed`.
- Closing the connection cancels the providers' requests.
- First pages are recorded in the search history when it is on.

## Works

### `GET /literature/works/:workId`

`workId` is a canonical ID, URL-encoded as one path segment
(`doi%3A10.1103%2Fphysreva.52.r2493`, `arxiv%3Aquant-ph%2F9605011`,
`openalex%3AW1999706070`, `semantic-scholar%3A<id>`). The work is looked up
through every enabled provider that supports the identifier and merged.

Response: `{ "work": ScholarlyWork, "providerStatus": [ProviderSearchOutcome] }`.
404 when no provider knows it.

### `GET /literature/works/:workId/references?limit=25` · `GET /literature/works/:workId/citations?limit=25`

`limit` 1–100 (default 25). Answered by the first provider that can (OpenAlex,
then Semantic Scholar).

```json
{ "works": [ScholarlyWork], "total": 2431, "provider": "openalex", "providerStatus": [ … ] }
```

`provider` is `null` when no provider lists them for this work.

### `GET /literature/resolve/doi/*` · `GET /literature/resolve/arxiv/*`

The rest of the path is the identifier, each segment URL-encoded
(`/literature/resolve/doi/10.1103/PhysRevA.52.R2493`,
`/literature/resolve/arxiv/quant-ph/9605011`, `/literature/resolve/arxiv/1706.03762v5`).
DOIs may be given as `doi.org` URLs; an arXiv DOI (`10.48550/arXiv.…`) is
resolved as an arXiv ID.

```json
{ "works": [ScholarlyWork, …], "providerStatus": [ … ] }
```

The work the identifier names comes first, followed by works found through
it (for example a journal version that provider data links to the preprint).
400 for an invalid identifier, 404 when no provider knows it, 502/429 when
none could be reached.

## Authors

### `GET /literature/authors/:authorId`

`authorId`: `openalex:A<digits>` or `semantic-scholar:<digits>` (as found in a
work's `authors[].providerIds`). 409 if that provider is off.

```json
{
  "author": {
    "id": "openalex:A5020744800", "provider": "openalex", "name": "Peter W. Shor", "orcid": "0000-…",
    "affiliations": ["Massachusetts Institute of Technology"], "worksCount": 312, "citedByCount": 90210, "hIndex": 71,
    "recordUrl": "https://openalex.org/A5020744800", "retrievedAt": "…", "works": [ScholarlyWork, …]
  }
}
```

Counts are as reported by `provider` at `retrievedAt`.

## History

### `GET /literature/history?limit=50`

`limit` 1–200 (default 50). Newest first.

```json
{ "entries": [{ "id": 7, "query": "surface code", "request": LiteratureSearchRequest, "resultCount": 20,
                "providers": [{ "provider": "openalex", "status": "success", "resultCount": 20 }], "createdAt": "…" }] }
```

### `DELETE /literature/history/:entryId` → 204 · `DELETE /literature/history` → 204

Clearing the whole history is audited (`literature.history.clear`).

## Preferences

### `GET /literature/preferences` · `PATCH /literature/preferences`

```json
{ "preferences": { "providers": ["openalex", "semantic-scholar", "arxiv", "crossref"], "sort": "relevance", "pageSize": 20, "saveHistory": true } }
```

PATCH takes any non-empty subset (`providers` at least one, `pageSize` 5–50).
Setting `saveHistory` to `false` deletes the existing history.

## Cache

### `DELETE /literature/cache`

Removes every cached provider answer. Response: `{ "cleared": 42 }`. Audited
(`literature.cache.clear`).

## Configuration (runtime environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_LITERATURE` | `on` | `off` disables every route above (409) and all provider traffic |
| `RS_LITERATURE_MAILTO` | unset | Contact address sent to OpenAlex and Crossref only |
| `RS_LITERATURE_TIMEOUT_MS` | `25000` | Deadline for one search (3 000–120 000) |
| `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` | unset | Keys used when none is stored |
| `RS_OPENALEX_URL`, `RS_SEMANTIC_SCHOLAR_URL`, `RS_ARXIV_URL`, `RS_CROSSREF_URL` | public endpoints | Base URL overrides (mirrors, tests) |

---

## Library routes (M3.2)

Same rules as above (session, Host/Origin checks, JSON). Schemas:
`packages/api-contracts/src/library.ts`, pinned to
`packages/shared-types/src/library.ts`; client: `client.library.*` and
`client.references.*`. No response contains a file-system path: files are
addressed by attachment ID. Background work answers **202** with a job
(`ImportJob`), whose progress is pushed on the event stream as `library.job`;
data changes are announced as `library.changed` (`kind`, `ids` only).
Behaviour is described in [`LIBRARY.md`](LIBRARY.md).

### Errors (in addition to the table above)

| Code | HTTP | When |
| --- | --- | --- |
| `CONFLICT` | 409 | `details.reason`: `KEY_IN_USE` (changing a key used by a project without `confirm`), `STALE_PREVIEW` (the `.bib` changed since the preview); also duplicate collection names, Zotero items changed remotely |
| `PAYLOAD_TOO_LARGE` | 413 | A file over `RS_LIBRARY_MAX_PDF_BYTES`, or a reference text over 20 MB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | A file that is not a valid PDF (declared type, signature or parse) |
| `NOT_CONFIGURED` | 409 | Identifier lookup with `RS_LITERATURE=off`; Zotero not connected |
| `PATH_VIOLATION` | 403 | A `.bib` path outside the project (audited) |

### Items

| Route | Body / query | Response |
| --- | --- | --- |
| `GET /library/overview` | | `{ overview }`: counts by status, with PDF, favourites, archived, needing review, collections, recently added and opened |
| `GET /library/items` | `q`, `readingStatus`, `metadataStatus`, `collectionId`, `tag`, `favorite`, `hasPdf`, `author`, `yearFrom`, `yearTo`, `projectId`, `archived` (`active`, `archived`, `all`), `sort`, `limit` (≤ 200), `offset` | `{ items, total, offset, limit }` (summaries) |
| `POST /library/items` | `{ source: "work", workId, fetchOpenAccessPdf? }` · `{ source: "identifier", kind: "doi"\|"arxiv", value }` · `{ source: "manual", reference }`; each with optional `options` (status, favourite, tags, collections, notes, key). A `work` is fetched by the runtime from its ID; the browser never supplies its metadata | 201 when created, 200 when already present: `{ item, created, duplicateReason, likelyDuplicates, job }` (`job` when an open-access download started) |
| `GET /library/items/:itemId` | | `{ item }` (full, with work, files, collections, projects, Zotero links) |
| `PATCH /library/items/:itemId` | any of `readingStatus`, `isFavorite`, `notes`, `tags`, `archived`, `edits` (corrections), `revertFields`, `bibtexType`, `bibtexExtra` | `{ item }` |
| `POST /library/items/:itemId/opened` | | 204; sets `lastOpenedAt` only |
| `POST /library/items/bulk` | `{ itemIds, action }`: `set-status`, `favorite`, `archive`, `add-tags`, `remove-tags`, `add-to-collection`, `remove-from-collection` | `{ updated }` |
| `POST /library/items/deletion-impact` | `{ itemIds }` | `{ items, attachments, projects: [{ id, name, items }], externalLinks }` |
| `POST /library/items/delete` | `{ itemIds }` | `{ deleted }`; audited |
| `GET /library/items/:itemId/citation-keys` | | `{ suggestions }` |
| `PUT /library/items/:itemId/citation-key` | `{ key, confirm? }` | `{ item }`; 409 `KEY_IN_USE` with `details.projects` unless `confirm`; audited |
| `POST /library/citation-keys/regenerate` | `{ itemIds, replaceExisting }` | `{ changed: [{ id, from, to }], kept }`; keys of items linked to projects are kept |
| `POST /library/items/:itemId/match` | `{ action: "accept-candidate", candidateWorkId }` · `{ action: "link-work", workId }` (canonical ID, DOI or arXiv ID) · `{ action: "keep-unresolved" }` | `{ item }` |
| `POST /library/items/:itemId/refresh` | | `{ item }`; re-reads the work from the sources, corrections kept |
| `GET /library/duplicates` | | `{ groups: [{ items, reason }] }` |
| `POST /library/merge` | `{ keepId, dropId }` | `{ item, droppedKey }`; audited |
| `GET /library/tags` | | `{ tags: [{ id, name, itemCount }] }` |
| `GET /library/preferences` · `PATCH /library/preferences` | `citationKeyFormat`, `customKeyTemplate`, `fetchOpenAccessPdf` | `{ preferences }` |

### Files

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /library/items/:itemId/attachments` | multipart, one PDF | 202 `{ job }` |
| `POST /library/items/:itemId/fetch-pdf` | | 202 `{ job }`; 404 when the work lists no open-access PDF |
| `GET /library/attachments/:attachmentId/content` | `download=1` for an attachment disposition | the bytes; `nosniff`, sandboxing CSP, `private, no-store` |
| `PATCH /library/attachments/:attachmentId` | `{ fileName }` | `{ attachment }` (display name only) |
| `DELETE /library/attachments/:attachmentId` | | 204; the stored object goes when nothing refers to it |
| `POST /library/storage/sweep` | | `{ tmpRemoved, orphansRemoved, strays, missingFiles }` (counts only) |

### Imports and jobs

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /library/imports/pdf` | multipart, up to 50 PDFs; `collectionId` query | 202 `{ job }` |
| `POST /library/imports/references/preview` | `{ format: "bibtex"\|"ris", text }` | `{ format, entries: [{ index, label, title, authors, year, doi, arxivId, citationKey, state, libraryItemId, reason }], warnings }`; nothing is stored |
| `POST /library/imports/references` | preview body + `only` (entry indices), `resolveIdentifiers`, `searchTitles`, `options` (tags, collections, status) | 202 `{ job }` |
| `POST /library/imports/identifiers` | `{ text }` (DOIs / arXiv IDs, one per line) | 202 `{ job }` |
| `GET /library/jobs` · `GET /library/jobs/:jobId` | | `{ jobs }` (latest 30) · `{ job }` |
| `POST /library/jobs/:jobId/cancel` | | `{ job }` |
| `POST /library/export` | `{ format: "bibtex"\|"ris", selection: { itemIds } \| { collectionId } \| { projectId } \| { all: true } }` | `{ format, text, count, fileName }` |

### Collections

| Route | Body | Response |
| --- | --- | --- |
| `GET /library/collections` · `POST /library/collections` | `{ name, description?, color? }` | `{ collections }` · `{ collection }` |
| `PATCH /library/collections/:collectionId` · `DELETE …` | `{ name?, description?, color? }` | `{ collection }` · 204 (papers stay) |
| `POST /library/collections/:collectionId/items` · `…/items/remove` | `{ itemIds }` | `{ count }` |
| `POST /library/collections/move` | `{ fromId, toId, itemIds }` | `{ count }` |

### Project references

| Route | Body | Response |
| --- | --- | --- |
| `GET /projects/:projectId/references` | | `{ settings: { bibFile, citeCommand }, items, citations: [{ key, occurrences, definedIn, libraryItemId, status }], bibFiles }` |
| `PATCH /projects/:projectId/references/settings` | `{ bibFile?, citeCommand? }` | `{ settings }` |
| `POST /projects/:projectId/references/items` · `…/items/remove` | `{ itemIds }` | `{ count }` |
| `POST /projects/:projectId/references/bib/preview` | `{ path?, itemIds?, changeIds? }` | `{ path, baseHash, original, proposed, changes, warnings }`; with `changeIds`, `proposed` holds only those changes; nothing is written |
| `POST /projects/:projectId/references/bib/apply` | preview body + `baseHash` (hash from the preview, `null` for a new file) | `{ path, applied }`; 409 `STALE_PREVIEW` if the file changed; audited (`library.bib.apply`) |

### Zotero

| Route | Body | Response |
| --- | --- | --- |
| `GET /library/zotero` | `probe=1` to check the local API | `{ status: { web: { configured, userId, username, canWrite, lastError }, local: { enabled, reachable, lastError }, linkedItems, conflicts } }` |
| `PUT /library/zotero/web-key` · `DELETE …` | `{ apiKey }` | `{ status }`; the key goes to the secret store and is never returned; audited without the value |
| `PUT /library/zotero/local` | `{ enabled }` | `{ status }` |
| `POST /library/zotero/import/preview` | `{ mode: "web"\|"local", collectionKey? }` | `{ mode, libraryVersion, collections, items: [{ externalItemId, version, title, itemType, creators, year, doi, hasPdf, state, libraryItemId }], skipped }` |
| `POST /library/zotero/import` | preview body + `itemKeys`, `importCollections`, `importPdfs`, `resolveIdentifiers` | 202 `{ job }` |
| `POST /library/zotero/export/preview` · `…/export` | `{ itemIds }` | `{ items: [{ libraryItemId, title, action, externalItemId }] }` · 202 `{ job }` |
| `POST /library/items/:itemId/zotero-conflict` | `{ keep: "local"\|"remote" }` | `{ item }` |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_LIBRARY_DIR` | `<RS_DATA_DIR>/library` | PDF store |
| `RS_LIBRARY_MAX_PDF_BYTES` | 100 MB (1 MB–2 GB) | Size limit per file |
| `RS_ZOTERO_URL` | `https://api.zotero.org` | Zotero Web API base |
| `RS_ZOTERO_LOCAL_URL` | `http://localhost:23119/api` | Zotero local API base |

## Document and retrieval routes (M3.3)

Same rules as above (session, Host/Origin checks, JSON, Zod validation).
Schemas: `packages/api-contracts/src/documents.ts`; client:
`client.documents.*`, `client.research.*`, `client.retrieval.*`. Documents
are addressed by **library attachment ID**; no response contains a
file-system path. Job progress is pushed as `documents.job`; index changes as
`retrieval.changed`. Behaviour: [`PAPER_INGESTION.md`](PAPER_INGESTION.md),
[`RESEARCH_RETRIEVAL.md`](RESEARCH_RETRIEVAL.md),
[`EMBEDDING_PROVIDERS.md`](EMBEDDING_PROVIDERS.md).

### Documents

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /documents/:attachmentId/process` | | 202 `{ job, created: true }`, or 200 with the unfinished job already running for it |
| `POST /documents/:attachmentId/reprocess` | | same; the active extraction stays until the new one is indexed |
| `POST /documents/:attachmentId/cancel` | | the document status |
| `GET /documents/:attachmentId/status` | | `{ attachmentId, extraction, job, embeddings: { indexedPassages, embeddablePassages, spaceId } }`; `extraction` has status, extractor and version, parser and segmenter versions, config hash, PDF SHA-256, pages, metadata, quality, warnings, counts and `stale` reasons |
| `GET /documents/:attachmentId/structure` | | `{ extraction, pages, sections, blocks, elements, references }` (404 `{ processed: false }` before processing) |
| `GET /documents/:attachmentId/sections` · `/references` · `/elements` | | the part named |
| `GET /documents/:attachmentId/passages` | `offset`, `limit` (≤ 500) | `{ extractionId, passages, total, offset, limit }` |
| `GET /documents/jobs` | `status` (`active`, `failed`, `all`), `limit` | `{ jobs }` |
| `POST /documents/process-all` | | `{ queued, alreadyQueued }`: every PDF without an extraction or an unfinished job |

### Research search

| Route | Body | Response |
| --- | --- | --- |
| `POST /research/search` | `{ query (1–1000), mode: "keyword"\|"semantic"\|"hybrid" (default hybrid), scope: { kind: "library" } \| { kind: "collections", collectionIds } \| { kind: "papers", libraryItemIds }, filters: { author?, yearFrom?, yearTo?, venue?, sectionTypes?, publicationTypes?, includeReferences? }, limit (≤ 50), offset (≤ 450) }` | `{ query, understood, mode, results, total, offset, limit, relaxed, semantic: { used, reason, model }, warnings, papersSearched }`; each result has `passageId`, `position`, `score`, `keywordRank`, `semanticRank`, `keywordScore`, `semanticScore`, `matchedBy`, `documentId`, `attachmentId`, `kind`, `sectionPath`, `sectionType`, `pageStart`, `pageEnd`, `hasCoordinates`, the exact `text`, `paper` and `provenance` |
| `POST /research/search/passage` | `{ passageId, scope, limit }` | same shape: passages near the given one in the active embedding space (409 `NOT_CONFIGURED` without one) |
| `GET /research/passages/:passageId` | | `{ passage, paper, provenance, before, after, sentences }` |
| `GET /research/passages/:passageId/location` | | `{ passageId, attachmentId, pageNumber, pageEnd, coordinates, pages }`; `coordinates` empty when the extractor reported none |

The `score` orders results. It is a rank-fusion or BM25/cosine value, not a
probability of relevance or correctness.

### Retrieval settings and index

| Route | Body | Response |
| --- | --- | --- |
| `GET /retrieval/providers` | `probe=1` to check again | `{ grobid: { status, version, message, host, remote, consolidation }, pymupdf: { status, version, message, python }, embeddings: { status, version, message, enabled, provider, model, host, remote, dimensions }, settings }` |
| `PATCH /retrieval/settings` | `{ autoProcess?, embeddingsEnabled?, embeddingModel?, embeddingBaseUrl? }` | the providers response; a base URL on another computer is 400 unless `RS_EMBEDDINGS_ALLOW_REMOTE=1` |
| `GET /retrieval/index/status` | | `{ documents: { pdfAttachments, processed, partial, needsOcr, failed, waiting, queued, running, stale }, keyword: { passages }, embeddings: { activeSpace, indexedPassages, embeddablePassages, reindex }, lastIndexedAt }` |
| `POST /retrieval/reindex` | `{ rebuild? }` | 202 with the index status; 409 `NOT_CONFIGURED` when embeddings are off |
| `POST /retrieval/reindex/cancel` | | the index status |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_GROBID` | `on` | GROBID on or off |
| `RS_GROBID_URL` | `http://127.0.0.1:8070` | GROBID service |
| `RS_GROBID_ALLOW_REMOTE` | `0` | allow a GROBID host other than this computer |
| `RS_GROBID_TIMEOUT_MS` | `180000` | per request |
| `RS_GROBID_CONSOLIDATION` | `0` | let GROBID consolidate metadata with external services |
| `RS_PYMUPDF` | `auto` | PyMuPDF on (`auto`) or `off` |
| `RS_PYTHON` | `python3` / `python` | Python with PyMuPDF |
| `RS_INGESTION_CONCURRENCY` | `2` | documents processed at once (1–8) |
| `RS_INGESTION_MAX_PAGES` | `500` | page limit |
| `RS_OLLAMA_URL` | `http://127.0.0.1:11434` | default embedding endpoint |
| `RS_EMBEDDINGS_ALLOW_REMOTE` | `0` | allow an embedding base URL on another computer |

## Visual routes (M4)

Same rules as above. Schemas: `packages/api-contracts/src/visual.ts`;
client: `client.visual.*`. Images, tasks, artifacts and insertions are
addressed by ID; no response contains a file-system path. Task changes are
pushed as `visual.task` (`{ task }`), new versions and compile results as
`visual.artifact` (`{ artifactId, version }`). Behaviour:
[`VISUAL_STUDIO.md`](VISUAL_STUDIO.md),
[`VISUAL_VALIDATION.md`](VISUAL_VALIDATION.md),
[`AI_PROVIDERS.md`](AI_PROVIDERS.md).

### Images

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /visual/assets` | multipart: `file` (PNG, JPEG, WebP, SVG), `source` (`upload`, `clipboard`), `projectId?` | 201 `{ asset, working, removed }`: `working` is the image to use (the PNG rendering for SVG), `removed` lists what SVG sanitising removed; 415 wrong type, 413 too large or too many pixels |
| `POST /visual/assets/from-project` | `{ projectId, path }` | 201, same; provenance `project-file` |
| `POST /visual/assets/pdf-region` | multipart: `file` (PNG), `attachmentId`, `pageNumber`, `x`, `y`, `width`, `height`, `pageWidth`, `pageHeight` (PDF points, top-left, unrotated), `renderScale` | 201, same; provenance records the attachment, item, PDF SHA-256, page and region |
| `GET /visual/assets` | `projectId?`, `limit` | `{ assets }` (originals) |
| `GET /visual/assets/:assetId` | | `{ asset, lineage }` |
| `GET /visual/assets/:assetId/content` | | the bytes, sandboxed CSP, `nosniff` (SVG: its PNG rendering) |
| `POST /visual/assets/:assetId/variants` | `{ operations: [{ op: auto-orient \| rotate \| crop \| resize \| grayscale \| contrast \| normalize \| sharpen \| upscale, … }], label? }` | 201 `{ asset }` |
| `GET /visual/assets/:assetId/artifacts` | | `{ artifacts }` made from that image |

### Providers

| Route | Query | Response |
| --- | --- | --- |
| `GET /visual/providers` | | `{ providers: [{ id, kind, displayName, defaultModel, vision, structuredOutput, privacyMode, host, usable, problem }], compileAvailable }` |
| `GET /visual/providers/:providerId/check` | `model`, `taskType?` | `{ ok, privacyMode, needsConsent, modelVision, problem, estimatedImageTokens }` |

### Tasks

| Route | Body | Response |
| --- | --- | --- |
| `POST /visual/tasks` | `{ taskType, assetId, text, projectId, layout?, imageDetail?, providerId, model, consent }` | 202 `{ task }`; 409 `details.reason = CONSENT_REQUIRED` (with `provider`, `model`, `imageBytes`, `imageSize`, `estimatedImageTokens`) for a cloud provider without consent; 400 with `details.reason` such as `NO_VISION` or `NO_STRUCTURED_OUTPUT` when the provider or model cannot do it |
| `POST /visual/equations/reconstruct` · `/diagrams/reconstruct` · `/plots/reconstruct` · `/diagrams/generate` · `/captions/generate` | the same without `taskType` | 202 `{ task }` |
| `POST /visual/circuits/reconstruct` | the same plus `circuitType` (`quantum`, `electrical`) | 202 `{ task }` |
| `GET /visual/tasks` | `projectId?`, `limit` | `{ tasks }` |
| `GET /visual/tasks/:taskId` | | `{ task }`: status (`queued`, `running`, `needs_input`, `completed`, `failed`, `cancelled`), progress, error, choices, provider, model, privacy mode, consent time, prompt version, usage, artifact |
| `POST /visual/tasks/:taskId/cancel` | | `{ task }` |
| `POST /visual/tasks/:taskId/retry` | `{ consent }` | 202 `{ task }` (a new task with the same input) |
| `POST /visual/tasks/:taskId/choose` | `{ taskType }` | 202 `{ task }` (continues a `needs_input` task) |

### Artifacts

| Route | Body / query | Response |
| --- | --- | --- |
| `GET /visual/artifacts` | `projectId?` | `{ artifacts }` with the current version's compile status |
| `GET /visual/artifacts/:artifactId` | | `{ artifact, version }` (current) |
| `GET /visual/artifacts/:artifactId/versions` · `/versions/:n` | | `{ versions }` · `{ version }` |
| `POST /visual/artifacts/:artifactId/versions` | `{ sourceCode, dataCsv?, changeDescription }` | 201 `{ version }` (hand edit; compiled in the background) |
| `POST /visual/artifacts/:artifactId/restore` | `{ version }` | 201 `{ version }` (a copy as a new version) |
| `POST /visual/artifacts/:artifactId/validate` | `{ sourceCode? }` | `{ issues, packages, missingPackages }` |
| `POST /visual/artifacts/:artifactId/compile` | `{ version? }` | 202 `{ version }` (status `compiling`); 503 `TOOLCHAIN_MISSING` without latexmk |
| `GET /visual/artifacts/:artifactId/versions/:n/preview` | | the compiled PDF |
| `POST /visual/artifacts/:artifactId/refine` | `{ instruction, providerId, model, consent }` | 201 `{ version, summary, changes, topologyChanges, ambiguities }`; consent as for tasks |
| `POST /visual/artifacts/:artifactId/plot` | `{ style?, xAxis?, yAxis?, exactCsv? }` | 201 `{ version }`; no model call |
| `POST /visual/artifacts/:artifactId/approve` | `{ version }` | `{ artifact }`; 409 unless that version compiled |
| `GET /visual/artifacts/:artifactId/compare` | `from`, `to` | `{ from, to, diff, structuredChanged }` |
| `GET /visual/artifacts/:artifactId/versions/:n/export` | `format` (`tex`, `standalone`, `csv`, `json`) | the file as an attachment |

### Insertion

| Route | Body / query | Response |
| --- | --- | --- |
| `POST /visual/artifacts/:artifactId/insert/preview` | `{ projectId, version, targetFile, afterLine, directory, label, caption, addPreamble }` | `{ plan: { createdFiles, modifiedFiles (before, after), missingPackages, preambleLines, snippet, warnings, planHash } }`; writes nothing; 409 unless the version is approved |
| `POST /visual/artifacts/:artifactId/insert` | the same plus `planHash` | 201 `{ insertion }`; 409 `STALE_PREVIEW` when the plan changed since the preview |
| `GET /visual/insertions` | `projectId` | `{ insertions }` |
| `POST /visual/insertions/:insertionId/rollback` | | `{ insertion, restored, removed }`; 409 when a file changed since the insertion |

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_VISUAL_DIR` | `<data dir>/visual` | image and preview store |
| `RS_VISUAL_COMPILE_TIMEOUT_MS` | `60000` | per preview compile |
| `RS_VISUAL_MAX_IMAGE_BYTES` | `20971520` | per image |
| `RS_VISUAL_MAX_IMAGE_PIXELS` | `40000000` | decoded pixels |
| `RS_VISUAL_CONCURRENCY` | `2` | tasks at once |
