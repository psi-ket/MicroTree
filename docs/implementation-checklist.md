# Implementation checklist

Legend: [x] implemented **and** covered by an automated test · [~] implemented,
verified by a scripted manual run against the real apps (Playwright driver
scripts, not part of the test suite) · [ ] not started.

Automated suites: unit/integration tests per package (`pnpm test`: 755
passed, 6 skipped (the opt-in OS keyring test and the 5 opt-in live
literature tests), as of the M3.2 run on 2026-11-03; the latex-engine and
runtime suites run the real TeX toolchain) and five Playwright E2E specs with
8 tests (`pnpm test:e2e`).

## M0 — Foundation
- [x] pnpm + Turborepo monorepo, strict shared tsconfig, ESLint flat config (`pnpm typecheck`, `pnpm lint` clean)
- [x] `packages/shared-types` domain types, error codes, AI/evidence interfaces (types only)
- [x] `packages/api-contracts` Zod schemas for all routes + WS messages, typed client
- [x] `packages/database` Drizzle schema (5 tables), SQL migrations, repositories, migrate CLI
- [x] `packages/document-engine` PathGuard (incl. Windows junction escape), tree scan, templates, LaTeX/BibTeX analysis
- [x] `packages/latex-engine` safe process runner, latexmk, log parser, SyncTeX bridge, toolchain detection
- [x] `packages/ui` component library + theme tokens (light/dark)
- [x] Runtime: config, Host check, Origin allowlist, pairing/session auth, WS tickets, rate limit (31 security tests)
- [x] Runtime: audit trail (allowed and denied actions)
- [x] Web: connect via pairing link and token form, session store, runtime client (E2E)
- [~] Web: WebSocket reconnect and in-place re-pairing after a runtime restart, with failed saves retried
- [x] README, architecture docs, ADRs, security model, `.env.example`

## M1 — LaTeX workspace
- [x] Project create from templates / list / open (E2E); delete with or without files (runtime test)
  - [ ] Project delete from the UI has no automated or scripted check
- [x] File tree; create / rename / delete files and folders (runtime tests, create in E2E)
  - [~] Rename and delete from the explorer context menu
- [x] Multi-file editing with tabs (Monaco) (E2E)
  - [~] LaTeX and BibTeX syntax highlighting (visual check only)
- [x] Autocomplete context detection and symbol extraction (document-engine and runtime tests)
  - [~] Monaco completion of commands, environments, `\ref` labels and `\cite` keys
- [x] Save (`Ctrl+S`), autosave, optimistic concurrency `409` (runtime and store tests; E2E saves and reloads)
  - [x] Conflict bar: "Compare" / "Keep mine and save" / "Discard mine and reload" (E2E `external-changes.spec.ts`, store test)
- [x] Async compile via latexmk, queue, coalescing, cancel, status over WebSocket (runtime tests, E2E)
  - [~] Stop button in the UI
- [x] Log parsing → problems panel, click to jump to file and line, raw log (E2E)
- [x] PDF rendering with pdf.js, page count (E2E)
  - [~] Zoom in/out, fit width. Pages are navigated by scrolling with a page indicator; there is no page-jump control.
- [x] SyncTeX forward and inverse endpoints (runtime integration test against real `synctex`)
  - [~] Forward search proof marks (`Ctrl+Alt+J`) and double-click inverse search in the UI
- [x] BibTeX: create/edit, highlighting, cite-key extraction, bibtex run by latexmk, `.blg` diagnostics
- [x] Image upload into project directories, content sniffing, unique names (runtime tests, E2E)
- [x] Settings persisted by the runtime (runtime test)
  - [~] Theme toggle, engine and main-file selectors in the UI
- [x] Persistence across runtime restart (runtime test) and browser reload (E2E)
- [x] Unit tests, integration tests, Playwright E2E (create → edit several files → upload → compile → PDF → errors → reload)

## Known gaps / follow-ups
- Shell-escape packages (`minted`, `svg`) are unsupported by design (ADR 0005);
  SVG figures can be uploaded and previewed but pdfLaTeX cannot include them.
- The production CSP only applies to built assets; the Vite dev server runs without it.
- The web app cannot reach a runtime bound to IPv6 `::1` (see `docs/security.md`).

## M2 — AI integration

Status at the end of M2: `pnpm turbo run typecheck lint test build` passed
(38/38 tasks) and `pnpm test:e2e` passed (2/2). Test counts below are from
that point; see M2.1 for current numbers.

**Packages**
- [x] `ai-core`: provider/agent interfaces, provider catalog, bounded context builder (per-item budgets, 60 000-char total, fenced as untrusted), `<rs-edit>` protocol, proposal validation with LaTeX warnings, writing actions (17 tests)
- [x] `model-adapters`: Anthropic, OpenAI, Gemini, OpenAI-compatible, Ollama with the official SDKs; streaming, cancellation, usage, refusal/truncation, error mapping (37 tests against mock servers, no real keys)
- [x] `agent-adapters`: Claude Code (`stream-json`), Codex (`exec --json`), custom agents from `agents.json`, staging workspace; lifecycle, cancellation, timeout, permissions and resume tested with fake CLIs (19 tests)
- [x] `ai-storage`: AI tables and migration, OS keyring / file / memory secret stores, per-project agent approvals (13 tests; the OS keyring test runs with `RS_TEST_KEYRING=1` and passed on Windows)

**Runtime**
- [x] `/ai` routes, provider/assistant/proposal/agent services, WebSocket events, audit events, stale-proposal sweep, interrupted-turn cleanup on start (23 AI tests)
- [x] Keys never returned by the API; environment keys only for official endpoints; base-URL change clears the stored key
- [x] Model names validated so they cannot read as CLI flags
- [x] Production build bundles the AI migrations (`dist/ai-migrations`) and starts with them (smoke-tested)

**Web**
- [x] Assistant panel: model/agent picker, model name, permission profile, conversation history, streaming with Stop, context chips, writing actions (panel and editor context menu), usage line
- [x] Setup dialog: add/edit/remove providers and keys (never stored in the browser), agent detection, per-project approvals
- [x] Proposal cards and a Monaco diff review: accept, accept an edited version, reject, revert; stale proposals cannot be applied

**End-to-end**
- [x] Playwright with a mock OpenAI-compatible server: configure a model → select it → ask about selected LaTeX → streamed answer → request an edit → review the diff → accept → compile succeeds → revert; checks the key is absent from browser storage
- [x] Real Claude Code run through a test runtime (haiku, `write-staged`): refused before approval, ran after approval, edit returned as a proposal, project unchanged until accept, accepted; a second run cancelled in under 0.3 s; audit trail recorded
- [x] Real Codex run through a test runtime, same scenario and results

**Docs**
- [x] ADR 0007, architecture §5–§6, AI threats T14–T24 and residual risks in `security.md`, README (assistant usage, `agents.json`), `.env.example` (extended in M2.1)

**Not done / known limits**
- [ ] Real-key tests against the hosted Anthropic, OpenAI and Gemini APIs. Only the mock servers are covered: CI must not need keys, and none were used here.
- [ ] An agent's read access outside its working copy depends on the agent's own sandbox (see `security.md`, residual risks)
- [ ] No token/cost budget per project; usage is shown per answer only

## M2.1 — Security, correctness and reliability hardening

Status as of 2026-11-02, all run on Windows 11 with TeX Live 2024 and Node
24.3: `pnpm turbo run typecheck lint test build --force` passes (38/38 tasks;
421 tests passed, 1 skipped) and `pnpm test:e2e` passes (3/3). Per package:
document-engine 100, runtime 94, model-adapters 59, agent-adapters 56,
latex-engine 35, ai-core 29, ai-storage 14 (+1 skipped), web 11,
api-contracts 9, database 9, ui 3, shared-types 2. Findings and the
engineering report: [`docs/reviews/m2.1-hardening.md`](reviews/m2.1-hardening.md).

**A. Agent credential isolation (P0)**
- [x] Per-agent allowlisted environment; provider keys and credential-like names only when allowed per agent in `agents.json` (`agent-adapters/test/environment.test.ts`: OpenAI key not given to Claude Code, Anthropic key not given to Codex, custom agents get no keys, allowed names forwarded, explicit allow works, bypass attempts rejected)
- [x] Forwarded values redacted from streamed text (also split across chunks), activity, errors, runs and audit (`runtime/test/agent-security.test.ts`, `ai-core` redaction tests)
- [x] `RS_*` and loader hooks never forwarded; an `agents.json` that tries is rejected as a whole

**B. Staging containment (P0)**
- [x] Central containment utility `document-engine/node/containment.ts` (`containment.test.ts`: child, parent, sibling, `..staging`, `...data`, absolute outside, links out and in, Windows drives/UNC, mixed separators)
- [x] `StagingWorkspace` checks disjointness before creating anything, never follows links, removes only strictly inside the staging root (`agent-adapters/test/staging.test.ts`)
- [x] Same fix applied to `PathGuard.isInside` and the agent adapters' `relativeTo`

**C. Truncated and unfinished answers (P0)**
- [x] Completion states (completed/truncated/incomplete/cancelled/failed) from raw finish reasons; only completed answers create proposals (`runtime/test/completion.test.ts` through the real OpenAI and Anthropic adapters: normal OpenAI → proposal, `length` → none, normal Anthropic → proposal, `max_tokens` → none, `pause_turn`/no finish reason → none, cancelled → none, provider failure and dropped connection → none, malformed blocks rejected, truncated text kept but not sent back as history)
- [x] Each adapter's finish-reason mapping tested (`model-adapters`: `length`, `nofinish`, `drop`, `pause` scenarios)
- [x] Stricter edit-block parsing (unclosed, nested, duplicated sections, unknown target)
- [x] `finishReason` stored (migration `0001_staging_and_finish_reason`); web shows the new statuses and the unfinished answer on request

**D. Capabilities and multimodal contract (P1)**
- [x] `ModelCapabilities` reports only what adapters implement (`toolUse`/`reasoning` false, `vision` for Anthropic/OpenAI/Gemini, `maxContextTokens`/`maxOutputTokens` null)
- [x] `MessageContent` (text/image), `ChatTurn.content: string | MessageContent[]` (backward compatible), validation (type, magic bytes, size and count limits, user turns only), `unsupported-modality` error (`ai-core` tests)
- [x] Per-adapter serialisation verified on the wire (`model-adapters` "image input" tests)
- [ ] UI for attaching images (M4)

**E. LaTeX security (P0)**
- [x] `openin_any=p` for pdfLaTeX/XeLaTeX, documented `a` for LuaLaTeX; compile refused when links resolve outside the project; `.log`/`.blg` reads capped at 8 MB (`latex-engine/test/compile.integration.test.ts`: shell escape, reads outside, absolute and `..` writes, link refusal, environment isolation, Lua `os.execute`/`io.popen`, timeout, cancellation with process-tree kill, no stray files)
- [x] Docs and config agree (`security.md` T8, ADR 0005 amended by 0008)
- [ ] OS-level sandbox for compiles (recommended; not implemented)

**F. External file changes (P1)**
- [x] Runtime watcher with snapshot reconciliation: add, change, delete, rename; own writes not reported twice; ignored folders (`runtime/test/file-watch.test.ts`, including over a real WebSocket)
- [x] Web: clean buffers follow the disk, renamed files keep their tab, unsaved edits are never replaced, conflict bar with Compare, focus-time re-check (E2E `external-changes.spec.ts`, store test)

**G. Staging lifecycle (P1)**
- [x] `ai_staging_workspaces` records (session, project, agent, created, last active, size); copy removed when its run ends; startup and hourly sweep of crash leftovers, failed removals and unrecorded directories; copies in use never removed; links in the staging root unlinked, project untouched; total size budget `RS_AGENT_STAGING_MAX_BYTES`; cleanups audited; refused when the staging root overlaps the workspace (`runtime/test/staging-lifecycle.test.ts`, `ai-storage` tests)

**Docs**
- [x] `security.md` (T8, T9, T17, T18, T21, T23, new T25–T28, residual risks, audit), `architecture.md` (runtime modules, compile pipeline, external changes, completion states, capabilities, message content, agent environment, staging lifecycle), ADR 0008, README, `.env.example`

**Not done / known limits** (details in `security.md` and the review)
- [ ] LuaLaTeX can read any file the user can; MiKTeX ignores the kpathsea settings (untested)
- [ ] Hard links into the project cannot be detected
- [ ] Redaction covers exact values only
- [ ] External change detection relies on `fs.watch` while a project is open (plus a focus-time re-check)
## M3.1 — Scholarly literature search

Live verification (opt-in `test/live.test.ts`, real APIs, no keys, 2026-11-03):
OpenAlex, arXiv and Crossref passed, as did the merged DOI lookup across
providers. **Semantic Scholar did not pass**: its keyless shared pool answered
HTTP 429 on every attempt (three runs, each with up to 6 retries and backoff). Its
client is tested only against recorded responses, so it counts as implemented
but not live-verified.

**Engine (`packages/literature-engine`, 150 tests + 5 live)**
- [x] Shared HTTP layer: per-provider pacing and concurrency, timeouts, cancellation, retries for 429/5xx/network with `Retry-After` and backoff, 8 MB cap, key/`mailto` redaction, health and rate-limit observations (`http.test.ts`)
- [x] OpenAlex client: search modes, filters, sorts, DOI/ID lookups, references, citations, authors (`providers.test.ts` against recorded responses; live passed)
- [~] Semantic Scholar client: search, filters, DOI/arXiv/ID lookups, references, citations, authors, `x-api-key` header (`providers.test.ts` against recorded lookup, citation and author responses; no keyless search response could be recorded, so search parsing is tested with the documented `/paper/search` envelope around a recorded paper; **live smoke test not passed**: keyless 429)
- [x] arXiv client: query builder, strict Atom reader, versions, old-style IDs, error feeds, 3 s spacing after each response, preprint-only skip (`providers.test.ts`; live passed)
- [x] Crossref client: bibliographic/author/title queries, filters, sorts, public and polite pools, JATS stripping (`providers.test.ts`, including a recorded 400 for an invalid `select`; live passed)
- [x] Normalisers: DOI, arXiv, OpenAlex IDs, dates, authors (particles), markup (`normalization.test.ts`)
- [x] Deduplication by DOI, arXiv ID, provider IDs, then title + authors + year, with DOI/arXiv conflict guards (`dedup-merge.test.ts`)
- [x] Merge with field precedence, conflicts, attributed citation observations, author enrichment, canonical IDs (`dedup-merge.test.ts`)
- [x] Query interpretation, deterministic ranking, sorts, cursors that never repeat a work, partial failures, deadline, cancellation, cache use (`search-service.test.ts`, `ranking-format.test.ts`)
- [x] BibTeX, citation keys, APA-like citation, safe URLs, browser-safe `format` entry (`ranking-format.test.ts`)

**Runtime (18 tests in `apps/runtime/test/literature.test.ts`, against `e2e/mock-literature-server.mjs`)**
- [x] Config: `RS_LITERATURE`, `RS_LITERATURE_MAILTO` (unset by default), `RS_LITERATURE_TIMEOUT_MS`, base-URL overrides, `OPENALEX_API_KEY` / `SEMANTIC_SCHOLAR_API_KEY`
- [x] Routes for providers, search, works, references/citations, DOI/arXiv resolution, authors, history, preferences, cache; error mapping (400/404/409/429/502)
- [x] Keys in the secret store, sent only as header/parameter to their provider, never returned, audited without the value; environment keys; contact address only to OpenAlex and Crossref
- [x] Cancellation on client disconnect reaches the provider; deadline; partial failures; provider health
- [x] Persistence: cache (TTL, purge, cap, clear on key change), history (cap, off clears it), provider state, preferences (`database` tests, migration `0001_literature`)

**Web (16 component tests in `apps/web/test/literature.test.tsx`, 4 Playwright tests in `e2e/literature.spec.ts`)**
- [x] `#/literature` page from the project list and the workspace top bar (saves first, returns to the project)
- [x] Filters (sources, sort, years, open access, types, author, venue, arXiv categories) with validation; recent searches
- [x] Results with provenance notches, attributed citation counts, disagreement marks, provider status line, pagination, empty/error/cancelled states, live-region announcements
- [x] Details: identifiers, attributed counts and abstract, conflicts, source records with retrieval times, related works, author profiles, Copy BibTeX / Copy citation / Download .bib, safe external links
- [x] Sources dialog: per-provider switch, connection test, limits, last reported limits, write-only keys, defaults, history and cache controls
- [x] Cancel button and `Esc`; `/` focuses search; arrow keys move through results
- [x] Accessibility: axe-core with no violations in jsdom (contrast excluded there) and in Chromium (contrast included) for the empty page, results, details, the Sources dialog and the phone-sized dark layout
- [x] Phone width (390 px) without horizontal scrolling; dark theme

**Docs**
- [x] README, `docs/LITERATURE_ENGINE.md`, `docs/API_SPECIFICATION.md`, architecture §7, `.env.example`, `docs/reviews/m3.1-literature.md` (plan and report)

**Not done / known limits**
- [ ] Semantic Scholar live verification (needs a free key or a quieter moment for the shared pool)
- [x] Inserting entries into a project's `.bib` file; a personal library (done in M3.2, below)
- [ ] The shared `ink-faint` colour token is below WCAG AA contrast (2.7–3.8:1) wherever the existing app uses it; the literature page avoids it

## M3.2 — Personal research library and reference manager

Verification: everything below runs against mocks (the recorded scholarly
APIs of `e2e/mock-literature-server.mjs` and the mock Zotero server in
`packages/research-library/test/fixtures/mock-zotero.ts`). **Nothing in M3.2
was verified against real scholarly APIs or a real Zotero account**; the
library reaches the real APIs only through the M3.1 clients, whose live status
is listed above. The production runtime bundle was smoke-tested by a script
(upload → job → PDF metadata → download, identical bytes) [~].

**Database (`0002_library`, 10 tests in `library-schema.test.ts`)**
- [x] Works, items, attachments, collections, tags, project links, Zotero links and collections, import jobs; one item per work; unique DOI, arXiv ID, canonical ID, case-insensitive citation keys, collection and tag names; cascades; deleting a collection keeps its papers
- [x] Down script for `0002`; up → down → up tested

**Package `packages/research-library` (97 tests)**
- [x] Content-addressed PDF store: streaming hash and size limit, atomic rename, deduplication by hash, safe deletion, start-up/hourly recovery (temp files, orphans, missing files), storage-key pattern, link and traversal refusal (`attachments.test.ts`)
- [x] PDF validation: declared type, signature, trailer, pdf.js parse in a worker with heap cap, timeout and cancellation; unreadable, non-PDF, empty and oversized files refused (encrypted files are refused by the parse step but have no dedicated test) (`attachments.test.ts`, `pdf-metadata.test.ts`)
- [x] Open-access download: https only, URLs from the work only, redirects and private/loopback addresses refused at connect time, limits (`attachments.test.ts`)
- [x] Identifier extraction (DOIs incl. hyphenated across lines, `doi.org` links, arXiv old/new IDs and stamps), PDF Info/XMP/first-page metadata (`pdf-metadata.test.ts`)
- [x] Matching: `exact-doi`, `exact-arxiv`, `strong`, `possible`, `unresolved`; only exact applied automatically; a DOI found only in the text counts only when the title is also in the PDF; two equal candidates never picked; no fabricated fields (`imports.test.ts`, `library-service.test.ts`)
- [x] BibTeX/BibLaTeX and RIS import (preview, selection, duplicates, warnings, custom fields kept) and export (BibTeX, RIS) (`bibtex-ris.test.ts`, `imports.test.ts`)
- [x] Citation keys: formats, custom templates, collisions, protection of keys used by projects, regeneration rules (`bibtex-ris.test.ts`, `library-service.test.ts`)
- [x] Library service: add from work/identifier/manual, edits kept apart from source records and revertible, reading status only set by the user, tags, favourites, archive, duplicates and merge, deletion impact (`library-service.test.ts`)
- [x] Project `.bib` planning and apply: add entry, add missing fields, existing key for the same DOI, key collision, selected changes only, stale-preview refusal, `.bib` path checks, preview of a selection equals what is written (`project-references.test.ts`)
- [x] Import jobs: progress, cancellation between records, `interrupted` after a restart (`imports.test.ts`; at most two jobs run at once, which is not tested)
- [x] Zotero: mapping, key info, paging, `since`, collections, PDF with MD5 check, write tokens, `If-Unmodified-Since-Version`/412, 429 with `Retry-After`, read-only keys, local API restrictions, conflict detection and resolution (`zotero.test.ts`)

**Runtime (11 tests in `apps/runtime/test/library.test.ts`)**
- [x] All library, project-reference and Zotero routes; auth; validation; 413/415; jobs, cancellation, temp-file cleanup; `RS_LITERATURE=off`; stale `.bib` preview 409; key rename 409; audit; contract conformance; restart persistence; no response ever contains a storage path
- [x] Zotero key only in the secret store: never in responses, the audit log or settings

**Web (11 component tests in `apps/web/test/library.test.tsx`, `e2e/library.spec.ts`)**
- [x] `#/library` (Overview, Papers with detail panel, Collections, Import) from the project list, the workspace top bar and the command palette
- [x] Papers: search, filters, sorts, paging, multi-select bulk actions (status, collection, tags, favourite, archive, BibTeX, send to Zotero, delete with impact dialog)
- [x] Details: reading status (user only; opening a PDF only records the time), favourite, edit details with corrections and restore, BibTeX, archive, delete; match review (candidates, link by DOI/arXiv, keep, search again); files (view in app, download, rename, remove, attach, open-access download); citation key with confirmation; tags; collections; notes; projects; Zotero conflict
- [x] Import center: PDF drop (background jobs), BibTeX/RIS preview and selection, DOIs/arXiv IDs, Zotero connect/local/preview/import, job list with progress and cancel
- [x] Duplicates on the Overview: choose the record to keep, confirm, merge
- [x] "Add to library" on literature results
- [x] References panel in the workspace: cite insertion at the cursor (6 commands), citation status per key, unresolved citations with locations, add/remove papers, settings; `.bib` review dialog with Monaco diff of exactly the checked changes and stale-preview handling
- [x] Accessibility: axe with no violations in jsdom for every library view and dialog tested, and in Chromium for the library overview, import center and details
- [x] End to end: search → add → PDF import → resolve by arXiv ID → read PDF → collection → BibTeX export → project → cite → `.bib` review → compile → reload

**Docs**
- [x] `docs/LIBRARY.md`, `docs/DATABASE_SCHEMA.md`, `docs/API_SPECIFICATION.md` (library routes), architecture §8, security T34–T40 and audit events, `docs/LITERATURE_ENGINE.md` §13, README, `.env.example`, `docs/reviews/m3.2-library.md` (plan and report)

**Not done / known limits**
- [ ] Live verification with real scholarly APIs through the library, and with a real Zotero account (no credentials used)
- [ ] No bulk "accept all strong matches"; no grid view; no year/author fields in the filter rail (the API supports them); collections are flat and use selection actions, not drag and drop
- [ ] Zotero: local API is import-only; no group libraries; no automatic two-way sync
- [ ] Scanned PDFs are not OCRed
- [ ] The E2E restart step reloads the app; the runtime-process restart is covered by the runtime integration test only

## M3.3 — Scientific PDF intelligence, full-text extraction and hybrid retrieval

Verification (2026-11-03, Linux, Node 22.23, Python 3.13 with PyMuPDF 2.1,
Chromium for the E2E spec): `pnpm typecheck` and `pnpm lint` pass (17/17
packages). `pnpm turbo run test --continue`: 845 passed, 22 skipped, 25
failed. **All 25 failures exist unchanged at the M3.2 commit** in this
container and come from the environment (no TeX toolchain, no Claude Code or
Codex CLI, one Windows-path containment test that fails on Linux) in
`latex-engine` (3), `agent-adapters` (11), `document-engine` (1) and
`runtime` (10); every new or changed package passes. `e2e/documents.spec.ts`
passes in Chromium [x]; `e2e/library.spec.ts` passes up to its compile step,
which needs TeX.

**What was not verified:** no real GROBID service (Docker had no daemon here
and the GROBID documentation site was not reachable; the client follows the
GROBID 0.9 documentation from its repository and is tested against a mock
and a synthetic TEI file), no real embedding model (Ollama was not
available; tested against a mock), no real published paper (all PDFs and
TEI are synthetic).

**Model and storage (`document-intelligence`, 27 tests; `database`, 7 new tests)**
- [x] Extractor-independent model: metadata, sections, blocks (13 types), sentences, equations, figures, tables, references, quality, warnings; missing structures explicit
- [x] Canonical coordinates (CropBox-relative, top-left, unrotated, one-based pages) with conversions from GROBID (same, rotated, scaled frames), PyMuPDF and PDF user space, and to PDF.js viewports; tested against PDF.js on Letter, A4, rotations and CropBoxes
- [x] Sentence segmentation (abbreviations, initials, decimals, identifiers, citations), search-text normalisation (NFKC, hyphenation, Greek and subscripts kept), versions and staleness
- [x] Migration `0003_documents`: extractions (one active per attachment), raw outputs, sections, blocks, passages, sentences, references, elements, jobs (one unfinished per attachment and config), FTS5 with delete trigger, embedding spaces, vectors, passage links; cascades; down script; up → down → up

**Ingestion (`paper-ingestion`, 47 tests)**
- [x] Hardened TEI reader: no DTD or entities (XXE and entity-expansion payloads refused), size, depth and element limits
- [x] GROBID client: health and version, documented options with consolidation off, 204/400/500 permanent, 503 retried with delay and limit, timeout retried once, unreachable, cancellation, bounded concurrency, response cap, remote hosts refused without opt-in
- [x] TEI parser and normaliser: header (title, authors, affiliations, e-mail, date, DOI, arXiv, keywords, venue), abstract, numbered section hierarchy, paragraphs with sentences and boxes, citation and figure markers, inline and display formulas with labels, figures, tables with cells, footnotes, lists, acknowledgements, appendix, references (raw, parsed, identifiers), duplicate removal, structure limits
- [x] PyMuPDF adapter: isolated subprocess, page geometry (sizes, rotation, CropBox), text boxes in the PDF's frame, words, two-column reading order, running heads removed, headings, captions, references, scans vs empty PDFs, malformed PDFs, page limit, timeout, cancellation, missing Python
- [x] Pipeline: validation, GROBID, PyMuPDF geometry and coverage, fallback, needs-OCR, segmentation, keyword index, activation after indexing, embeddings stage; failed reprocess keeps the old extraction; indexing failure leaves nothing behind; dedupe, cancellation, resume after restart, crash limit
- [ ] OCR of scans (needs_ocr is reported; OCR itself is out of scope)
- [ ] A run against a real GROBID service and real papers

**Retrieval (`research-retrieval`, 35 tests + opt-in benchmark)**
- [x] Section-aware segmentation (paragraph and section boundaries, sentence splitting with overlap, formula and caption passages, references separate, stable keys, sentence links)
- [x] Keyword search (FTS5, Porter stemming): phrases, OR, exclusion, section, paper and kind filters, Greek letters, `H_2`, hyphenated terms, identifiers in references, inactive extractions excluded, deterministic order, user FTS syntax neutralised
- [x] Embedding provider interface and Ollama `/api/embed` provider: batches, model check and digest, dimension and value validation, retries, cancellation (against a mock)
- [x] SQLite vector store: exact cosine, per-space isolation, dimension checks, cache reuse, deletion with extractions, sweep; 20 000 × 768 in about 26 ms per query after a 310 ms load
- [x] Reciprocal Rank Fusion with component ranks, weights and reproducible ties; keyword, semantic and hybrid modes; pagination; visible relaxed matching; model mismatch reported
- [x] Evaluation set and metrics (Recall@5/10, MRR, nDCG@10), keyword baseline enforced; stemming compared (`docs/RETRIEVAL_EVALUATION.md`)
- [ ] Evaluation with a real embedding model

**Runtime (5 integration tests in `apps/runtime/test/documents.test.ts`)**
- [x] Routes under `/documents`, `/research`, `/retrieval` with Zod contracts, typed client, `documents.job` and `retrieval.changed` events, audit events
- [x] Processing a library PDF end to end with mock GROBID and real PyMuPDF; structure, sections, passages (paged), references, elements
- [x] Keyword search with scope and filters, exact passages with provenance, passage location with boxes and page geometry, neighbours and sentences
- [x] Embeddings through a mock Ollama: reindex, hybrid and semantic search, similar passages, model change isolated until reindex, old space removed after the switch, remote base URL refused
- [x] GROBID failure falls back to PyMuPDF; attachment deletion removes extraction and index rows; needs-OCR; validation, unknown IDs, auth; persistence across restart; no storage path in any response

**Web (9 component tests in `apps/web/test/documents.test.tsx`, `e2e/documents.spec.ts`)**
- [x] Paper details: Full text panel (extract, reprocess, cancel, progress, failures with reasons, quality, out-of-date marker, semantic index count, search in this paper)
- [x] Full-text view: contents, sections, paragraphs with markers and inline formulas, equations (with the not-a-rendering note), tables, references (library link only for identical identifiers), warnings, page jumps that open the PDF highlighted
- [x] Search text: method, scope (library, collection, paper), section, author and year filters, bibliography toggle, results with title, authors, year, venue, section, page, method and ranks, marked terms, provenance, more results, relaxed and semantic notices, score disclaimer
- [x] Source view: PDF at the page with the passage's boxes (rotation and zoom handled), no highlight without boxes, neighbouring text, provenance, back to results
- [x] Full text dashboard: counts, last indexed, process waiting PDFs, extractor and embedding status with fixes (GROBID Docker command), automatic processing and embedding settings, semantic index progress, reindex and cancel, in progress, recent failures with retry
- [x] Accessibility: axe without violations in jsdom and in Chromium (contrast included); no horizontal scrolling at 390 px

**Docs**
- [x] `docs/PAPER_INGESTION.md`, `docs/DOCUMENT_INTELLIGENCE.md`, `docs/RESEARCH_RETRIEVAL.md`, `docs/EMBEDDING_PROVIDERS.md`, `docs/RETRIEVAL_EVALUATION.md`; README, architecture §9, security T41–T50 and residual risks, `DATABASE_SCHEMA.md`, `LIBRARY.md` §12, `API_SPECIFICATION.md`, `.env.example`, `docs/reviews/m3.3-documents.md` (plan and report)

**Not done / known limits**
- [ ] No real GROBID, embedding model or published paper in the verification (see above)
- [ ] The PyMuPDF fallback has no equation or table structure; reading order handles two columns, not complex layouts
- [ ] Symbols such as `=` and `∝` are not keyword tokens
- [ ] No hosted embedding providers and no learned reranker
- [ ] Exact vector scan; an approximate index would be needed for very large libraries

## M4 Visual intelligence and image-to-LaTeX reconstruction

Verification (2026-11-04, Linux, Node 22, TeX Live with pdfLaTeX, latexmk,
TikZ, PGFPlots, Quantikz and Circuitikz installed, Chromium for E2E):
`pnpm -r typecheck` and `pnpm -r lint` pass in every package.
`pnpm -r --no-bail test`: 953 passed, 25 failed, 7 skipped. **All 25
failures are in code M4 did not change** and come from the environment:
`agent-adapters` (11) and `runtime` (9) need the Claude Code and Codex CLIs;
`latex-engine` (4) needs XeLaTeX (one test) and three log fixtures that the
root `.gitignore` (`*.log`) keeps out of the repository; `document-engine`
(1) is a Windows-path test. Every new or changed package passes. The full
Playwright suite passes (10 of 10, including `e2e/visual.spec.ts`).

**What was not verified:** no real vision model (no Ollama or hosted key in
this container; providers are mocked at the adapter boundary, with the
real Ollama adapter against a mock server in E2E), and no real scanned or
published images (all images are synthetic).

**Image pipeline (`visual-assets` 12 tests; image functions in `visual-engine`)**
- [x] PNG, JPEG, WebP and SVG by content; mismatched, unknown, damaged and empty files refused
- [x] Size and decoded-pixel limits; decompression bomb refused before decoding
- [x] SVG sanitising by allowlist (scripts, handlers, `foreignObject`, external references, CSS URLs, DTD and entities); raster-only display
- [x] Rotate, crop, resize, deskew/normalise, contrast, greyscale, sharpen, upscale as variants; colour kept unless asked; original unchanged
- [x] Provenance: upload, clipboard, project file, PDF region (attachment, item, PDF hash, page, region, render scale), generated
- [x] Images for providers within limits (2048 px, PNG or JPEG under 4.5 MB)

**Providers (`model-adapters` 60 tests, `ai-core`, `visual-engine` orchestrator 11 tests)**
- [x] Ollama image input (`images`) and per-model vision check (`/api/show`); OpenAI `detail`
- [x] Routing: local only for Ollama on loopback; cloud needs consent per task; adapters without images or structured output refused; text-only local models refused
- [x] Structured contracts (strict JSON Schema from Zod at every level); malformed answers, provider failures, rate limits, unsupported images, cancellation
- [x] Automatic detection with a choice when ambiguous; prompts versioned; image text treated as data
- [ ] Live run against a real vision model (opt-in test `packages/visual-engine/test/live.test.ts` exists, not run here)

**Reconstruction and generation (`visual-engine` generators 32 tests, real pdfLaTeX compiles)**
- [x] Equations: inline, display, align, gather, cases, matrix, derivatives, integrals, sums, bra-ket, commutators, Unicode mapping, ambiguous symbols, missing parts, invalid LaTeX
- [x] TikZ from a structured model: nodes, edges with directions, labels, styles, four layout modes, validation
- [x] Quantikz: qubits, gates, controlled gates, swaps, measurements with classical wires, barriers, column scheduling, invalid indices
- [x] Circuitikz: resistors, capacitors, inductors, voltage and current sources, diodes, wires, ground, junctions, unknown connections
- [x] Plots: linear, log and reversed axes, least-squares calibration with residual check, pixel uncertainty, error bars, several series, legends, model estimates labelled, CSV for PGFPlots and CSV export with origin, style changes without touching data
- [x] Text to diagram (no image sent); refinement through structural operations or exact source edits
- [x] Static LaTeX safety, package detection and allowlist, isolated compile, timeout, cleanup, missing packages reported and never installed

**Artifacts and insertion (`visual-artifacts` 8 tests, `database` 3 new tests)**
- [x] Migration `0004_visual` (assets, artifacts, versions, tasks, insertions) with down script, up → down → up
- [x] Versions never overwritten; restore as a copy; line diff; approval names a compiled version
- [x] Insertion plan (unique names, figure snippet, plot CSV path, preamble opt-in), compare-and-swap apply with undo on failure, rollback refused after later edits

**Runtime (`apps/runtime/test/visual.test.ts`, 16 tests, real compile)**
- [x] Routes under `/api/v1/visual` with Zod contracts, typed client, `visual.task` and `visual.artifact` events, audit events; every response and event checked against its schema
- [x] Intake (upload, SVG, variants, project images, PDF-region refusal for unknown attachments), inert serving
- [x] Consent enforced and recorded; local tasks need none; text-only models refused
- [x] Task queue: equation, automatic detection with choice, cancel and retry, failed answers, text to diagram, refinement, compare, restore, hand edits, refused unsafe source, plots (restyle, recalibrate, exact data, CSV export) with no model call
- [x] Reviewed insertion: refused before approval, stale preview refused, applied, listed, rolled back; restart marks running tasks failed

**Web (`apps/web/test/visual.test.tsx` 10 tests with axe; `e2e/visual.spec.ts`)**
- [x] `#/visual` from the project list and the workspace top bar; resizable and collapsible panels, tabs below 1100 px
- [x] Upload, paste, drop, project images, PDF region picker; preprocessing; task, provider, model, layout, context, Precise
- [x] Consent dialog (provider, model, size, approximate tokens)
- [x] Preview of input and compiled result; explanation view with observations apart from interpretation
- [x] Source editor with save as version and validate; CSV and exact data; axes and style; structure view
- [x] Warnings, validation, packages, log, versions with compare and restore
- [x] Improve, presets, Reconstruct, Precise, Explain, Compile, Approve, Insert, Copy, Export
- [x] Insertion review with new files and diffs, preamble opt-in, stale preview, apply, undo
- [x] E2E in Chromium: upload, local reconstruction, real compile, approve, review, insert, rollback, plot CSV and restyle without a model call; axe without violations (contrast included) at desktop and phone width; no horizontal scrolling at 390 px

**Docs**
- [x] `docs/VISUAL_STUDIO.md`, `IMAGE_TO_EQUATION.md`, `DIAGRAM_RECONSTRUCTION.md`, `QUANTUM_CIRCUITS.md`, `PLOT_RECONSTRUCTION.md`, `VISUAL_VALIDATION.md`, `AI_PROVIDERS.md`; README, architecture §10, security T51 to T58 and residual risks, `DATABASE_SCHEMA.md`, `API_SPECIFICATION.md`, `.env.example`, `docs/reviews/m4-visual.md` (plan and report)

**Not done / known limits**
- [ ] No real vision model or real images in the verification (see above)
- [ ] Reconstruction quality is not measured (no labelled image benchmark)
- [ ] Assistant conversations cannot attach images
- [ ] No OCR engine or model-free plot digitiser
- [ ] Contour plots are not digitised into data
