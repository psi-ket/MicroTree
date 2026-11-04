# Research Studio

A local-first scientific writing environment for LaTeX. The browser hosts the
interface; a small **runtime** on your machine owns the files, the database and
the TeX toolchain. Your projects are ordinary folders on disk.

This repository implements milestones **M0** (foundation), **M1** (LaTeX
workspace), **M2** (AI assistant), **M3.1** (scholarly literature search),
**M3.2** (personal research library and reference manager), **M3.3**
(scientific PDF intelligence, full-text extraction and hybrid retrieval),
**M4** (visual intelligence and image-to-LaTeX reconstruction) and **M5**
(evidence-linked scientific writing and citation intelligence).
See [`docs/implementation-checklist.md`](docs/implementation-checklist.md)
for exactly what is done and how it is verified.

```
 Browser (React app)  ──HTTP + WebSocket, loopback only, session auth──▶  Runtime (Node)
   editor, PDF viewer,                                                    files, SQLite,
   diagnostics, UI                                                        latexmk, SyncTeX
```

The browser never runs commands or touches the filesystem; the runtime does
both, and only inside the configured workspace folder.

## Requirements

| | |
| --- | --- |
| Node.js | 22.12 or newer (developed on 24) |
| pnpm | 9 (`npm i -g pnpm@9`, or Corepack) |
| TeX distribution | TeX Live or MiKTeX with `latexmk`, `pdflatex` and `synctex` on `PATH` (or set `RS_LATEXMK_PATH` / `RS_SYNCTEX_PATH`). `xelatex` / `lualatex` are needed only if you pick those engines. |
| Build tools | Only if `better-sqlite3` has no prebuilt binary for your platform (Python + a C++ compiler). |
| Full text (optional) | [GROBID](https://github.com/kermitt2/grobid) running locally (for example `docker run --rm --init --ulimit core=0 -p 127.0.0.1:8070:8070 grobid/grobid:0.9.1-crf`) for structure, and Python 3 with PyMuPDF (`pip install pymupdf`) for page geometry and the fallback. Either one is enough to search full text; both give the best result. |
| Semantic search (optional) | A local [Ollama](https://ollama.com) with an embedding model (`ollama pull nomic-embed-text`). Keyword search needs nothing. |
| AI (optional) | An API key for Anthropic, OpenAI or Gemini, any OpenAI-compatible endpoint, a local [Ollama](https://ollama.com), or an installed and logged-in [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex). |
| Literature search (optional) | Internet access from the runtime. No accounts are needed; free OpenAlex and Semantic Scholar keys raise their limits. |

## Getting started

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts both apps:

- the runtime on `http://127.0.0.1:4317`
- the web app on `http://127.0.0.1:5173`

The runtime prints a **connect link** containing a pairing token:

```
  Open this URL to connect the web app (keep it private):
  http://127.0.0.1:5173/#runtime=http%3A%2F%2F127.0.0.1%3A4317&token=…
```

Open it, or paste the token into the connect screen. Then create a project,
edit, and press **Compile** (`Ctrl+Enter`).

You can also run the apps separately with `pnpm dev:runtime` and `pnpm dev:web`.

### Where things live

| What | Default | Setting |
| --- | --- | --- |
| Projects (plain folders) | `~/ResearchStudio/Projects` | `RS_WORKSPACE_ROOT` |
| Database and pairing secret | `~/.research-studio` | `RS_DATA_DIR` |
| API keys | OS credential store (Windows Credential Manager, macOS Keychain, Secret Service) | `RS_SECRET_STORE` |
| Custom agents | `<RS_DATA_DIR>/agents.json` | `RS_AGENTS_FILE` |
| Agents' working copies | `<RS_DATA_DIR>/agent-workspaces/` | — |
| Build output of a project | `<project>/.rs-build/` | — |
| Literature cache, recent searches | In the database (`RS_DATA_DIR`) | **Sources** dialog on the Literature page |

Copy [`.env.example`](.env.example) to `.env` to change any setting; it lists
every option with its default.

### Production build

```sh
pnpm build                                  # web app → apps/web/dist, runtime → apps/runtime/dist
pnpm start                                  # node apps/runtime/dist/main.js
pnpm --filter @research-studio/web preview  # serves apps/web/dist on 127.0.0.1:5173
```

The production web build carries a strict Content Security Policy (the dev
server cannot, because React Fast Refresh needs inline scripts).

## Using the workspace

| Action | How |
| --- | --- |
| Compile (saves all files first) | `Ctrl+Enter`, or **Compile** in the top bar |
| Save / autosave | `Ctrl+S`; autosave after 1.2 s idle (configurable in Settings) |
| Go to file / all commands | `Ctrl+P` / `Ctrl+Shift+P` |
| Toggle explorer / problems | `Ctrl+B` / `Ctrl+J` |
| Source → PDF (SyncTeX) | `Ctrl+Alt+J`, or the crosshair in the PDF toolbar |
| PDF → source (SyncTeX) | Double-click in the PDF |
| Jump to an error | Click it in **Problems**; errors are also underlined in the editor |
| Add files and folders | Explorer toolbar or right-click; right-click a `.tex` file to make it the main file |
| Upload images | Image button in the explorer (goes to `figures/`), or drop files onto a folder |

If a file changes on disk while you have unsaved edits, saving is refused
and a bar offers **Keep mine and save** or **Discard mine and reload**.
Nothing is overwritten silently.

## Using the assistant

Open the assistant panel (robot icon in the top bar) and choose **Set up the
assistant**.

- **Model services.** Pick a service and enter the API key and a default
  model. The key goes to the runtime and is stored in your OS credential
  store. It is never kept in the browser and never shown again. If
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` is set in the
  runtime's environment, that service works without entering a key. For
  OpenAI-compatible services (vLLM, LM Studio, OpenRouter…) also enter the
  base URL. Ollama needs no key.
- **Command-line agents.** Claude Code and Codex are detected automatically
  and use their own login. Each agent must be allowed per project, separately
  for **Read only** and **Edit a copy**. Agents always work on a copy of the
  project; their edits come back as proposals, and the copy is deleted when
  the run ends. Agents do **not** receive `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` or any other credential from the runtime's environment
  unless you allow it (see below).

Then select text in the editor and use a writing action (in the panel or the
editor's right-click menu): explain, improve academic wording, make more
concise, expand, check notation consistency, explain an equation, diagnose
LaTeX errors, suggest corrections, alternative formulations. You can also type
a question. The chips above the input show what will be sent: the file, the
selection, compile problems. Answers stream in, and **Stop** cancels.

Suggested edits appear as cards, but only for answers that finished
normally. If an answer was cut off at the output limit
(`RS_AI_MAX_OUTPUT_TOKENS`), ended without a normal finish, failed or was
stopped, its text stays readable but its edits are not offered; ask again with
a shorter selection. **Review diff** opens a side-by-side diff
whose right side you can edit before accepting. **Accept** writes the change
(then compile with `Ctrl+Enter`); **Reject** discards it; **Revert** undoes an
accepted edit as long as the file has not changed since. If the file changes
before you accept, the proposal is marked out of date and cannot be applied.

Custom agents are declared by you in `agents.json`, never from the browser:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "displayName": "My agent",
      "command": "C:/tools/my-agent.exe",
      "args": ["--model", "{model}", "--stdin"],
      "permissionProfiles": ["read"]
    }
  ]
}
```

The prompt arrives on stdin and standard output is the answer. `{model}` is
replaced by the selected model as one argument. Restart the runtime, or press
**Rescan** in the setup dialog, after editing the file.

The same file controls which environment variables an agent gets. By default
an agent receives only system, home, temp, locale, proxy and certificate
variables (plus `CLAUDE_CONFIG_DIR` / `CODEX_HOME` for Claude Code / Codex).
To let an agent use a key from the runtime's environment instead of its own
login, allow it for that agent:

```json
{
  "environment": { "claude-code": { "allow": ["ANTHROPIC_API_KEY"] } },
  "agents": [
    { "id": "my-agent", "...": "...", "environment": { "allow": ["MY_SERVICE_TOKEN"], "set": { "MY_AGENT_MODE": "fast" } } }
  ]
}
```

`RS_*` variables and loader hooks (`NODE_OPTIONS`, `LD_PRELOAD`, …) can never
be passed; a file that tries is ignored as a whole. Allowed credentials are
replaced by `[redacted]` in everything the app shows or stores.

## Searching the literature

Open **Literature** from the project list, or the books icon in a project's
top bar (open files are saved first; **Back to project** returns). One search
asks OpenAlex, Semantic Scholar, arXiv and Crossref at the same time:

- Type words, a DOI (`10.1103/PhysRevA.52.R2493`, or a `doi.org` link), or an
  arXiv ID (`2106.15928`, `quant-ph/9605011`, with or without a version).
  Identifiers are looked up exactly; words are searched in all fields, the
  title, the author, or title and abstract.
- Filters on the left: sources, sort (relevance, newest, oldest, most cited),
  years, open access, publication type, author, venue and arXiv categories.
  Ticking a box re-runs the search; typed filters apply on Enter. A source that
  cannot apply a filter exactly says so above the results.
- The same work found by several sources is shown once. The marks on the left
  edge of each result show which sources returned it (OpenAlex, Semantic
  Scholar, arXiv, Crossref, top to bottom).
- The details panel shows every value with its origin: the citation count
  names its source (other sources' counts are listed), the abstract names its
  source, fields where sources disagree are listed with each source's value,
  and each source record links to the original page with its retrieval time.
  Underlined author names open the author's OpenAlex or Semantic Scholar
  profile; **References** and **Cited by** list related works.
- **Copy BibTeX**, **Copy citation** and **Download .bib** produce the entry
  from the merged metadata.
- If a source is slow, rate limited or down, the others still answer and the
  status line says what happened. **Cancel** (or `Esc`) stops a search,
  including the runtime's requests to the sources. `/` focuses the search box.

**Sources** (top right) turns each source on or off, tests the connection,
shows its limits and what it last reported, and stores optional API keys for
OpenAlex and Semantic Scholar in the runtime's secret store (or set
`OPENALEX_API_KEY` / `SEMANTIC_SCHOLAR_API_KEY`). arXiv and Crossref need no
key. Nothing identifying you is sent unless you set `RS_LITERATURE_MAILTO`,
which gives Crossref (and OpenAlex) a contact address and moves Crossref
requests to its faster "polite" pool. Search answers are cached for an hour
(arXiv: 6 hours) and single works for 7 days; recent
searches are remembered unless you turn that off. Details:
[`docs/LITERATURE_ENGINE.md`](docs/LITERATURE_ENGINE.md).

## Your library

Open **Library** from the project list, or the bookmark icon in a project's
top bar. It keeps the papers you work with, each with its PDF, notes, tags,
reading status (to read, reading, read, important: only you change it),
favourite mark, collections and citation key.

- **Add papers** with **Add to library** on a literature search result, or on
  the **Import** tab: drop PDFs, paste or choose a BibTeX/BibLaTeX or RIS file
  (preview, then choose entries), or list DOIs and arXiv IDs. Imports run in
  the background with progress and a Cancel button.
- **PDFs** are stored once (by content hash) in the runtime's data folder,
  checked before they are kept, and read inside the app. A PDF is identified
  by the DOI or arXiv ID it states; anything less certain is listed as
  "Check the match" and nothing is applied until you choose a record (or keep
  your own). Missing details are left empty, never guessed.
- **Papers** lists, searches and filters the library; select several papers to
  change their status, tags or collection, archive them, export BibTeX or
  delete them (the dialog says which projects and files are affected).
- **Collections** group papers; deleting a collection keeps its papers.

In a project, the **References** panel (quote icon in the top bar) lists the
project's papers and citations. Click `\cite` (or the command chosen in the
panel's settings: `\citep`, `\citet`, `\parencite`, `\textcite`,
`\autocite`) to insert a citation at the cursor. **Update references.bib**
shows a diff of the entries and fields that would be added; you choose the
changes, and only those are written, and only if the file has not changed
since. Existing entries and custom fields are never removed or rewritten.
Citation keys used by a project are never renamed without your confirmation.

**Zotero** (optional, on the Import tab): connect zotero.org with an API key
(kept by the runtime, never in the browser) to preview and import items,
collections and PDFs, and to send selected papers back; or import read-only
from Zotero running on this computer. Changes made on both sides are shown
side by side for you to settle. Details: [`docs/LIBRARY.md`](docs/LIBRARY.md).

## Full text and search across your papers

PDFs in the library can be turned into structured, searchable text on this
computer, without any AI model.

- **Extract**: in a paper's details, **Full text → Extract full text** (or
  **Library → Full text → Process waiting PDFs**, or turn on automatic
  processing there). GROBID gives sections, paragraphs, sentences, equations,
  figures, tables and references with their positions in the PDF; PyMuPDF
  checks page geometry and coverage and reads the page layout when GROBID is
  not available. Scans without a text layer are marked **Needs OCR**.
  Processing runs in the background and can be cancelled; reprocessing keeps
  the current text until the new extraction is ready.
- **Read**: **Full text** opens the extracted structure with a table of
  contents; every section, paragraph, equation and reference opens the PDF
  at its page. Quality indicators and warnings say what was not found.
- **Search**: **Library → Search text** searches every processed paper by
  keyword (phrases, `OR`, `-word`, `section:methods`, DOIs and arXiv IDs),
  semantically (with local embeddings) or both (rank fusion), within the
  library, a collection or one paper, filtered by author, year and section.
  Results are the exact passages with page, section, method and source;
  **Open in PDF** shows the passage highlighted at its place.

Nothing leaves the computer by default: GROBID and Ollama must be local
unless the operator allows otherwise, and the app warns when they are not.
Details: [`docs/PAPER_INGESTION.md`](docs/PAPER_INGESTION.md),
[`docs/RESEARCH_RETRIEVAL.md`](docs/RESEARCH_RETRIEVAL.md),
[`docs/EMBEDDING_PROVIDERS.md`](docs/EMBEDDING_PROVIDERS.md).

## Images to LaTeX (Visual Studio)

**Visual Studio** (from the project list, or the shapes button in a
project's top bar) turns images into editable LaTeX: printed and
handwritten equations and derivations, diagrams (TikZ), quantum circuits
(Quantikz), electrical circuits (Circuitikz) and plots (PGFPlots with a CSV
of the values). It also explains figures (observations kept apart from
interpretation), drafts captions, and draws diagrams from a description.

- **Input**: upload, paste, drop, an image from the project, or a region of
  a library PDF (the page and the box are recorded). Preprocessing makes new
  images linked to the untouched original.
- **Models**: any configured provider with image input. Ollama with a
  vision model on this computer is **local**; anything else is **cloud**
  and needs your confirmation for each task, after seeing the provider, model,
  image size and approximate cost.
- **Results**: source generated from a validated structure, compiled in an
  isolated throwaway folder; only a compiled version counts as a result.
  Uncertain symbols, uncertain components and digitised values are marked.
  Plots can be restyled, recalibrated or given exact data without asking the
  model again.
- **Versions**: every change is a new version (compare, restore). Improve
  a result in words; the change is applied to the existing structure, not
  regenerated.
- **Insert**: approve a compiled version, review every new file and every
  change as a diff (preamble changes only if you tick them), apply, and undo
  later if needed.

Details: [`docs/VISUAL_STUDIO.md`](docs/VISUAL_STUDIO.md),
[`docs/IMAGE_TO_EQUATION.md`](docs/IMAGE_TO_EQUATION.md),
[`docs/DIAGRAM_RECONSTRUCTION.md`](docs/DIAGRAM_RECONSTRUCTION.md),
[`docs/QUANTUM_CIRCUITS.md`](docs/QUANTUM_CIRCUITS.md),
[`docs/PLOT_RECONSTRUCTION.md`](docs/PLOT_RECONSTRUCTION.md),
[`docs/VISUAL_VALIDATION.md`](docs/VISUAL_VALIDATION.md),
[`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md).

## Evidence-linked writing

The **Evidence** button in a project's top bar opens a panel beside the
editor. Select a sentence or a paragraph and choose **Check evidence** (also
in the editor's context menu).

- **Claims**: the selection's scientific claims are found (by rules, or by a
  model if you choose) and compound sentences are split into atomic claims.
  You approve, edit, split, merge or exclude them. The manuscript is not
  changed.
- **Evidence**: passages are searched in the papers of your library through
  the full-text index. Each one is shown with its paper, section and page and
  opens in the PDF viewer with the passage highlighted. Abstract-only
  evidence is labelled as such.
- **Assessment**: a model says how each passage relates to the claim (direct,
  partial or indirect support, context, contradiction, insufficient,
  irrelevant). Support must quote the passage, and quotations are checked.
  Your own decisions are stored separately and never overwritten.
- **Conflicts**: when sources disagree, the disagreement is classified and
  both sides are shown. It is never resolved for you.
- **Citations**: papers are recommended only from supporting evidence. The
  `.tex` change and any `.bib` addition are shown as diffs to review.
- **Writing**: 29 writing operations on the selection. Rewrites are diffs to
  review, citations and references must survive, and meaning changes are
  flagged.
- **Review**: Evidence Review Mode (top bar) goes through the manuscript by
  section with coverage counts and their denominators. There is no single
  score.

Privacy is set per project. The default is local models only. Cloud models
can be allowed, and each use is confirmed and audited, or the project can be
marked confidential so nothing is ever sent.

Details: [`docs/EVIDENCE_ENGINE.md`](docs/EVIDENCE_ENGINE.md),
[`docs/CLAIM_EXTRACTION.md`](docs/CLAIM_EXTRACTION.md),
[`docs/EVIDENCE_ASSESSMENT.md`](docs/EVIDENCE_ASSESSMENT.md),
[`docs/CITATION_INTELLIGENCE.md`](docs/CITATION_INTELLIGENCE.md),
[`docs/SCIENTIFIC_WRITING.md`](docs/SCIENTIFIC_WRITING.md),
[`docs/MANUSCRIPT_REVIEW.md`](docs/MANUSCRIPT_REVIEW.md),
[`docs/EVIDENCE_EVALUATION.md`](docs/EVIDENCE_EVALUATION.md).

## Security in short

- The runtime listens on loopback only, rejects unexpected `Host` headers
  (DNS rebinding) and any `Origin` not on `RS_ALLOWED_ORIGINS`.
- A pairing token (stored with owner-only permissions) is exchanged for an
  in-memory session token; WebSockets use single-use tickets.
- Every file path is normalised and resolved through symlinks/junctions and
  must stay inside the project; build output and `.git` are off limits.
- `latexmk` runs without a shell, with `-norc` (no project `latexmkrc`),
  shell escape fully disabled, writes restricted to the project, reads
  restricted to the project and the TeX distribution (pdfLaTeX and XeLaTeX;
  **not LuaLaTeX**), a filtered environment, a timeout and an output cap.
  Projects containing links that point outside them are not compiled. This is
  a restriction, not a sandbox: compile untrusted projects with pdfLaTeX or
  inside a container/VM. With MiKTeX only `-norc` and the disabled shell
  escape are guaranteed.
- API keys stay in the runtime (OS credential store); the browser never
  receives them or talks to a model service.
- AI output never writes files by itself: every edit is a proposal you review
  as a diff, and it is applied only if the file has not changed since.
- Literature sources are queried only by the runtime. Their API keys stay in
  the secret store and are sent only to their own service (as a header for
  Semantic Scholar); keys and contact addresses are removed from every URL that
  is stored or shown. Provider text is displayed as text, and only `http(s)`
  links become clickable.
- Command-line agents need per-project approval, run on a copy of the project
  (removed afterwards, size-capped by `RS_AGENT_STAGING_MAX_BYTES`) with
  fixed, restricted flags, an allowlisted environment without your API keys,
  and a timeout, and can be cancelled.
- Only AI answers that finished normally can propose edits.
- Files changed by other programs while a project is open are picked up; if
  you have unsaved edits to such a file, nothing is overwritten: you compare
  and choose.
- Images are checked by content (PNG, JPEG, WebP, SVG), size and decoded
  pixel count (decompression bombs refused); SVG is rebuilt from an allowlist
  and only its raster is shown or sent. Generated LaTeX may not read, write
  or define anything and loads only allowlisted packages; it compiles in a
  throwaway folder with the restricted TeX settings above. Packages are never
  installed for you.
- Sensitive actions, including AI requests and agent runs, are recorded in an
  audit log (never the prompts or answers).

Rotate the pairing token with `pnpm --filter @research-studio/runtime token:rotate`.
Details: [`docs/security.md`](docs/security.md).

## Repository layout

```
apps/
  web/                  React + Vite UI (Monaco, pdf.js, Zustand, TanStack Query)
  runtime/              Fastify server: auth, projects, files, compile queue, WebSocket
packages/
  shared-types/         Domain types, error codes, AI and evidence interfaces (types only)
  api-contracts/        Zod schemas for every route and WebSocket message + typed client
  database/             Drizzle schema, SQL migrations, repositories (SQLite)
  document-engine/      Path safety, project filesystem, templates, LaTeX/BibTeX analysis
  latex-engine/         Safe process runner, latexmk, log parsing, SyncTeX, toolchain detection
  ui/                   Design tokens (light/dark) and shared components
  ai-core/              Model/agent interfaces, context builder, edit protocol, proposal checks
  model-adapters/       Anthropic, OpenAI, Gemini, OpenAI-compatible and Ollama adapters
  agent-adapters/       Claude Code, Codex and custom CLI agents, staging workspace
  ai-storage/           AI tables and the API-key stores
  literature-engine/    OpenAlex, Semantic Scholar, arXiv and Crossref clients, normalisation,
                        deduplication, merging, ranking, BibTeX and citations
  research-library/     Personal library: PDF store, imports (PDF, BibTeX, RIS), metadata
                        resolution, collections, exports, project .bib updates, Zotero
  document-intelligence/ Document model, coordinates and transforms, sentences, normalisation
  paper-ingestion/      GROBID and PyMuPDF adapters, TEI parsing, normalisation, job pipeline
  research-retrieval/   Passages, embeddings (Ollama), FTS5 and vector search, hybrid ranking
  visual-engine/        Visual task schemas, routing and consent, prompts, orchestration,
                        TikZ/Quantikz/Circuitikz/PGFPlots/CSV generators, validators,
                        plot digitising, refinement patches, isolated compile
  visual-assets/        Image validation, SVG sanitising, preprocessing variants, image store
  visual-artifacts/     Artifacts and versions, approval, reviewed insertion and rollback
  claim-anchors/        LaTeX blocks and sentences, stable identities, anchor reconciliation,
                        materiality of edits
  evidence-engine/      Claim extraction and splitting, evidence retrieval, assessment and its
                        validation, conflicts, provenance, freshness, the M5 benchmark
  citation-intelligence/ Citation setup and commands, keys, placement, recommendation, grouping
  writing-intelligence/ Style and precision analysis, 29 writing operations, rewrite validation,
                        coverage and manuscript review
docs/                   Architecture, security model, decisions (ADRs), checklist, API, reviews
e2e/                    Playwright end-to-end tests, a mock OpenAI-compatible server, a mock
                        Ollama vision server and mock scholarly APIs that replay recorded responses
```

Internal packages are consumed as TypeScript source (see ADR 0004); the
runtime build bundles them.

## Development

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc` in every package (strict) |
| `pnpm lint` | ESLint (flat config, typescript-eslint strict) |
| `pnpm test` | Vitest unit and integration tests in every package. The latex-engine and runtime suites run the real TeX toolchain; they skip those cases if `latexmk` is missing. |
| `pnpm test:e2e` | Playwright: starts a fresh runtime and web server on ports 4399/5199 with a throwaway data folder (keys in memory, agents off), a mock model service on 4499, a mock Ollama vision server on 4497 and mock scholarly APIs on 4498. The tests create a project, edit, upload, compile and check the PDF; configure a model and review an AI edit; and search the literature (merging, BibTeX, rate limits, cancellation, keys, phone-sized dark layout, accessibility checks with axe). No real API keys or network are needed. Run `pnpm exec playwright install chromium` once. |
| `RS_LITERATURE_LIVE=1 pnpm --filter @research-studio/literature-engine exec vitest run test/live.test.ts` | Opt-in smoke test against the four real scholarly APIs (no keys; set `RS_LITERATURE_MAILTO` to use Crossref's polite pool). Not part of `pnpm test`. |
| `RS_VISUAL_LIVE=1 RS_VISUAL_MODEL=llava pnpm --filter @research-studio/visual-engine exec vitest run test/live.test.ts` | Opt-in smoke test of an equation reconstruction against a real vision model (local Ollama by default; `RS_VISUAL_KIND`, `RS_VISUAL_BASE_URL`, `RS_VISUAL_API_KEY` for another provider). Not part of `pnpm test`. |
| `pnpm --filter @research-studio/evidence-engine bench` | M5 benchmark on the synthetic set (claim detection, segmentation, Recall@5/10, citations, anchors, quotation checks). Add `RS_EVIDENCE_LIVE=1 RS_EVIDENCE_MODEL=…` (and `RS_EVIDENCE_KIND`, `RS_EVIDENCE_BASE_URL`, `RS_EVIDENCE_API_KEY`) to measure assessments with a real model. |
| `pnpm --filter @research-studio/research-retrieval eval` | Retrieval evaluation (Recall@5/10, MRR, nDCG@10) on the labelled set; set `RS_EVAL_OLLAMA_URL` and `RS_EVAL_MODEL` to include a real embedding model. |
| `pnpm check` | typecheck + lint + test |
| `pnpm db:generate` | Generate a migration after editing `packages/database/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to the configured database (the runtime also does this on start) |

Further reading:

- [`docs/architecture.md`](docs/architecture.md): components, data flow, compile pipeline
- [`docs/security.md`](docs/security.md): threat model and mitigations
- [`docs/API_SPECIFICATION.md`](docs/API_SPECIFICATION.md): literature, library, document and retrieval routes
- [`docs/LITERATURE_ENGINE.md`](docs/LITERATURE_ENGINE.md): providers, merging, ranking, caching
- [`docs/LIBRARY.md`](docs/LIBRARY.md): the personal library, PDF storage, `.bib` updates, Zotero
- [`docs/PAPER_INGESTION.md`](docs/PAPER_INGESTION.md), [`docs/DOCUMENT_INTELLIGENCE.md`](docs/DOCUMENT_INTELLIGENCE.md), [`docs/RESEARCH_RETRIEVAL.md`](docs/RESEARCH_RETRIEVAL.md), [`docs/EMBEDDING_PROVIDERS.md`](docs/EMBEDDING_PROVIDERS.md), [`docs/RETRIEVAL_EVALUATION.md`](docs/RETRIEVAL_EVALUATION.md): full text and search
- [`docs/VISUAL_STUDIO.md`](docs/VISUAL_STUDIO.md) and the image-to-LaTeX documents linked from it; [`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md): providers, images, privacy and consent
- [`docs/EVIDENCE_ENGINE.md`](docs/EVIDENCE_ENGINE.md) and the evidence documents linked from it: claims, evidence, citations, writing and review
- [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md): every table
- [`docs/decisions/`](docs/decisions/): architecture decision records

## Not in this milestone

OCR of scanned PDFs, hosted embedding providers, AI summaries of papers or
literature reviews, autonomous writing, automatic acceptance of citations,
judgements of truth, proof checking, data validation, automatic resolution
of disagreements between sources, unreviewed rewriting of whole manuscripts,
submission, automatic two-way Zotero sync and Zotero group libraries,
collaboration, Git
integration, attaching images to assistant conversations (images are used by
the Visual Studio only), OCR engines and model-free digitising, tool use, an OS-level sandbox for TeX, and
shell-escape packages such as `minted`.
