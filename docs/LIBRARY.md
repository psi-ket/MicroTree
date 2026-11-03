# Personal research library (M3.2)

The library keeps the papers a user works with: their metadata, PDFs, notes,
tags, reading status, collections and citation keys, and connects them to
projects through the References panel and the project's `.bib` file. It is
built on the M3.1 literature engine and does not query any scholarly API
itself.

Code: `packages/research-library` (pure library logic, no HTTP server),
`apps/runtime/src/services/library-runtime.ts` and
`apps/runtime/src/routes-library.ts` (wiring and API), `apps/web/src/features/library`
and `apps/web/src/features/references` (UI). Schema: [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Work** | One paper's bibliographic record (`scholarly_works`): an M3.1 `ScholarlyWork` with its source records, or a record built from an imported BibTeX entry, RIS record, Zotero item or PDF. |
| **Item** | The user's copy of a work (`library_items`): reading status, favourite, notes, tags, citation key, collections, files, project links. Exactly one item per work. |
| **Metadata status** | `resolved` (identified through the scholarly sources), `needs-review` (candidates found, waiting for the user), `unresolved` (nothing identified), `manual` (the user's or the import's own record). |
| **Corrections** | Fields the user edited. Stored apart from the source record and applied on top of it, so they survive a refresh and can be undone ("Restore the source details"). |
| **Reading status** | `to-read` (default), `reading`, `read`, `important`. Only the user sets it. Opening a PDF records `last_opened_at` and nothing else. |

## 2. Adding papers

| Source | How | Identification |
| --- | --- | --- |
| Literature search | "Add to library" on a work's details | the work as found (M3.1 merged record) |
| DOI / arXiv ID | Import → "DOIs and arXiv IDs" (one per line) | `LiteratureService.resolveDoi` / `resolveArxiv` |
| PDF | Import → drop zone (up to 50 files per request); "Attach a PDF" on a paper | see §4 |
| BibTeX / BibLaTeX, RIS | Import → paste or choose a file, preview, choose entries | optional lookup of DOIs/arXiv IDs; optional title search (results wait for review) |
| Zotero | Import → Zotero (optional, §7) | Zotero's data; DOIs/arXiv IDs looked up if chosen |

Imports run as **jobs** in the runtime (at most two at a time) and report
progress over the event stream (`library.job`); the page stays usable, jobs
can be cancelled, and each entry's outcome (added, attached, duplicate, needs
review, failed, …) is listed. A job still running when the runtime stops is
marked `interrupted` at the next start.

**Duplicates.** A paper with the same canonical ID, DOI or arXiv ID as an
existing work is never added twice; the import reports it. Records with the
same title and the same first author or year are reported as *possibly* the
same paper (import preview, and "Possibly the same paper" on the Overview,
where the user picks the record to keep and confirms a merge).

**No fabrication.** Missing authors, dates, abstracts or DOIs stay empty. A PDF
without identifiers keeps its own Title metadata (or first-page title, or file
name) and is marked as such.

## 3. PDF storage

- Location: `<RS_LIBRARY_DIR>` (default `<RS_DATA_DIR>/library`), objects at
  `objects/<ab>/<cd>/<sha256>.pdf`, temporary files in `tmp/`. Paths are
  derived from the content hash by the runtime; the API exposes only
  attachment IDs. A storage key read from the database is checked against a
  strict pattern before use, and the storage folders must not be links.
- Writing: the upload streams into an owner-only temp file while it is hashed
  and counted (limit `RS_LIBRARY_MAX_PDF_BYTES`, default 100 MB, 413 when
  exceeded); after validation it is `fsync`ed and renamed into place, or
  dropped if an object with the same hash already exists (deduplication).
  Operations on one hash are serialised.
- Validation: declared type must be PDF; `%PDF-` header and `%%EOF` trailer;
  then pdf.js parses it in a **worker thread** (256 MB heap, 20 s timeout,
  eval/fonts/scripting off) and must find at least one page. Encrypted or
  malformed files are refused with a reason. Nothing is ever executed or
  opened by the OS.
- Deleting: an attachment row is removed first; the object is removed only
  when no row refers to its hash any more.
- Recovery: at start-up and hourly, `tmp/` is emptied and objects no row
  refers to are removed; rows whose object is missing show "File missing".
- Serving: `GET /library/attachments/:id/content` with `Content-Type` from the
  row, `X-Content-Type-Options: nosniff`, a sandboxing CSP,
  `Cache-Control: private, no-store`, `inline` or `attachment` disposition.
  The app renders PDFs with pdf.js inside a dialog.
- Open-access download: only `https` URLs the work itself lists
  (`openAccess.pdfUrl`, `urls.pdf`), never a URL from the browser; every
  connection and redirect (at most 5) is checked against private, loopback
  and link-local addresses at connect time; 30 s timeout; same size limit and
  validation. Off by default (preference `fetchOpenAccessPdf`), or on demand
  ("Get the open-access PDF").

## 4. Metadata resolution

For a PDF: Info/XMP metadata and the text of the first two pages (in the
worker) → DOIs (also `doi.org` links, line-break hyphenation repaired) and
arXiv IDs (`arXiv:` stamps, arxiv.org links, old- and new-style IDs) →
resolved through M3.1 → if none resolved exactly, a title (and first author)
search through M3.1 → candidates scored.

| Confidence | Meaning | Applied automatically? |
| --- | --- | --- |
| `exact-doi` | a DOI in the file's metadata, or in its text when the PDF also contains the work's title (a DOI the paper merely cites is not enough), resolved to this work | yes |
| `exact-arxiv` | an arXiv ID in the file resolved to this work | yes |
| `strong` | title nearly identical and first author matches | no: one click ("Use this record") |
| `possible` | similar title only, or two equally good candidates | no |
| `unresolved` | nothing found | — |

Two different exact or strong candidates make the result `possible`, so an
ambiguous match is never applied silently. The user can also look up the
right paper by DOI or arXiv ID, keep the record as it is ("None of these:
keep my details"), or search again. `refresh` re-reads a resolved work from
the sources; corrections stay on top.

## 5. Citation keys

Formats (preference): `author-year`, `author-year-keyword` (default,
`shor1995scheme`), `author-year-title`, or a custom template with `{author}`,
`{Author}`, `{authors}`, `{year}`, `{yy}`, `{word}`, `{Word}`, `{title}`.
Without an author the key starts from the title (`surface2012`), and a
template that already uses the title does not repeat it. Collisions get `a`,
`b`, … suffixes; uniqueness is case-insensitive and enforced by the database.

A key is assigned once and stored. Changing the key of a paper linked to a
project needs an explicit confirmation that names the projects (409
`KEY_IN_USE` otherwise); "regenerate keys" only fills missing keys unless
asked to replace, and never replaces keys of papers linked to projects.

## 6. BibTeX, RIS and the project `.bib`

**Import** uses the full BibTeX parser in `document-engine` (`@string` with
`#` concatenation, month macros, `@comment`, `@preamble`, brace/quote values,
parenthesised entries, error recovery with line numbers, LaTeX accents to
Unicode). BibLaTeX fields (`date`, `journaltitle`, `eprint`/`eprinttype`, …)
are mapped. Unknown fields are kept (`bibtex_extra`) and written back on
export. RIS: standard tags, repeated `AU`/`A1`, `PY`/`DA`/`Y1`, `DO`, `UR`.

**Export**: BibTeX or RIS for a selection, a collection, a project or the whole
library (`POST /library/export`), with preserved custom fields.

**Project references** (`ProjectLibraryService`):

- Papers are linked to a project in the References panel (or from the library).
- The panel inserts `\cite`, `\citep`, `\citet`, `\parencite`, `\textcite` or
  `\autocite` at the editor cursor (project setting, per key or for several
  keys), and lists the project's citations: in the `.bib` and the library,
  `.bib` only, library only (not written yet), or **not found** (with file and
  line).
- "Update references.bib" previews changes against the project's `.bib`
  file (setting; default `references.bib`):
  - `add-entry`: a linked paper not in the file;
  - `add-fields`: the same work under the same key, missing fields only;
    existing fields and custom fields are never changed;
  - `existing-key-for-doi`: the file has this paper under another key: no
    duplicate is added, the user cites that key;
  - `key-collision`: the key is used for a different work: not applied;
  - `unchanged`.
- The dialog shows a Monaco diff of **exactly the checked changes** (the
  preview is recomputed for the selection), and "Write" applies those changes
  with the hash of the file that was reviewed. If the file changed in the
  meantime the runtime refuses (409 `STALE_PREVIEW`) and the dialog shows a
  fresh preview. The write goes through `ProjectService.writeFile` (path
  checks, atomic compare-and-swap, audit, `files.changed`). The `.bib` file is
  never replaced wholesale and never written without this review.

## 7. Zotero (optional)

The library works fully without Zotero; nothing contacts Zotero until the
user connects it.

- **zotero.org (Web API v3)**: the user pastes an API key once; the runtime
  checks it (`GET /keys/current`), stores it in the secret store as
  `zotero:web`, and never returns it. The browser keeps nothing. Reads page
  through the library (100 per request, `Total-Results`), honour
  `Backoff`/`Retry-After`, and track `Last-Modified-Version`. Writes use
  `Zotero-Write-Token` and `If-Unmodified-Since-Version` (412 = changed
  remotely). PDF attachments are downloaded through `…/file` and checked
  against Zotero's MD5, then validated like any PDF.
- **Zotero on this computer (local API)**: read-only import from
  `http://localhost:23119/api` (Zotero 7, enabled in Zotero's settings).
- **Import**: preview first (new / already imported / changed in Zotero /
  changed on both sides / same paper already in the library), choose items,
  optionally copy PDFs and look up identifiers. Collections are mapped.
- **Export** (zotero.org, key with write access): select papers → "Send to
  Zotero" → preview (add / update / unchanged / conflict) → send.
- **Conflicts**: a linked item changed both here and in Zotero since the last
  sync is marked `conflict` and left alone; the paper's page shows both values
  per field and the user keeps one side. There is no background sync.

## 8. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_LIBRARY_DIR` | `<RS_DATA_DIR>/library` | PDF store |
| `RS_LIBRARY_MAX_PDF_BYTES` | `104857600` (100 MB; 1 MB–2 GB) | size limit per file |
| `RS_ZOTERO_URL` | `https://api.zotero.org` | Web API base (tests point it at a mock) |
| `RS_ZOTERO_LOCAL_URL` | `http://localhost:23119/api` | local API base |

With `RS_LITERATURE=off` the library still works: papers already in it are
found, and new PDFs and references are added unresolved; lookups by identifier
answer `NOT_CONFIGURED`.

## 9. API

All routes are under `/api/v1`, need the session cookie, validate input with
the Zod schemas in `packages/api-contracts/src/library.ts`, and never return
file-system paths. See [`API_SPECIFICATION.md`](API_SPECIFICATION.md#library-routes-m32).

## 10. Tests

| Suite | What it covers |
| --- | --- |
| `packages/database/test/library-schema.test.ts` (10) | constraints, cascades, case-insensitive uniqueness, up/down/up migration |
| `packages/document-engine/test/bibtex-parser.test.ts` (12) | the BibTeX parser |
| `packages/research-library/test/*` (97) | storage (atomicity, dedup, recovery, traversal and links, limits), PDF metadata and validation, identifier extraction, matcher and resolver, BibTeX/RIS import and export, citation keys, library service, `.bib` planning and apply, Zotero client/mapper/import/export against a mock server |
| `apps/runtime/test/library.test.ts` (11) | every route family against the mock literature and Zotero servers: auth, validation, uploads (types, size, traversal), jobs and cancellation, `RS_LITERATURE=off`, project references and stale previews, secrets never in responses or audit, contract conformance, restart persistence; no response contains a storage path |
| `apps/web/test/library.test.tsx` (11) | library screen, match review, key change confirmation, delete impact, duplicates, import center, Zotero key handling, References panel, `.bib` review dialog; axe on each |
| `e2e/library.spec.ts` (1) | search → add → PDF import → resolve → read PDF → collection → BibTeX export → project → cite → `.bib` review → compile → reload |

No test uses a real Zotero account or key, or a real scholarly API.

## 11. Known limitations

- The Zotero local API is import-only; Zotero group libraries are not supported.
- There is no background or two-way automatic sync with Zotero.
- `strong` matches need one click each; there is no bulk "accept all strong matches".
- The paper list has no grid view, and its filter rail has no year/author fields (the API accepts `author`, `yearFrom`, `yearTo`; the search box matches authors).
- Collections are flat (no nesting) and papers are added with selection actions, not drag and drop.
- The E2E "restart" step reloads the app; the runtime-process restart is
  covered by the runtime integration test.
- Scanned PDFs without a text layer are not OCRed; they are added unresolved.
