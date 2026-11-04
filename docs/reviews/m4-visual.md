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

## Part 2: Engineering report (2026-11-04)

Status labels used below: **[tested]** implemented and covered by automated
tests; **[not live]** implemented but not verified against a real external
service; **[partial]** partly implemented; **[not done]** not implemented.

### 1. Architectural changes

- Three new packages (`visual-engine`, `visual-assets`,
  `visual-artifacts`) and one runtime service (`VisualRuntime`) with its
  routes, contracts and events. No new provider abstraction: visual tasks use
  `ModelProvider.generateStructured` from M2. **[tested]**
- `ai-core`: image parts may carry `detail`; `ModelProvider` may implement
  `describeModel` (per-model vision). Ollama's catalog entry now has vision.
  **[tested]**
- `model-adapters`: Ollama sends images and checks `/api/show`
  capabilities; OpenAI forwards `detail`. **[tested against a mock server, not live]**
- `research-library`: the store key pattern accepts `webp` and `svg`, so the
  visual store can reuse the class with its own root. **[tested]**
- Database migration `0004_visual` with a down script. **[tested]**
- Web: a new `#/visual` screen and entry points from the project list and
  the workspace top bar; live events update its queries. **[tested]**

### 2. New packages and files

- `packages/visual-engine`: `errors/`, `preprocessing/` (validator,
  normaliser, SVG sanitiser), `schemas/` (task, equation, diagram, circuit,
  plot), `equations/`, `diagrams/`, `circuits/`, `plots/`, `refinement/`,
  `compile/` (safety, standalone, isolated compiler), `providers/`
  (routing), `orchestrator/` (prompts, builders, orchestrator); tests
  `generators.test.ts` (32), `orchestrator.test.ts` (11), opt-in `live.test.ts`.
- `packages/visual-assets`: `asset-service.ts`; `assets.test.ts` (12).
- `packages/visual-artifacts`: `artifact-service.ts`,
  `project-insertion.ts`; `artifacts.test.ts` (8).
- `packages/api-contracts/src/visual.ts`, client methods `visual.*`, events.
- `apps/runtime/src/services/visual-runtime.ts`, `routes-visual.ts`, config;
  `test/visual.test.ts` (16).
- `apps/web/src/features/visual/` (studio, input, PDF region picker,
  preview, source, results, insertion, consent, diff, model, queries, hooks);
  `test/visual.test.tsx` (10).
- `e2e/visual.spec.ts`, `e2e/mock-ollama-server.mjs`.
- Docs: `VISUAL_STUDIO.md`, `IMAGE_TO_EQUATION.md`,
  `DIAGRAM_RECONSTRUCTION.md`, `QUANTUM_CIRCUITS.md`,
  `PLOT_RECONSTRUCTION.md`, `VISUAL_VALIDATION.md`, `AI_PROVIDERS.md`, and
  updates to README, architecture, security, checklist, API spec, schema and
  `.env.example`.

### 3. Vision provider integrations

| Provider | Image serialisation | Structured output | Status |
| --- | --- | --- | --- |
| Ollama | `images` (base64) per message; `/api/show` vision check | `format` JSON Schema | [tested] with a mock server (unit and E2E through the real adapter); [not live] |
| OpenAI | `image_url` data URL with `detail` | strict `json_schema` | [tested] serialisation against a mock; [not live] |
| Anthropic | base64 `image` blocks (M2) | `output_config.format` (M2) | [tested] in M2 against a mock; [not live] for vision tasks |
| Gemini | `inlineData` (M2) | `responseJsonSchema` (M2) | [tested] in M2 against a mock; [not live] for vision tasks |
| OpenAI-compatible | not sent | not used | refused for visual tasks [tested] |

Routing and consent (local only for Ollama on loopback, cloud needs consent
per task, refusals for adapters without vision or structured output and for
text-only Ollama models) are [tested] at the engine, HTTP and UI levels.
Per-model vision for hosted providers is not known in advance [partial].

### 4. Image preprocessing

Signature and type check, size and pixel limits (decompression bombs),
decode check, dimension limits, SVG allowlist sanitising and rasterising,
variants (auto-orient, rotate, crop, resize, greyscale, contrast,
normalise, sharpen, upscale) with lineage and versioned operations, and
provider-ready downscaling: **[tested]**. Deskew is approximated by
auto-orient plus normalise; there is no angle-detecting deskew **[partial]**.

### 5. Equation reconstruction functionality

Structured answers with environment, uncertain symbols (location,
alternatives, reason), missing parts and warnings; Unicode and wrapper
normalisation; validation; formatting for inline, equation, align, gather,
cases, matrix and custom; package detection; real compiles of every
environment including derivatives, integrals, sums, bra-ket and
commutators: **[tested]** with scripted model answers. Recognition quality
on real handwriting: **[not live]**.

### 6. TikZ reconstruction

Structured model (nodes, edges, annotations, styles, ambiguities),
deterministic generation, four layout modes, validation, real compiles,
text-to-diagram, refinement as structural operations (or exact edits after
hand editing) with topology changes reported: **[tested]**. Visual
fidelity to real figures: **[not live]**.

### 7. Quantikz implementation

Gates, rotations with parameters, controlled gates (CNOT, CZ, general),
gates on adjacent qubits, swaps, measurements with classical wires,
resets, barriers, column scheduling, index and relation validation, labels
in math mode, real compiles: **[tested]**. Classical control (gates
conditioned on bits) and multiple named registers beyond qubit labels:
**[not done]**.

### 8. Circuitikz implementation

Resistors, capacitors, inductors, voltage and current sources, diodes,
wires, ground and junctions, connection validation, braced labels with
values, real compiles: **[tested]**. Batteries, LEDs, switches, lamps and
meters are mapped to Circuitikz but not covered by a compile test
**[partial]**. Transistors, op-amps and other multi-terminal components:
**[not done]**.

### 9. Plot reconstruction

Least-squares axis calibration (linear, log, reversed) with residual
warnings, pixel-to-value conversion with half-pixel uncertainty, error
bars, model estimates as a labelled fallback, origins per value (exact,
digitised, model-estimated), restyle, manual recalibration and exact data
without a model call: **[tested]**. Contour plots are recognised but not
digitised **[not done]**. Accuracy of pixel positions given by a real model:
**[not live]**.

### 10. CSV and PGFPlots generation

`plotTableCsv` (wide, `nan` for missing values) read by PGFPlots,
`plotExportCsv` with origin and uncertainty per row, `parseXyCsv` for
exact data with per-line errors, `generatePgfplots` for linear and log axes
(`axis`, `semilogxaxis`, `semilogyaxis`, `loglogaxis`), reversed axes,
legends, error bars, line, scatter, bar and histogram styles, real
compiles reading the CSV: **[tested]**.

### 11. Artifact storage and versioning

Assets content-addressed with lineage; artifacts with versions that are
never overwritten (model, manual, refinement, restore, calibration),
restore as a copy, line diff and structure comparison, approval of one
compiled version, task records with provider, model, privacy mode, consent
time, prompt version and usage: **[tested]**. Reopening earlier results
from the header uses the tested artifact list route; the selector itself
has no UI test **[partial]**.

### 12. LaTeX compilation isolation

Static safety check, package allowlist through a wrapper, `kpsewhich`
check with no installation, a throwaway owner-only folder outside every
project, the hardened `compileProject` (no shell escape, paranoid reads and
writes, sanitised environment), time limit, cancellation, cleanup, status
`succeeded` only with a PDF and no errors: **[tested]** with real pdfLaTeX.
There is still no OS-level sandbox around TeX (as in M1) **[partial]**;
CPU and memory are bounded only by the time limit.

### 13. Frontend functionality

Input from upload, paste, drop, project images and library PDF regions;
preprocessing; task, provider, model, layout, context and Precise; consent
dialog; preview of input and compiled result; explanation view; LaTeX editor
with validate and save as version; CSV, exact data, axes and style;
structure view; warnings, validation, packages, log and versions with
compare and restore; Improve, presets, Reconstruct, Precise, Explain,
Compile, Approve, Insert, Copy, Export; insertion review with diffs,
preamble opt-in, stale-preview handling, apply and undo; resizable and
collapsible panels, tabs on narrow screens: **[tested]** (component tests
with axe, Chromium E2E with axe including contrast at desktop and 390 px).
The PDF region picker is covered by unit tests of the coordinate
conversion and by the HTTP route, not by a browser test **[partial]**.

### 14. API endpoints

All routes listed in the assignment exist under `/api/v1/visual` (tasks,
cancel, retry, choose, equations, diagrams, circuits and plots reconstruct,
diagrams and captions generate, artifacts, versions, restore, validate,
compile, insert) plus assets, providers, preview, refine, plot, approve,
compare, export, insertion preview, insertions and rollback; Zod-validated
inputs, schema-checked responses and events, async tasks with progress and
cancellation, audit events: **[tested]** (`docs/API_SPECIFICATION.md`).

### 15. Security controls

T51 to T58 in `docs/security.md`: image validation and bomb limits, SVG
sanitising, inert serving, per-task consent for anything off the computer,
static LaTeX refusal and isolated compile, structured model output treated
as data, reviewed compare-and-swap insertion with rollback, path guards.
**[tested]**. Audit events carry IDs, sizes, provider, model and privacy
mode, never images, prompts or answers (by construction; there is no test
that scans the audit log for image bytes).

### 16. Scientific validation results

- Every output format compiles with pdfLaTeX from fixtures that cover the
  required cases (equations of each kind, the qubit-resonator diagram, a
  Bell circuit and a larger gate set, an RLC circuit, linear, log and
  reversed plots with error bars). **[tested]**
- Digitising is exact on synthetic calibrations (values recovered to six
  significant digits, residual warnings on inconsistent ticks, half-pixel
  uncertainties in data units). **[tested]**
- Uncertainty is surfaced, not resolved: uncertain symbols, dashed
  uncertain elements, digitised and estimated values, interpretations
  labelled as such. **[tested]**
- Reconstruction accuracy on real images is **not measured**: there is no
  labelled image benchmark and no real model run in this environment.
  **[not done]**

### 17. Automated test results

`pnpm -r --no-bail test`: **953 passed, 25 failed, 7 skipped**. The 25
failures are all in packages M4 did not change and are environmental:
`agent-adapters` 11 and `runtime` 9 (Claude Code and Codex CLIs absent),
`latex-engine` 4 (XeLaTeX absent for one test; three log fixtures are kept
out of the repository by the root `.gitignore` rule `*.log`, reported as a
follow-up), `document-engine` 1 (a Windows-path test on Linux). M4 tests:
`visual-engine` 43, `visual-assets` 12, `visual-artifacts` 8, `database` 3
new, `model-adapters` 2 new, runtime 16, web 10, all passing. Playwright:
10 of 10 specs pass, including `e2e/visual.spec.ts`.

### 18. Build and lint results

`pnpm -r typecheck` and `pnpm -r lint` pass in every package (strict
TypeScript, typescript-eslint strict).

### 19. Remaining limitations

- No real vision model was run (mocked providers; opt-in live test exists).
- No measurement of reconstruction quality on real images.
- Only Ollama on loopback counts as local; a model's own retention policy
  is outside the app's control once consent is given.
- Assistant conversations still cannot attach images.
- No OCR engine or model-free digitiser; contour plots not digitised.
- Quantikz without classical control; Circuitikz without multi-terminal
  components.
- TeX is restricted, not sandboxed; the time limit is the only resource cap.
- PGFPlots data paths in inserted figures are relative to the main file.

### 20. Recommendations for M5

- Build a small licensed image benchmark (equations, diagrams, circuits,
  plots) with reference source and measure reconstruction accuracy per model
  before relying on any model for scientific content.
- Run the opt-in live test against the local and hosted models users are
  expected to configure, and record which pass.
- Keep the M4 separation of observation and interpretation as the input
  format for any verification work in M5, and never feed model
  interpretations back as evidence.
- Consider an OS-level sandbox (container or seccomp profile) for both
  project and visual compiles, with CPU and memory limits.
- Add image attachments to assistant conversations through the same
  validation, consent and provenance path.

M5 has not been started; M4 awaits independent review.
