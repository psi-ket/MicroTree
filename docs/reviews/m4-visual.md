# M4 — Visual intelligence and image-to-LaTeX reconstruction

Part 1 is the assessment and plan, written after the repository inspection
and before code changed. Part 2 is the engineering report.

## Part 1 — Assessment and plan (2026-11-03)

### 1. Architecture assessment

| Area | Finding | Use in M4 |
| --- | --- | --- |
| Model providers | `ai-core` `ModelProvider` with `stream` and `generateStructured<T>(request, { jsonSchema, parse })`; adapters for Anthropic, OpenAI, Gemini, OpenAI-compatible, Ollama in `model-adapters`; keys only in the runtime (`AiProviderService`, secret store). | Visual tasks call `generateStructured` on the configured provider. **No new provider abstraction.** |
| Agents | `AgentProvider` (Claude Code, Codex) runs in staging copies and returns file edits. | Not used for vision: agents have no image input path and edit files directly; the visual pipeline needs structured answers. |
| Compile | `latex-engine` `compileProject({ projectRoot, mainFile, engine, timeoutMs, signal })` with `latexmk -norc`, `shell_escape=f`, `openout_any=p`, `openin_any=p`, sanitised environment, link check, timeout, process-tree kill, log parsing. | Reused unchanged on a **throwaway workspace** under the data directory, never inside a project. |
| Project files | `ProjectService.writeFile` (path guard, compare-and-swap with base hash, create-only, audit, `files.changed`); `upload` for images. | Insertion writes through it only. |
| PDF store | `research-library` `AttachmentStorage`: content-addressed, owner-only, atomic writes, links refused, strict key pattern. | Reused as the class behind a separate visual store root (`<data>/visual`); the key pattern gains `webp` and `svg`. |
| PDFs and coordinates | M3.3 canonical coordinates and `PdfDocumentView` (pdf.js). | Region selection on library PDFs; the crop keeps attachment, page, region and the PDF hash. |
| Diff review | Monaco `DiffEditor` in `BibReviewDialog` and `CompareDialog`. | Insertion review and version comparison. |
| Web | Screens by hash route (`#/literature`, `#/library`), TanStack Query, live events. | New screen `#/visual` (`?from=<project>`). |

New packages:

```
visual-assets     validation (signature, decode, pixel limits, SVG sanitising), store, variants and provenance
visual-engine     schemas, routing and consent, preprocessing, prompts, orchestration,
                  equation/TikZ/Quantikz/Circuitikz/PGFPlots/CSV generators and validators,
                  plot digitising, refinement patches, standalone documents and isolated compile
visual-artifacts  artifacts, versions, restore, diff, insertion plan/apply/rollback
```

### 2. Existing multimodal capability assessment

- `MessageContent` has `{ type: 'image', mimeType: png|jpeg|webp, data }`;
  `validateRequestContent` checks magic bytes, 5 MB per image, 20 images and
  20 MB per request, user turns only, and refuses images for providers with
  `vision: false`.
- Anthropic (`image` base64 blocks), OpenAI (`image_url` data URL) and Gemini
  (`inlineData`) already serialise images and structured output
  (`output_config.format`, `response_format: json_schema` strict,
  `responseJsonSchema`).
- **Ollama does not send images** (`vision: false`); M4 adds its documented
  `images` (base64) field on `/api/chat` messages, and a per-model check
  through `/api/show` `capabilities` (`vision`), since many local models are
  text-only.
- OpenAI-compatible endpoints keep `vision: false` and no structured output
  (servers differ).
- OpenAI image `detail` (`low`, `high`, `auto`) becomes an optional field of
  the image part, used only by the OpenAI adapter.
- Per-model vision support is not known for hosted providers; a model that
  rejects images surfaces as a provider error.

### 3. Image storage design

- Originals and variants are stored once by SHA-256 in `<RS_DATA_DIR>/visual`
  (the M3.2 store class, its own root). Rows in `visual_assets` hold kind
  (`original`, `variant`, `render`), MIME type, size, dimensions, SHA-256,
  parent asset, preprocessing operations (JSON) and their version, and
  provenance (`upload`, `clipboard`, `project-file` with project and path,
  `pdf-region` with attachment, PDF SHA-256, page and canonical region,
  `generated`).
- The original is never changed; every variant names its parent and the
  exact operations, so it can be rebuilt.
- Compiled PDFs of artifact versions are stored as `render` assets.

### 4. Visual task data model (migration `0004_visual`)

| Table | Purpose |
| --- | --- |
| `visual_assets` | images and renders (above) |
| `visual_tasks` | `task_type`, `project_id`, `source_asset_id` (+ variant), `source_attachment_id`, `source_page`, provider ID, kind and model, `privacy_mode` (`local`, `cloud`), consent time, `prompt_version`, `config` (JSON), `status` (`queued`, `running`, `needs_input`, `completed`, `failed`, `cancelled`), error, usage, artifact ID, timestamps |
| `visual_artifacts` | `artifact_type` (`equation`, `diagram`, `quantum-circuit`, `electrical-circuit`, `plot`, `explanation`), title, current version, approval (`draft`, `approved`) with time, timestamps |
| `visual_artifact_versions` | number, `source_code`, `structured_data` (JSON), `data_csv`, warnings, `origin` (`model`, `manual`, `refinement`, `restore`), change description, `compilation_status`, diagnostics, preview asset, required packages |
| `visual_insertions` | project, artifact version, files created (path and hash), file modified (path, hash before and after, original content), status (`applied`, `rolled-back`) |

### 5. Provider routing design

A visual task names a configured AI provider and model. Routing checks, in
order: the adapter has `vision` (and `structuredOutput`) for image tasks;
for Ollama, the model reports `vision`; the privacy mode: **local** when the
provider is Ollama on a loopback address, otherwise **cloud**, which needs
an explicit consent for that task (the request carries `consent: true`
after the UI has shown the provider, model, image and size). Text-to-diagram
needs only structured output. The runtime alone reads the image bytes and
the key.

### 6. Structured output contracts

Zod schemas with matching JSON Schemas (strict-mode compatible: every field
required, nullable where optional, no additional properties):
`EquationReconstruction`, `ScientificDiagram` (nodes, edges, annotations,
styles), `QuantumCircuit`, `ElectricalCircuit` (components with terminals
and nets), `PlotReconstruction` (axes with calibration, series with pixel
points and/or values, legend, error bars), `FigureExplanation`
(observations separate from interpretation, caption), `TaskClassification`
(task with alternatives and an `ambiguous` flag), and `DiagramPatch`
(operations on a diagram) and `SourcePatch` (exact find/replace edits).
Confidence values are kept as "model-reported" and never shown as
probabilities.

### 7. Reconstruction strategy

- **Equations**: the model returns LaTeX with environment, uncertain symbols
  and alternatives; the runtime validates (balanced groups, environments,
  allowed commands), formats the environment and compiles.
- **Diagrams, circuits, plots**: the model returns the **structure**; the
  runtime **generates** TikZ, Quantikz, Circuitikz and PGFPlots
  deterministically from it. Source is always genuine editable LaTeX, and the
  same structure always gives the same source. Topology checks (edges refer
  to nodes; qubit indices, controls not equal to targets; components connect
  to nets) run before generation.
- **Plots**: axis calibration from two reference ticks per axis (linear, log,
  reversed); points the model located in pixels become data through the
  calibration, with an uncertainty of one pixel step; values only read by
  the model are marked `model-estimated`; user CSV is `exact`. Data is kept
  separately from the PGFPlots style.
- **Refinement**: structured artifacts are changed by `DiagramPatch`
  operations on the structure; sources edited by hand are changed by exact
  find/replace edits. Each refinement is a new version; nothing earlier is
  overwritten.
- **Explanations and captions**: observations (visible labels, axes) are
  separate from interpretation; no results are asserted beyond what is
  visible or supplied.

### 8. Compilation and rendering strategy

Each version is wrapped in a `standalone` document with exactly the
packages it needs (from an allowlist), written to
`<RS_DATA_DIR>/visual-builds/<random>/main.tex` and compiled with the
existing `compileProject` (pdfLaTeX, the hardened environment, 60 s limit),
then the workspace is removed. Before compiling, a validator refuses
primitives that read, write or run anything (`\input`, `\include`,
`\openin`, `\openout`, `\write`, `\immediate`, `\read`, `\catcode`,
`\csname`, `\directlua`, `\usepackage` in the body, `\special`, …) and
packages outside the allowlist. Missing packages are reported (`kpsewhich`
result from the log), never installed. The PDF is stored as a `render`
asset and shown with pdf.js. "Compiled" is shown only after a successful
compile.

### 9. Security review

| Threat | Control |
| --- | --- |
| Malformed images, decompression bombs | Signature must match the declared type; `sharp` decodes with `limitInputPixels` (40 MP) and a size limit (20 MB); dimensions capped; failures refused. |
| Malicious SVG | Parsed as untrusted XML (no DTD or entities), allowlist of elements and attributes, scripts, event handlers, `foreignObject`, external `href`s and CSS URLs removed; rasterised only after sanitising; shown with `<img>` from a blob. |
| Paths | Assets addressed by ID; project files through `ProjectService` (path guard); generated file names are slugs. |
| Generated LaTeX | Validated before compiling; compiled only in a throwaway workspace with shell escape off and paranoid reads/writes; time-limited; removed afterwards. |
| Prompt injection via images | System prompts state that text in images is data; the model's output can only be a structured value validated by schema; it cannot run tools or change permissions. |
| Cloud transmission | Explicit per-task consent for non-local providers; the UI shows provider, model, image and size; audit records provider kind and model, never keys or images. |
| Manuscript changes | Only through a reviewed insertion plan applied with compare-and-swap; rollback only when the file still holds what was written. |

### 10. Frontend design

`#/visual` (from the project list and the workspace top bar): left panel
(upload, paste, drop, project images, region from a library PDF, preview,
crop, rotate, adjustments with variants), task selector, centre (original,
compiled preview, side by side, zoom, errors), right (Monaco source editor,
CSV table, structured view), bottom (log, warnings, packages, validation,
versions with compare and restore). Actions: reconstruct, refine
(conversational), recompile, approve, insert into a project (diff review),
roll back. Panels resize and collapse; narrow screens stack them.

### 11. Test plan

Image pipeline with generated PNG/JPEG/WebP, a decompression-bomb PNG, a
malformed file, hostile SVGs; preprocessing and provenance. Adapter tests
for Ollama image serialisation and vision probing. Engine tests per output
format with **real pdfLaTeX compiles** (TeX Live 2023 installed in this
environment): equations (inline, display, align, cases, matrix, bra-ket,
commutators, integrals, sums), TikZ diagrams, Quantikz circuits, Circuitikz
circuits, PGFPlots (linear, log, error bars, multiple series), CSV; plot
calibration math; validators (forbidden primitives, unbalanced input,
invalid indices); refinement patches. Orchestrator tests with mocked
providers (malformed output, refusal, rate limits, cancellation, consent,
unsupported images). Runtime integration tests over the API. Web component
tests and a Playwright run.
