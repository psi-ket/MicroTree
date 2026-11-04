# Research Studio — Architecture

Status: M0 (foundation), M1 (LaTeX workspace), M2 (AI integration, §6),
M3.1 (literature, §7), M3.2 (library, §8) and M3.3 (document intelligence
and retrieval, §9) implemented. Later milestones are described only as
extension points.

## 1. System overview

```
┌──────────────────────────── Browser (untrusted UI) ───────────────────────────┐
│ apps/web  React + Vite                                                        │
│  ├─ Workspace shell (explorer · Monaco editor · PDF.js · diagnostics · AI)    │
│  ├─ Zustand: session, editor buffers, layout, theme                           │
│  ├─ TanStack Query: server state (projects, tree, files, jobs)                │
│  └─ RuntimeClient (typed by @research-studio/api-contracts)                   │
└──────────────┬────────────────────────────────────────┬───────────────────────┘
               │ HTTPS-less loopback HTTP (Bearer)      │ WebSocket (single-use ticket)
               ▼                                        ▼
┌──────────────────────────── apps/runtime (trusted) ───────────────────────────┐
│ Fastify on 127.0.0.1                                                          │
│  ├─ security: host check · origin allowlist · bearer sessions · rate limiting │
│  ├─ routes: auth · projects · files · uploads · compile · synctex · settings  │
│  ├─ services: ProjectService · CompileService (queue) · AuditService         │
│  │            AI: Provider · Assistant · Proposal · Agent services (§6)       │
│  ├─ event bus → WebSocket hub                                                 │
│  └─ uses packages:                                                            │
│      database (SQLite/Drizzle) · document-engine (safe FS, tree, templates)   │
│      latex-engine (latexmk runner, log parser, SyncTeX)                       │
└──────────────┬──────────────────────────────────┬─────────────────────────────┘
               ▼                                  ▼
     ~/.research-studio/studio.db       <workspace root>/<project>/…  (+ .rs-build/)
```

The **runtime is the only component that touches the filesystem or spawns
processes**. The browser is treated as an untrusted client: every request is
authenticated, origin-checked and validated with Zod before any side effect.

## 2. Repository layout

```
apps/
  web/                 Vite + React SPA (workspace UI)
  runtime/             Fastify local research runtime (Node)
packages/
  shared-types/        Domain types and constants shared everywhere (no runtime deps
                       except zod); AI provider / CLI agent interfaces (M2+ prep)
  api-contracts/       Zod schemas for every HTTP route + WebSocket message,
                       route table, and a typed fetch client
  ui/                  shadcn/ui-style component library + Tailwind theme tokens
  database/            Drizzle schema, SQL migrations, repositories, migrator CLI
  latex-engine/        latexmk runner (safe spawn), log parser, SyncTeX bridge,
                       toolchain detection
  document-engine/     Path safety, project tree scanning, templates, LaTeX/BibTeX
                       static analysis (labels, cite keys, outline), completion data
  ai-core/             Model/agent interfaces, provider catalog, bounded context
                       builder, <rs-edit> protocol, proposal validation, writing actions
  model-adapters/      Anthropic, OpenAI, Gemini, OpenAI-compatible, Ollama (official SDKs)
  agent-adapters/      Claude Code, Codex and custom CLI agents; staging workspace
  ai-storage/          AI tables (providers, conversations, messages, proposals,
                       agent runs, approvals) and secret stores (OS keyring/file/memory)
  literature-engine/   Scholarly providers (OpenAlex, Semantic Scholar, arXiv, Crossref),
                       normalisation, deduplication, merging, ranking, paging, BibTeX (M3.1)
  research-library/    Personal library: items, PDF store, imports (PDF, BibTeX, RIS),
                       metadata resolution, collections, exports, project .bib sync, Zotero (M3.2)
  document-intelligence/ Extractor-independent document model, coordinates and their
                       transforms, sentences, search-text normalisation, versions (M3.3)
  paper-ingestion/     GROBID and PyMuPDF adapters, secure TEI parsing, normalisers,
                       document store, persistent job pipeline (M3.3)
  research-retrieval/  Passage segmentation, embedding providers (Ollama), FTS5 keyword
                       search, SQLite vector store, RRF hybrid search, metrics (M3.3)
docs/                  architecture, security model, ADRs, checklist, API, reviews
e2e/                   Playwright end-to-end tests (spins up runtime + web) and mock
                       model / scholarly API servers
```

Dependency direction (acyclic, enforced by package.json):

```
shared-types ◄── api-contracts ◄── web
     ▲   ▲            ▲
     │   └── database │
     │                └────────── runtime ──► database, latex-engine, document-engine
     ├── latex-engine
     └── document-engine ◄── web (pure analysis helpers only: no node: imports
                                  in the browser entry point)
ui ◄── web

ai-core ◄── model-adapters, agent-adapters, ai-storage ◄── runtime
ai-core ◄── web (pure helpers: action catalog, message segmentation)

shared-types ◄── literature-engine ◄── runtime
                 literature-engine/format ◄── web (BibTeX, citations, safe URLs only)

database, document-engine, literature-engine ◄── research-library ◄── runtime

document-intelligence ◄── database, paper-ingestion, research-retrieval, api-contracts, web
database ◄── paper-ingestion ◄── runtime;  research-retrieval ◄── runtime
```

`document-engine` has two entry points: `@research-studio/document-engine`
(pure, isomorphic: LaTeX/BibTeX analysis, completion catalog, file
classification) and `@research-studio/document-engine/node` (filesystem: path
guard, tree scanning, templates). The web app only imports the pure entry.

## 3. Runtime internals

| Module | Responsibility |
| --- | --- |
| `config.ts` | Load + validate env (`RS_*`) with Zod; compute data/workspace dirs. |
| `security/` | Host-header check (DNS-rebinding defence), Origin allowlist, pairing-token → session exchange, WS tickets, simple fixed-window rate limiter for auth. |
| `services/project-service.ts` | Create/list/open/delete projects; file CRUD through `ProjectFs` (path guard); keeps `project_files` index in sync; optimistic concurrency via content hashes. |
| `services/compile-service.ts` | Per-project serial queue (coalescing), global concurrency cap, persisted `compilation_jobs`, event emission, cancellation. |
| `services/audit-service.ts` | Append-only security/audit trail (`audit_events`). |
| `services/file-watch-service.ts` | Watches open projects for changes made outside Research Studio and publishes them (see below). |
| `services/ai/staging-lifecycle.ts` | Records, removes and sweeps agent staging copies; enforces the staging size budget. |
| `services/literature-service.ts` | Builds the literature engine from the enabled providers and their keys (secret store, then environment), backs its cache with SQLite, records provider health and search history, maps engine errors to API errors (see §7). |
| `events.ts` | Typed in-process event bus; WebSocket hub fans out to authenticated sockets. |
| `routes/*` | Thin HTTP layer: parse with api-contracts schemas → call service → serialize. |

### Compilation pipeline

1. `POST /projects/:id/compile` → job row (`queued`) → event `compile.queued`.
2. Queue picks job → `latex-engine.compileProject()` refuses projects that
   contain links resolving outside them, then spawns `latexmk -norc …` with
   `shell:false`, an allowlisted environment, `shell_escape=f`,
   `openout_any=p`, `openin_any=p` (pdfLaTeX, XeLaTeX) or `a` (LuaLaTeX),
   timeout, output cap.
3. Output streamed as `compile.log` WS events (throttled).
4. On exit: parse `.log` (+ `.blg`, first 8 MB of each) → structured `Diagnostic[]`, persist job
   (`succeeded` / `failed` / `cancelled` / `error`), emit `compile.finished`.
5. Web fetches `GET /projects/:id/pdf` (authenticated ArrayBuffer) → PDF.js.

### SyncTeX

`latex-engine/synctex.ts` shells out to the `synctex` CLI (`view` for
forward search, `edit` for inverse search) with argument arrays and parses
its stable text output. Paths in results are normalised to project-relative
paths and re-validated by the path guard before they reach the client.

### External file changes

Projects are ordinary folders, so other programs change them too.
`FileWatchService` watches a project (Node `fs.watch`, recursive) while at
least one WebSocket client sent `project.watch` for it (up to 4 projects per
socket; `project.unwatch` or closing the socket ends it). Raw events only
schedule a debounced rescan (150 ms), which compares the tree with a snapshot
of size, modification time and, up to 1 MB, a SHA-256 of each file. The
result is published as `files.changed` with `source: "external"` and
`changes: [{ path, change: added|changed|deleted|renamed, from? }]`; a
deletion and an addition with the same content in one batch is a rename.
The runtime's own writes (`source: "runtime"`) refresh the snapshot first, so
they are not reported twice. `.rs-build`, `.git`, `node_modules`, links and
the runtime's temporary files are ignored, as in the file tree.

In the web app (`lib/live.ts`): a buffer without unsaved edits is replaced
from disk (or closed, if the file was deleted); a renamed file keeps its
buffer and tab under the new name; a buffer with unsaved edits is never
replaced: it is flagged (`conflict`, `diskState: changed|deleted`), autosave
stops, and the conflict bar offers **Compare** (Monaco diff of disk vs.
editor), **Discard mine and reload** and **Keep mine and save** (for a deleted
file: **Close without saving** or **Keep mine and save**, which recreates it).
Open buffers are also re-checked when the window regains focus.

## 4. Web internals

| Area | Implementation |
| --- | --- |
| Routing | Screens chosen in `App.tsx`: connect (no session), project list, the workspace at `#/p/<projectId>`, and literature search at `#/literature` (`?from=<projectId>` returns to that project). |
| Connection | Connect screen: the user opens the printed URL (`#runtime=…&token=…`) or pastes the token. Token exchanged for a session; the live WebSocket (`lib/socket.ts`, `lib/live.ts`) uses a single-use ticket, reconnects with backoff and resynchronises queries and clean buffers after a reconnect. |
| State | Zustand `connection` (status, session epoch, socket state), `editor` (tabs, buffers, dirty flags, base hashes, conflicts), `compile` (latest job and live output per project), `layout` (panels, palette, dialogs). TanStack Query owns everything fetched from the runtime. |
| Editor | Monaco (bundled locally, no CDN). Monarch grammars for LaTeX and BibTeX, completion providers for commands, environments, `\ref` labels and `\cite` keys gathered from the project. |
| Saving | Explicit `Ctrl/Cmd+S`, autosave after 1.2 s idle, save-before-compile. Each write carries the base hash; the runtime returns `409` if the file changed underneath. Changes made outside the app arrive as `files.changed` events (see *External file changes*); unsaved edits are never replaced without the user's choice. |
| PDF | `pdfjs-dist` with a locally bundled worker; pages render lazily when near the viewport (IntersectionObserver), zoom / fit-width, reading position kept across recompiles, forward SyncTeX proof marks and double-click inverse search. |
| Diagnostics | Problems list with severity filters (click to jump to file and line), raw latexmk log streamed live over the WebSocket, Monaco markers in open files. |
| Layout | `react-resizable-panels`; explorer, assistant and diagnostics panels can be hidden, and sizes are persisted per panel combination. |
| Keyboard | `Ctrl+Enter` compile, `Ctrl+S` save, `Ctrl+P` go to file, `Ctrl+Shift+P` commands, `Ctrl+B` explorer, `Ctrl+J` problems, `Ctrl+Alt+J` SyncTeX forward search. |

## 5. Persistence

SQLite (WAL) via `better-sqlite3` + Drizzle. Migrations are SQL files generated
by drizzle-kit and committed in `packages/database/migrations`; the runtime
applies them at boot and `pnpm db:migrate` applies them manually.

The **filesystem is the source of truth for document content**; the
`project_files` table is an index (path, kind, size, hash, mtime) refreshed on
every scan/write. This means projects remain ordinary folders that can be
edited with any other tool, compiled with plain `latexmk`, and versioned with git.

AI data (M2) lives in the same database, in tables created by
`packages/ai-storage/migrations` (`ai_providers`, `ai_conversations`,
`ai_messages`, `ai_proposals`, `ai_agent_runs`, `ai_agent_approvals`, and since
M2.1 `ai_staging_workspaces` plus `ai_messages.finish_reason`, migration
`0001_staging_and_finish_reason`). They never hold API keys. On start the
runtime marks generations and agent runs that were interrupted by a restart as
failed, and sweeps leftover agent staging copies.

Literature data (M3.1) is in three core tables (migration `0001_literature`):
`literature_cache` (provider answers with expiry), `literature_search_history`
and `literature_provider_state` (health and last rate-limit headers). Literature
preferences and per-provider switches are in `settings` (scope `literature`);
literature API keys are only in the secret store (`literature:<provider>`).

## 6. AI integration (M2)

```
web AssistantPanel ──HTTP──► /projects/:id/ai/conversations/:cid/messages
        ▲                          │
        │ WS: ai.message.delta     ▼
        │     ai.message.updated  AssistantService ── buildContext (project on disk,
        │     ai.proposal.updated     │                bounded, fenced as untrusted)
        │     ai.agent.event          ├─ model:  AiProviderService ─► ModelProvider.stream()
        │                             │          (key from SecretStore, never sent to web)
        │                             └─ agent:  AgentService ─► StagingWorkspace copy
        │                                        ─► AgentProvider.run() ─► diff copy
        └──────────── EditProposal ◄── ProposalService (validate, base hash, accept/revert)
```

- **Providers.** `ai_providers` stores kind, name, optional base URL and
  default model. The key lives in the `SecretStore` under `provider:<id>`;
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` in the runtime's
  environment are used only for the official endpoint (no base URL), so an
  environment key is never sent to a custom URL. Changing the base URL deletes
  the stored key.
- **Context.** `ai-core/buildContext` reads from disk and applies per-item
  budgets (selection 16 000 chars, whole file up to 14 000 chars or a 60-line
  window, file tree 250 entries, outline, 20 diagnostics, 20 cited BibTeX
  entries, up to 4 attached files) within 60 000 characters in total. The
  selection the browser describes is checked against the file on disk. History
  sent to a model is capped at 16 messages / 40 000 characters.
- **Turns.** One generation per conversation; each has a timeout
  (`RS_AI_TIMEOUT_MS`, agents `RS_AGENT_TIMEOUT_MS`) and can be cancelled.
  Deltas are streamed over the WebSocket and the final text is stored.
- **Completion states.** Every adapter ends its stream with one `done` event
  carrying a normalised `stopReason` and the provider's raw finish reason.
  `ai-core/completionState()` turns that (plus cancellation and stream errors)
  into `completed | truncated | incomplete | cancelled | failed`:

  | Provider | completed | truncated | incomplete | failed |
  | --- | --- | --- | --- | --- |
  | OpenAI / compatible | `stop` | `length` | none, other | `content_filter`, errors |
  | Anthropic | `end_turn`, `stop_sequence` | `max_tokens`, `model_context_window_exceeded` | `pause_turn`, `tool_use`, other | `refusal`, errors |
  | Gemini | `STOP` | `MAX_TOKENS` | none, other | `SAFETY` etc., errors |
  | Ollama | `stop` | `length` | none, other | errors |

  The message status is `complete`, `truncated`, `incomplete`, `cancelled` or
  `error`, with an explanation, and `finishReason` is stored. **Only completed
  answers produce proposals.** Edit blocks in any other answer are listed as
  not offered, the text stays readable (the web shows the unfinished answer
  on request), and such answers are left out of the history sent back to the
  model.
- **Capabilities.** `ModelCapabilities` describes what the *adapter*
  implements: `streaming`, `structuredOutput`, `toolUse` (false everywhere:
  no adapter sends tools), `vision` (true for Anthropic, OpenAI and Gemini,
  whose adapters serialise images), `reasoning` (false everywhere),
  `maxContextTokens` / `maxOutputTokens` (null: they vary per model, see
  `ModelInfo.contextTokens`), `usageReporting`, `modelListing`,
  `requiresApiKey`.
- **Message content.** `ChatTurn.content` is `string | MessageContent[]`,
  where `MessageContent` is `{ type: 'text', text }` or `{ type: 'image',
  mimeType: 'image/png'|'image/jpeg'|'image/webp', data: Uint8Array }`. A
  string is one text part, so existing callers are unchanged.
  `ai-core/validateRequestContent()` checks parts before serialisation (type
  against magic bytes, 5 MB per image, 20 images / 20 MB per request, images
  only in user turns) and throws `unsupported-modality` for providers without
  vision. Each adapter serialises parts itself (Anthropic `image` blocks with
  base64 source, OpenAI `image_url` data URLs, Gemini `inlineData`); adapters
  share no code beyond the validator. Nothing in the UI attaches images yet.
- **Proposals.** `<rs-edit>` blocks in a model answer, and files changed by an
  agent in its staging copy, become `EditProposal`s holding the original, the
  proposal, the base hash and LaTeX warnings (unbalanced braces, environments
  or math; removed or duplicate labels; dropped or unknown citations; unknown
  references). Accept claims the proposal, then writes with
  the base hash (create-only for new files); a mismatch marks it stale. A
  `files.changed` listener marks pending proposals stale as soon as their file
  changes (through the runtime or, while watched, outside it). Revert restores the original only if the file still has the applied
  content. The user can edit the proposal in the diff view and accept their
  version.
- **Agents.** Claude Code runs as `claude -p --output-format stream-json
  --restricted --strict-mcp-config --permission-mode dontAsk|acceptEdits
  --tools Read,Glob,Grep[,Edit,Write]`; Codex as `codex exec --json
  --ignore-user-config` with `--sandbox read-only|workspace-write`, no network
  and no approvals; custom agents come from `<RS_DATA_DIR>/agents.json`
  (fixed command and arguments). All of them run in
  `<RS_DATA_DIR>/agent-workspaces/<conversation>` and need a per-project
  approval for the profile used. Sessions are resumed with the agent's own
  session id (which only needs the copy's path, not its contents).
- **Agent environment.** `agent-adapters/buildAgentEnvironment()` builds each
  agent's environment from an allowlist (system, home, temp, locale, proxy and
  certificate variables; `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
  Codex) plus the operator's per-agent policy in `agents.json`:

  ```json
  { "environment": { "claude-code": { "allow": ["ANTHROPIC_API_KEY"] } },
    "agents": [{ "id": "my-agent", "...": "...", "environment": { "allow": [], "set": { "MY_FLAG": "1" } } }] }
  ```

  Credential-like names are passed only when allowed for that agent; `RS_*`
  and loader hooks never. Forwarded credential values are returned as
  `secrets` and redacted from everything the run produces.
- **Staging lifecycle.** `StagingLifecycle` records each copy
  (`ai_staging_workspaces`: session, project, agent, state, size, created and
  last active), claims it for the run, removes it when the run ends (the diff
  has been taken; proposals hold the content) and sweeps at startup and hourly
  for copies left by crashes, failed removals or older versions. A claimed
  copy is never removed. New copies get the part of
  `RS_AGENT_STAGING_MAX_BYTES` not used by copies in use. Agents are refused
  if the staging root overlaps `RS_WORKSPACE_ROOT`.
- **Web.** `features/assistant/`: TargetPicker (model or agent, model name,
  permission profile), context chips, writing actions (also in the editor's
  context menu), streamed messages with light markdown, proposal cards, the
  Monaco diff review dialog and the setup dialog (providers, keys, agent
  approvals).

Still only interfaces: `shared-types/src/evidence.ts` (claim/evidence records
for the future verification engine).

## 7. Literature search (M3.1)

```
web #/literature ──POST /api/v1/literature/search──▶ LiteratureService ──▶ LiteratureSearchService
  (format/ only: BibTeX, citations)                   keys, cache, history,     │ parallel, per-provider
                                                      health (SQLite)           ▼ ProviderHttp (pacing, retries)
                                                                  OpenAlex · Semantic Scholar · arXiv · Crossref
```

- **Boundary.** Only the runtime talks to scholarly APIs (the production CSP
  would block the browser anyway). Keys come from the secret store or the
  environment and go only to their own provider; `RS_LITERATURE_MAILTO` is
  unset by default, so nothing identifying the user is sent.
- **Engine.** `packages/literature-engine` has one module per provider
  (client, Zod schemas of the parts read, mapper to a source record) behind a
  shared HTTP layer; search, deduplication, merging and ranking never see
  provider formats. Every merged value keeps its source; conflicts are listed.
- **Cancellation.** The route ties an `AbortController` to the HTTP
  connection; closing it aborts the provider requests. Each search also has a
  deadline (`RS_LITERATURE_TIMEOUT_MS`).
- **Partial failure.** A search returns whatever providers answered, with a
  status per provider; only lookups where no provider answered are errors.
- **Web.** `features/literature/`: `LiteratureScreen` (search form, filters,
  results, details; narrow screens show results and details in turn),
  `use-search.ts` (one search at a time, superseded searches aborted, paging),
  `SourcesDialog` (switches, tests, keys, defaults, history and cache).

Details: [`LITERATURE_ENGINE.md`](LITERATURE_ENGINE.md),
[`API_SPECIFICATION.md`](API_SPECIFICATION.md).

## 8. Research library (M3.2)

```
web #/library, References panel ──/api/v1/library/*──▶ LibraryRuntime (apps/runtime)
                                                          │  ImportJobRunner (≤ 2 jobs, events)
                                                          ▼
                     packages/research-library: LibraryService · AttachmentService/Storage
                       metadata resolver ──▶ ScholarlyLookup ──▶ LiteratureService (M3.1)
                       ProjectLibraryService ──▶ ProjectService.writeFile (CAS, audit)
                       Zotero client/import/export ──▶ api.zotero.org | localhost:23119
```

- **One metadata system.** Works are M3.1 `ScholarlyWork`s stored in
  `scholarly_works`; the library looks papers up only through the runtime's
  `LiteratureService` (an adapter, `ScholarlyLookup`), with search history
  off for its lookups. Imports that are not identified keep their own record
  (`origin`), never invented values.
- **Files outside SQLite.** PDFs live in a content-addressed store
  (`<RS_LIBRARY_DIR>/objects/<ab>/<cd>/<sha256>.pdf`), written through a temp
  folder and an atomic rename, parsed in a worker thread, deduplicated by
  hash, swept for orphans at start and hourly. The database holds rows that
  refer to them by hash.
- **Projects.** A project links library items; its `.bib` file is changed only
  through a reviewed preview applied with the reviewed file's hash
  (`ProjectService.writeFile`, compare-and-swap). Cite insertion happens in the
  editor (`useEditor.insertAtCursor` → Monaco `executeEdits`), so it can be
  undone like typing.
- **Jobs.** Uploads are streamed to temp files during the request; parsing,
  resolution and storage run in jobs (`library_import_jobs`), reported over the
  event stream and cancellable; temp files of cancelled jobs are removed.
- **Zotero** is optional and isolated in `integrations/zotero`; nothing runs
  until a key is stored or the local API is turned on.
- **Web.** `features/library/` (`LibraryScreen`: overview, papers with
  details, collections, import center with Zotero) and
  `features/references/` (`ReferencesPanel`, `BibReviewDialog`).

Details: [`LIBRARY.md`](LIBRARY.md), [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

## 9. Document intelligence and retrieval (M3.3)

```
web Library → Search text / Full text, paper details → Full text
   │  /api/v1/documents/*, /research/*, /retrieval/*        ▲ documents.job, retrieval.changed
   ▼                                                        │
DocumentRuntime (apps/runtime) ── IngestionQueue (≤ RS_INGESTION_CONCURRENCY, persistent jobs, resume)
   │   reads PDFs only through the library's AttachmentService (by attachment ID)
   ├─ paper-ingestion: GrobidClient ──HTTP──▶ local GROBID (TEI + coords)
   │                   PyMuPdfClient ─stdin/stdout─▶ python -E (geometry, fallback text)
   │                   TEI parser/normaliser, layout normaliser ──▶ document-intelligence model
   │                   DocumentStore (inactive write → index → activate → drop the old)
   └─ research-retrieval: segmentDocument → FTS5 (passage_fts) + EmbeddingIndexer → SqliteVectorStore
                          HybridSearchEngine (BM25, cosine, RRF) ◀── OllamaEmbeddingProvider (optional)
```

- **One library.** Extractions belong to library attachments and are
  deleted with them; search results are hydrated with the corrected library
  record. Library filters (collections, author, year, venue, type) become a
  list of extraction IDs before the retrieval engine runs.
- **Local first.** GROBID and Ollama default to loopback; remote hosts need
  operator switches and are flagged in the UI. Nothing needs an AI chat
  model, and results are always exact source passages.
- **Coordinates.** One canonical system (CropBox-relative points, top-left,
  unrotated); explicit conversions from GROBID, PyMuPDF and PDF user space,
  and to PDF.js viewports. Highlights are drawn only from reported boxes.
- **Reprocessing.** Extractions record the PDF hash, extractor and version,
  parser and segmenter versions and configuration; out-of-date ones keep
  working until a reprocess succeeds.
- **Embedding spaces.** Vectors never mix across models; the active space
  changes only when a reindex completes.

Details: [`PAPER_INGESTION.md`](PAPER_INGESTION.md),
[`DOCUMENT_INTELLIGENCE.md`](DOCUMENT_INTELLIGENCE.md),
[`RESEARCH_RETRIEVAL.md`](RESEARCH_RETRIEVAL.md),
[`EMBEDDING_PROVIDERS.md`](EMBEDDING_PROVIDERS.md),
[`RETRIEVAL_EVALUATION.md`](RETRIEVAL_EVALUATION.md).

## 10. Visual intelligence (M4)

```
web #/visual (features/visual)  ── /api/v1/visual/*  ──▶  VisualRuntime (apps/runtime)
   ▲ visual.task, visual.artifact                         ├─ VisualAssetService: validate → store (<data>/visual) → variants
   │                                                      ├─ task queue (≤ RS_VISUAL_CONCURRENCY, consent, cancel, retry)
   │                                                      │    routeTask → runVisualTask ──▶ ModelProvider.generateStructured
   │                                                      │    (local Ollama or a cloud provider, JSON Schema answers)
   │                                                      ├─ builders: structure → generator → validator → payload
   │                                                      ├─ ArtifactService: versions (never overwritten), approval
   │                                                      ├─ IsolatedCompiler: <data>/visual-builds/vb-* → compileProject → removed
   │                                                      └─ ProjectInsertionService ── files port ──▶ ProjectService (CAS writes)
```

- **One provider abstraction.** Visual tasks use `generateStructured` on
  the providers configured for the assistant; images are `MessageContent`
  parts serialised by each adapter. Ollama gained image input and a
  per-model vision check.
- **Structure first.** The model returns structure validated by Zod;
  diagram, circuit and plot source is generated by code from it, so it is
  deterministic and refinements are operations on the structure.
- **Privacy per task.** `routeTask` marks Ollama on loopback as local and
  everything else as cloud; cloud tasks are refused until the request
  carries consent, which is recorded on the task.
- **Compile in isolation.** Generated source is checked statically, wrapped
  in a standalone document with allowlisted packages and compiled with the
  existing hardened `compileProject` in a throwaway folder outside every
  project.
- **Reviewed insertion.** A plan lists every created and modified file;
  applying recomputes it and refuses if it changed (`STALE_PREVIEW`);
  writes are compare-and-swap; rollback restores only files unchanged since.

Details: [`VISUAL_STUDIO.md`](VISUAL_STUDIO.md),
[`VISUAL_VALIDATION.md`](VISUAL_VALIDATION.md),
[`AI_PROVIDERS.md`](AI_PROVIDERS.md).

## 11. Evidence-linked writing (M5)

```
web (features/claim-analysis, evidence-review,   ── /api/v1/claims, /evidence, /citations,
     citation-intelligence, scientific-writing,       /writing, /projects/:id/review … ──▶ EvidenceRuntime
     manuscript-review)                                 ├─ ManuscriptSync: claim-anchors parse → identities → reconcile
   ▲ evidence.job, evidence.claims                      │    (manuscript_revisions, _blocks, _sentences, claim_anchors)
   │                                                    ├─ extraction: rules or model (evidence-engine) → scientific_claims
   │                                                    ├─ LibrarySearchPort ──▶ DocumentRuntime.search (M3.3 hybrid)
   │                                                    │    + stored abstracts, + M3.1 search on request
   │                                                    ├─ evidence_sources (snapshots) ← evidence_records (ranks)
   │                                                    ├─ assessment / conflicts: ModelTarget ──▶ ModelProvider.generateStructured
   │                                                    │    validated → evidence_assessments (history kept)
   │                                                    ├─ EvidencePrivacy: per-task model, privacy mode, consent, audit
   │                                                    ├─ EvidenceJobs: persistent jobs, progress, cancel, recovery
   │                                                    └─ citations and rewrites ──▶ ProposalService (M2 diffs, CAS)
   │                                                         + ProjectLibraryService (.bib preview and apply, M3.2)
```

- **Pure packages, one facade.** `claim-anchors`, `evidence-engine`,
  `citation-intelligence` and `writing-intelligence` hold no state and know
  nothing of the database. `EvidenceRuntime` joins them to persistence, the
  library, the search index, the proposal service, privacy and jobs.
- **Reuse, not new pipelines.** Evidence comes from the M3.3 index through a
  port. PDF highlighting uses the M3.2 viewer. Every manuscript change goes
  through the M2 proposal service. `.bib` changes use the M3.2 preview and
  apply.
- **Anchors on text, not lines.** Claims point at sentences with stable
  identities. Edits are reconciled, and material changes mark the claim for
  revalidation instead of silently keeping or dropping its evidence.
- **Relevance apart from support, AI apart from people.** Ranks live on the
  evidence record, model judgements in `evidence_assessments` (never
  overwritten) and the researcher's decisions in `evidence_reviews`.
- **Privacy per project and task.** `privacyModeOf` (moved into `ai-core` and
  shared with the visual engine) marks Ollama on loopback as local. Cloud
  use depends on the project's mode and needs consent for each operation.

Details: [`EVIDENCE_ENGINE.md`](EVIDENCE_ENGINE.md) and the documents linked
from it.

See `docs/decisions/` for the reasoning behind each choice and
`docs/security.md` for the threat model.
