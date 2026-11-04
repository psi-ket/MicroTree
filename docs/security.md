# Security model

Research Studio runs a privileged local process (the runtime) that can read and
write files and spawn TeX. The browser UI is served from a different origin and
must be treated as untrusted. This document lists the trust boundaries and the
control applied at each.

## Assets

- Files inside authorized workspace roots (research documents, data).
- The rest of the user's filesystem (must be unreachable).
- The ability to execute processes on the machine.
- The pairing secret / session tokens.
- API keys for model services (M2).
- The integrity of manuscripts that AI output is applied to (M2).
- The command-line agents installed on the machine and their logins (M2).

## Threats considered

| # | Threat | Control |
| --- | --- | --- |
| T1 | A random website in the user's browser calls `http://127.0.0.1:4317` (CSRF / drive-by). | Origin allowlist (`RS_ALLOWED_ORIGINS`) on every HTTP request **and** WS upgrade; all API routes require a `Bearer` session token which a foreign origin cannot read; CORS only reflects allowlisted origins. |
| T2 | DNS rebinding (`evil.com` re-resolving to 127.0.0.1). | `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; otherwise `421`. |
| T3 | Other local users / processes hitting the port. | Bind to loopback only; pairing token (256-bit random) stored in the data dir with owner-only permissions (POSIX `0600`); tokens compared in constant time. |
| T4 | Token brute force. | Fixed-window rate limit on `/auth/session` (10/min per remote address); failures written to `audit_events`. |
| T5 | Path traversal (`../../etc/passwd`, absolute paths, `C:\`, UNC, NUL bytes, ADS `file.tex:stream`, symlink escape). | `document-engine/node` **PathGuard**: rejects absolute/UNC/drive paths, NUL/control chars, `:` (ADS), Windows reserved device names, trailing dots/spaces; resolves inside the root and re-checks with `realpath` of the nearest existing ancestor so symlinks cannot escape. Every FS call in the runtime goes through `ProjectFs`, which only accepts guarded paths. |
| T6 | Project roots outside authorized directories. | Projects are created only under `RS_WORKSPACE_ROOT`; on load each project's `root_path` is re-validated against the authorized roots and refused otherwise. |
| T7 | Command injection via compile parameters. | `child_process.spawn` with `shell:false` and an argument array; main-file argument validated (`.tex`, inside project, no leading `-`); engine is an enum mapped to fixed flags. |
| T8 | Arbitrary code execution or file access through a malicious project (`latexmkrc` is Perl; `\write18`; `\input{/home/me/.ssh/id_rsa}`; links out of the project). | `latexmk -norc` (ignores all rc files incl. project-local); no `-shell-escape` option is exposed. kpathsea (TeX Live) settings forced through the environment: `shell_escape=f` (no `\write18` at all, not even the restricted list), `openout_any=p` (writes only below the project: no absolute or `..` paths, no dot files), `openin_any=p` for **pdfLaTeX and XeLaTeX** (`\input`, `\openin`, BibTeX and biber cannot read absolute or `..` paths; files in the TeX distribution stay readable) and `openin_any=a` for **LuaLaTeX** (which cannot start under `p`; see residual risks). The TeX environment is an allowlist (no API keys, no `RS_*`, no `TEXMFCNF`), and `TEXMFOUTPUT` is forced empty so no directory outside the project accepts absolute writes. A compile is refused when the project tree, `.rs-build` included, contains a symbolic link or junction that resolves outside the project. Tested against TeX Live 2024 in `latex-engine/test/compile.integration.test.ts` (reads, writes, links, environment, Lua `os.execute`/`io.popen`). |
| T9 | Runaway compilation (infinite loop, huge logs). | Per-job timeout (`RS_COMPILE_TIMEOUT_MS`), process-tree kill (`taskkill /T /F` on Windows, process-group `SIGKILL` on POSIX; a test checks that the log stops growing after cancel), stdout/stderr capture capped, only the first 8 MB of `.log`/`.blg` are parsed (with a warning), global concurrency cap, one active job per project. |
| T10 | Malicious uploads. | Allowlisted extensions (`png jpg jpeg gif pdf eps svg webp`), magic-byte sniffing must agree with the extension, size cap (`RS_MAX_UPLOAD_BYTES`), filename sanitised, written through PathGuard, never executed. |
| T11 | Oversized request bodies. | Fastify `bodyLimit` and multipart limits. |
| T12 | Token leakage via URLs/logs. | Session tokens are only sent in the `Authorization` header; WebSockets use a single-use 30 s ticket instead of the session token; logger redacts `authorization`. The pairing URL fragment (`#token=`) is never sent to any server and is stripped from the address bar immediately. |
| T13 | XSS in the web app leading to runtime access. | No `dangerouslySetInnerHTML`; log output rendered as text; strict CSP injected into production builds (no `unsafe-eval`, `connect-src` limited to loopback, `object-src 'none'`; pdf.js 6 needs no eval); uploaded images (including SVG) are previewed only through `<img>` with blob URLs, which never runs scripts; the session token lives in `sessionStorage`; the pairing token is only kept in `localStorage` if the user opts into "Remember the token on this device". |

## AI integration (M2)

| # | Threat | Control |
| --- | --- | --- |
| T14 | API keys stolen from the browser (XSS, extensions, storage dumps). | Keys go from the setup form straight to the runtime and are never returned: the API reports only whether a key is set and where it is held (`keyring`, `file`, `memory`, `env`). They are stored in the OS credential store (`@napi-rs/keyring`); if none is usable they stay in memory, or in an owner-only `secrets.json` when `RS_SECRET_STORE=file`. The database holds only provider metadata. The browser never contacts a model service. An e2e test checks that the key is absent from `localStorage` and `sessionStorage`. |
| T15 | An API key sent to an attacker's endpoint. | A key from the runtime's environment (`ANTHROPIC_API_KEY` etc.) is used only when the provider has no custom base URL. Changing a provider's base URL deletes its stored key, so a key can never silently follow the provider to a new host. |
| T16 | Prompt injection through project files, BibTeX entries, logs or agent output. | Context is fenced and labelled as untrusted data; fence-like tags inside it are neutralised. Models cannot act: their output is text plus `<rs-edit>` blocks, and every block becomes a proposal the user reviews as a diff. Proposals are validated (the target must exist inside the project, a selection must still match the file, paths go through PathGuard), and LaTeX warnings flag removed labels and citations and unbalanced structure. Markdown is rendered as text: no HTML, links or images. |
| T17 | AI output overwriting a manuscript silently, or overwriting newer work. | Nothing is written until the user accepts. Accept writes with the proposal's base hash (compare and swap; create-only for new files); if the file changed in between, the proposal becomes stale and cannot be applied. Pending proposals are re-checked whenever their file changes, through the runtime or (while a client has the project open) outside it, and become stale. Revert only restores the original if the file still holds exactly the applied content. |
| T18 | A command-line agent modifying or deleting project files directly, or the staging machinery deleting them. | Agents run in a staging copy (`<RS_DATA_DIR>/agent-workspaces/<conversation>`), never in the project. Changed text files come back as proposals; binary files, links and files the user edited during the run are skipped. The copy excludes `.git`, `.rs-build`, `node_modules` and agent configuration folders. Containment uses one segment-aware utility (`document-engine/node` `containment.ts`: `..staging` or `...data` are *inside*, `../x` is not; Windows drive letters, UNC and mixed separators are handled): the staging root must be disjoint from the project and from `RS_WORKSPACE_ROOT`, checked lexically and again with real paths *before* anything is created; links in the copy are never followed; removal only happens strictly inside the staging root, after a real-path check, and unlinks a link instead of following it. |
| T19 | An agent running where the user did not intend it, or with more power than intended. | Each agent needs an explicit per-project approval for each permission profile (`read`, `write-staged`), recorded in `ai_agent_approvals` and audited. Profiles map to fixed flags: Claude Code `--restricted --strict-mcp-config --permission-mode dontAsk` (read) or `acceptEdits` (write-staged) with `--tools Read,Glob,Grep[,Edit,Write]` (no shell, no web, no MCP servers); Codex `--sandbox read-only|workspace-write`, `--ignore-user-config`, no network, `approval_policy=never`, web search off. Agents can be switched off entirely with `RS_AGENTS=off`. |
| T20 | Command injection through agent parameters. | Executables are discovered by the runtime (`RS_CLAUDE_PATH`, `RS_CODEX_PATH`, PATH) or declared in the runtime's `agents.json`, never by the browser. Arguments are fixed arrays, spawned without a shell; the prompt goes on stdin; the model name is validated (no whitespace, cannot start with `-`) and passed as one argument. |
| T21 | Leaking credentials to agent processes, or from them into the UI. | Each agent gets its own allowlisted environment (`agent-adapters/src/environment.ts`): system paths, home and app-data folders, temp, locale, proxy and certificate settings, plus `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and every name that looks like a credential (`KEY`, `TOKEN`, `SECRET`, `PASSW`, `CREDENTIAL`, `AUTH`, `COOKIE`, `SESSION`, `PRIVATE`) reach an agent only if the operator lists them for that agent in `agents.json` (`environment.<agent>.allow`). `RS_*`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHON*`, `BASH_ENV` and similar loader hooks can never be passed; an `agents.json` that tries is rejected as a whole, and `set` cannot introduce credential names. Values of forwarded credentials (and proxy URLs with user info) are redacted from streamed text (also when split across chunks), activity, errors, runs and the audit log. Keys held by Research Studio's own secret store are never passed. |
| T22 | Runaway or hung model/agent calls. | Timeouts (`RS_AI_TIMEOUT_MS`, `RS_AGENT_TIMEOUT_MS`), a cap on output tokens, one generation per conversation, user cancellation (abort signal for SDK calls, process-tree kill for agents). Turns interrupted by a runtime restart are marked failed on start. |
| T23 | Malformed or unexpected model/agent output. | Agent event streams are parsed line by line and validated; unknown events are ignored, and lines over 4 MiB are truncated. Edit blocks that fail validation (unclosed, nested, duplicated sections, unknown target, missing original) are shown as "not offered for review" with the reason. |
| T24 | Cross-project access through conversations, proposals or attached files. | Every AI route is project-scoped; conversations, proposals and runs are looked up by project and id together; attached file paths go through PathGuard. |
| T25 | A partial answer (cut off at the output limit, a dropped connection, a cancelled or failed request) applied as an edit. | Each answer gets a completion state from the provider's own finish reason: `completed` (OpenAI `stop`, Anthropic `end_turn`/`stop_sequence`, Gemini `STOP`, Ollama `stop`), `truncated` (`length`, `max_tokens`, `MAX_TOKENS`), `incomplete` (no or unknown finish reason, e.g. `pause_turn`), `cancelled`, `failed` (errors, timeouts, refusals). Only `completed` answers produce proposals; the others keep their text for reading, list their edit blocks as not offered, and are not sent back to the model as history. The raw finish reason is stored with the message. |
| T26 | Hostile or oversized image input, or images sent where they are silently dropped. | `MessageContent` image parts are validated before any adapter serialises them: PNG, JPEG or WebP only, magic bytes must match the declared type, at most 5 MB each, 20 per request and 20 MB in total, only in user turns. A provider whose adapter does not send images (`vision: false`) fails with `unsupported-modality` before any request is made. |
| T27 | Work lost to changes made outside the app (another editor, git, a sync client). | While a client has a project open, the runtime watches it and reports added, changed, deleted and renamed files (`source: "external"`). A buffer without unsaved edits follows the disk; a buffer with unsaved edits is never replaced: autosave stops, and the user chooses to compare, reload or keep their version. A save is also always a compare-and-swap on the file's hash. |
| T28 | Agent copies of manuscripts piling up in the data directory, or filling the disk. | Copies are recorded in `ai_staging_workspaces`, removed as soon as their run ends, and swept at startup and every hour (crash leftovers, failed removals, unrecorded directories); a copy in use is never touched; the copies in use together are capped by `RS_AGENT_STAGING_MAX_BYTES` (default 2 GiB). Cleanups are audited. |

## Literature search (M3.1)

| # | Threat | Mitigation |
| --- | --- | --- |
| T29 | Literature API keys exposed to the browser or sent elsewhere. | Keys for OpenAlex and Semantic Scholar are write-only through `PATCH /literature/providers/:id`, stored in the secret store as `literature:<provider>` (or read from `OPENALEX_API_KEY` / `SEMANTIC_SCHOLAR_API_KEY`), and reported only as `stored` / `environment` / none. Each key goes only to its own provider (`api_key` parameter, `x-api-key` header). Key changes are audited without the value. Runtime and e2e tests check that keys never appear in responses, the audit log, the settings table or other providers' requests. |
| T30 | Identifying information leaking to scholarly services. | Only the search terms and filters are sent. No contact address is sent unless the operator sets `RS_LITERATURE_MAILTO`, and then only to OpenAlex and Crossref (tested). `api_key` and `mailto` are removed from every URL that is stored (source records, cache), shown or logged. |
| T31 | Hostile provider data (script in titles, `javascript:` links, oversized or malformed responses). | Responses are validated with Zod schemas of the fields read; unreadable records are left out and counted. Responses over 8 MB are refused. The arXiv Atom reader accepts no DTD or entity definitions. Markup is stripped and all provider text is rendered as React text; only `http(s)` URLs become links, which open with `rel="noopener noreferrer"` (tested with a `javascript:` URL). |
| T32 | Breaking providers' terms or being blocked (too many requests). | Per-provider pacing and concurrency follow each provider's documented limits (arXiv one request per 3 s on one connection; Crossref public pool 1/s), shared by all searches; retries only for 429/5xx/network errors with backoff and `Retry-After`; answers cached (searches 1 h, arXiv 6 h, works 7 days). |
| T33 | Slow or hanging providers tying up the runtime. | Per-request timeouts, a deadline per search (`RS_LITERATURE_TIMEOUT_MS`), and cancellation when the client disconnects, which closes the provider connections (tested end to end). Search bodies are limited to 16 KiB and validated strictly. |

## Research library (M3.2)

| # | Threat | Mitigation |
| --- | --- | --- |
| T34 | Path traversal or link tricks through file names or storage keys. | The browser never sends or receives a path: files are addressed by attachment ID; storage keys are derived from the SHA-256 and checked against a strict pattern before use; the storage folders are created owner-only and refused if they are links; real paths are checked to stay under the library root. Upload names are display names only (tested with `../` names). `.bib` paths for project references must be project-relative and go through the project path guard. |
| T35 | Hostile or malformed PDFs. | Declared type, `%PDF-` signature and `%%EOF` checks, then pdf.js in a worker thread with a heap cap (256 MB) and a 20 s timeout, with eval, fonts and scripting off; encrypted or unreadable files are refused; files are never executed or opened by the OS and are served with `nosniff`, a sandboxing CSP and `private, no-store`. |
| T36 | Disk exhaustion and partial writes. | Per-file limit (`RS_LIBRARY_MAX_PDF_BYTES`, default 100 MB) enforced while streaming (413); at most 50 files per request; temp files are `fsync`ed and renamed atomically; temp files and orphaned objects are removed at start and hourly; temp files of cancelled or failed jobs are removed. |
| T37 | Server-side request forgery through open-access downloads. | Only `https` URLs listed in the work's own record are fetched; each connection and redirect (max 5) is checked at connect time against loopback, private and link-local addresses; time and size limits; the result must pass PDF validation. |
| T38 | Silent damage to a manuscript's bibliography. | `.bib` changes are previewed as a diff, applied only for the chosen changes and only against the reviewed file hash (409 `STALE_PREVIEW` otherwise); existing entries and fields are never removed or rewritten; keys used by a project are never renamed without explicit confirmation (409 `KEY_IN_USE`). |
| T39 | Zotero credentials exposed. | The key is sent once, checked, stored in the secret store as `zotero:web`, sent only in the `Zotero-API-Key` header to the configured Zotero URL, never returned, and audited without its value; tests check responses, audit rows and settings. The web page clears the field after sending and keeps nothing in browser storage. CI uses a mock Zotero server only. |
| T40 | Wrong metadata attached to a paper. | Only exact DOI/arXiv matches are applied automatically; ambiguous results (two equally good candidates) are downgraded to `possible`; everything else waits for the user. Missing values stay empty. |

## Document intelligence and retrieval (M3.3)

| # | Threat | Mitigation |
| --- | --- | --- |
| T41 | XML attacks through GROBID output (external entities, entity expansion, deep nesting). | TEI is read by a dedicated parser that refuses `<!DOCTYPE` and `<!ENTITY`, knows only the five predefined entities and numeric references, and enforces size (64 MB), depth (256) and element (2 000 000) limits (`paper-ingestion/security/xml-security.ts`, tested with XXE and entity-expansion payloads). |
| T42 | Hostile PDFs in the extractors. | PDFs were validated at import (T35) and are checked again. PyMuPDF runs in its own Python process with `-E`, the current folder removed from `sys.path` before any import, an allowlisted environment, the PDF on stdin (no temporary file, no path), a timeout, an output cap and an address-space limit; its output is validated with a schema. GROBID runs in its own process (Docker). Nothing in a PDF is executed. |
| T43 | Resource exhaustion by large or complex documents. | Size and page limits, per-stage timeouts, bounded concurrency (`RS_INGESTION_CONCURRENCY`), caps on structures per document, capped response sizes, at most three attempts for a job that keeps crashing the runtime. |
| T44 | PDFs or passage text leaving the machine. | GROBID's URL comes from the operator's environment only and must be loopback unless `RS_GROBID_ALLOW_REMOTE=1`; then the dashboard warns. GROBID consolidation (external metadata calls from the GROBID server) is off unless `RS_GROBID_CONSOLIDATION=1`. Embedding base URLs set in the app must be loopback unless `RS_EMBEDDINGS_ALLOW_REMOTE=1`. No hosted embedding provider exists in M3.3. |
| T45 | Server-side requests to arbitrary addresses. | No URL from a document or from the browser is fetched by ingestion; service URLs with credentials or other schemes are refused; redirects from GROBID and Ollama are refused. |
| T46 | Script or markup in extracted text. | Extracted text, TEI content and passages are rendered as React text only; query highlighting splits text and wraps matches in `<mark>` without HTML. |
| T47 | Extracted text treated as instructions. | Retrieval returns source data only; nothing in M3.3 sends passages to a chat model or acts on their content. The source panel says the text is data, not an instruction, and is unchecked. |
| T48 | Mistaking extracted references or metadata for verified facts. | References are stored as extracted with `resolution_status`; a library link is shown only for an identical DOI or arXiv ID and is labelled as such. Scores are labelled as ordering, not correctness. |
| T49 | Losing a usable extraction. | New extractions are written inactive and activated only after indexing; a failed or cancelled run deletes only its own rows. |
| T50 | Mixing vectors of different models. | Vectors live in embedding spaces keyed by provider, model, dimensions and version; searches name one space; dimensions are checked on write and on query; a changed model needs an explicit reindex, and the old space stays active until the new one is complete. |

## Visual intelligence (M4)

| # | Threat | Mitigation |
| --- | --- | --- |
| T51 | Hostile images: wrong types, decompression bombs, malformed files. | Content signature must match the declared type; size limit (`RS_VISUAL_MAX_IMAGE_BYTES`); sharp with `limitInputPixels` (`RS_VISUAL_MAX_IMAGE_PIXELS`) and `failOn: 'error'`; dimension limits; tested with a bomb PNG and damaged files. |
| T52 | Script in SVG. | Parsed with the hardened XML reader (no DTD or entities, limits) and rebuilt from an allowlist; scripts, `foreignObject`, handlers, external references and CSS URLs removed; only a PNG rendering is displayed or sent; the SVG source is never served. |
| T53 | Stored images rendered as active content. | Served with `default-src 'none'; …; sandbox` CSP, `nosniff` and inline disposition; IDs only, no paths. |
| T54 | Images or text sent off the computer without the user knowing. | Only Ollama on loopback is local. Every other provider needs consent per task, shown with provider, model, size and approximate tokens, and refused by the runtime without it (`CONSENT_REQUIRED`); consent time, provider, model and privacy mode are stored on the task and in the audit log (never the image or the answer). |
| T55 | Generated LaTeX that reads, writes or runs things. | Static refusal of file and stream primitives, definitions, catcode changes, string-built control sequences, Lua and PDF primitives, `\includegraphics`, `\usepackage` and control characters; packages only from an allowlist via the wrapper; the restricted TeX run (no shell escape, paranoid reads and writes) in a throwaway owner-only folder outside every project, removed afterwards; time limit; packages never installed. |
| T56 | Model output treated as instructions or as fact. | Answers are parsed against JSON Schemas; source is generated from structure; context text is passed as data; uncertainties, digitised values and interpretations are labelled; only compiled versions can be approved. |
| T57 | Unexpected changes to manuscripts. | Insertion only after approval and review of every created and changed file; applying recomputes the plan and refuses if it changed; create-only new files, compare-and-swap writes, undo on partial failure, rollback refused when files changed since; preamble changes only on explicit opt-in. |
| T58 | Path tricks through project images or PDF regions. | Project images are read through `ProjectService` (path guard); PDF regions only from existing library attachments by ID; plot data files must be plain relative CSV names. |

## Residual risks / accepted trade-offs

- **Visual models can be wrong.** Reconstructions are drafts: a wrong symbol
  or connection that still compiles is not detected automatically.
- **Cloud consent covers one task, not the provider's own handling** of the
  image once sent (retention and training are the provider's policies).

- Loopback HTTP is not encrypted; other software running as the same OS user is
  considered trusted (it could read the pairing file anyway).
- "Remember this runtime" stores the pairing token in `localStorage` of the web
  origin. It is opt-in and can be revoked with **Disconnect & forget** or by
  rotating the token (`pnpm --filter @research-studio/runtime token:rotate`).
- **TeX is restricted, not isolated.** There is no OS sandbox around TeX.
  pdfLaTeX and XeLaTeX cannot read outside the project except through the TeX
  distribution's search paths (which include `TEXMFHOME` and any directories
  the operator added to `TEXINPUTS`/`BIBINPUTS`). **LuaLaTeX keeps
  `openin_any=a`**: a malicious document compiled with LuaLaTeX can read any
  file the user can (TeX `\input` and Lua `io.open`) and render it into its own
  PDF; writes stay restricted and commands cannot run. That PDF stays local.
  For untrusted projects use pdfLaTeX/XeLaTeX, or compile inside an OS sandbox
  (a container or VM; on Linux bubblewrap or firejail; on Windows a separate
  low-privilege account or Windows Sandbox). An OS-level sandbox for compiles
  is recommended future work.
- These TeX protections rely on TeX Live's kpathsea reading its settings from
  the environment. **MiKTeX ignores them**: with MiKTeX only `-norc` and the
  absence of `-shell-escape` apply, and MiKTeX's own configuration decides
  what TeX may read and write. This has not been tested.
- Hard links cannot be told apart from ordinary files, so a hard link inside a
  project to a file outside it is read (and with `openout_any=p` possibly
  written) by TeX. The link check before each compile is also a point-in-time
  check. Both require someone who can already write to the project folder.
- Restricted shell escape is disabled entirely, so packages like `minted` will
  not work until an explicit, per-project opt-in is designed (future milestone).
  `epstopdf` reports this on every run; the log parser downgrades that notice
  to `info` so it does not look like a problem with the user's document.
- The Vite dev server cannot use the CSP (React Fast Refresh needs inline
  scripts); only production builds (`pnpm build`, `vite preview`) are covered.
- Context sent to a model service leaves the machine. The context chips show
  what is attached, and the budgets keep it bounded, but anything in the
  selection, the current file window, the outline, diagnostics or cited
  BibTeX entries can be sent. Use Ollama or another local endpoint for
  material that must stay local.
- A credential the operator forwards to an agent (`environment.<agent>.allow`)
  is fully available to that agent and to anything it runs. Redaction removes
  the exact value from what Research Studio shows and stores; an agent that
  prints it encoded (e.g. base64) or in pieces across separate messages is not
  caught.
- External changes are noticed only while a client has the project open, with
  Node's `fs.watch`. Network drives and some sync tools may not deliver events;
  the web app also re-checks open files when its window regains focus. Files
  over 1 MB are compared by size and modification time, not content. A rename
  combined with an edit is reported as a deletion plus an addition.
- `vision: true` means the adapter sends images; a particular model may still
  reject them (reported as a provider error). No part of the UI attaches images
  yet; that is a later milestone.
- An agent's read access is enforced by the agent's own sandbox, not by the
  runtime. Codex's `read-only` sandbox, for example, can read files outside
  its working directory. The staging copy protects the project from writes;
  it does not hide the rest of the user's files from an agent the user chose
  to approve.
- Agents use their own login (Claude Code's or Codex's), and their usage is
  billed to that account.
- In `memory` mode, keys are lost when the runtime stops; in `file` mode they
  are protected by file permissions only (on Windows, by the user profile's
  ACLs).
- The web app connects to `127.0.0.1` / `localhost` only. CSP cannot express
  an IPv6 loopback with a port wildcard, so a runtime bound to `::1` is not
  reachable from the production web build.

- GROBID is a separate service the operator runs (normally a Docker
  container). Its own parsing of hostile PDFs is outside the runtime's
  control; binding it to `127.0.0.1` (as documented) keeps it off the
  network. A GROBID allowed on another computer receives the user's PDFs.
- The PyMuPDF memory cap uses `RLIMIT_AS` and applies on Linux and macOS
  only; on Windows only the timeout and output cap apply. The process runs
  as the user, without an OS sandbox.
- Text extraction is imperfect: columns, equations and tables can be misread
  even with GROBID. Every result links back to the PDF, which remains the
  source.

## Audit trail

`audit_events` records: auth success/failure, project create/delete, file
create/write/rename/delete, uploads, compile start/finish/cancel and every
denied request (path violation, origin rejected, validation failure on a
mutating route).

AI events: `ai.provider.create/update/delete`, `ai.conversation.create/delete`,
`ai.request` (provider kind, model, action, status (including `truncated` and
`incomplete`), the provider's finish reason, the kind and size of each context
item and the output tokens; never the prompt or the answer),
`ai.agent.approve/revoke`, `ai.agent.start` (including denied starts),
`ai.agent.finish` (with whether the staging copy was removed), `ai.cancel`,
`ai.edit.accept/reject/revert` and `ai.staging.cleanup` (sweeps that removed
something, and every failed removal). Accepting a proposal also records the
`file.write`. Credentials forwarded to agents appear as `[redacted]`.

Literature events: `literature.provider.update` (`enabled`, and `apiKey:
"stored" | "removed"`, never the key), `literature.history.clear` and
`literature.cache.clear`. Search queries are not audited; they are kept in the
search history only while it is turned on.

Document events: `documents.process`, `documents.reprocess`,
`documents.cancel` (attachment ID), `retrieval.settings` (the changed
settings) and `retrieval.reindex` (model, rebuild). Search queries are not
audited.

Library events: `library.import` (job kind and counts), `library.items.delete`,
`library.items.merge`, `library.citation-key` (old and new key),
`library.attachment.delete`, `library.storage.sweep`, `library.bib.apply`
(file and changes written), `library.zotero.key` (stored or removed, never the
key) and `library.zotero.export`.
