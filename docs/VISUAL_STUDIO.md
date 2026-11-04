# Visual Studio (M4)

The Visual Studio turns images of scientific content into editable LaTeX.
It is a page of the web app (`#/visual`, or `#/visual?from=<projectId>` to
return to a project and insert into it) backed by the runtime routes under
`/api/v1/visual`.

Related documents: [`IMAGE_TO_EQUATION.md`](IMAGE_TO_EQUATION.md),
[`DIAGRAM_RECONSTRUCTION.md`](DIAGRAM_RECONSTRUCTION.md),
[`QUANTUM_CIRCUITS.md`](QUANTUM_CIRCUITS.md),
[`PLOT_RECONSTRUCTION.md`](PLOT_RECONSTRUCTION.md),
[`VISUAL_VALIDATION.md`](VISUAL_VALIDATION.md),
[`AI_PROVIDERS.md`](AI_PROVIDERS.md).

## 1. What it does

| Task | Output | Notes |
| --- | --- | --- |
| Printed or handwritten equation, derivation | LaTeX in `inline`, `equation`, `align`, `gather`, `cases`, `matrix` or a custom environment | uncertain symbols and missing parts are listed, never filled in silently |
| Diagram | TikZ generated from a structured model (nodes, edges, annotations, styles) | layouts: keep, tidy, publication, alternative |
| Quantum circuit | Quantikz | gates, controls, measurements, classical wires, barriers |
| Electrical circuit | Circuitikz | components, nodes, ground, junctions |
| Plot | PGFPlots plus CSV | digitised from calibrated axes; values marked exact, digitised or model-estimated |
| Explain figure, caption | observations, interpretation, uncertainties, a draft caption | interpretation is shown apart from what was observed |
| Diagram from text | TikZ from a description | no image is sent |
| Detect automatically | one of the above | when the model is unsure, the task stops and asks which one |

Raster output is never the result: every task gives editable source. The
compiled PDF is only a preview.

## 2. Using it

**Input (left).** Upload, paste (Ctrl+V anywhere outside a text field, or
the Paste button), drop a file, choose an image from the project, or take a
region of a library PDF (pick a paper, go to the page, drag a box). PNG,
JPEG, WebP and SVG are accepted. Preprocessing buttons (rotate, normalise,
contrast, greyscale, enhance) each make a new image linked to the original;
**Original** goes back. Colour is kept unless you choose greyscale.

**Task.** Choose the task (or automatic detection), the provider and the
model, optionally a context sentence (data for the model, not instructions),
and **Precise** to send the image at full detail. The provider list says
which providers run on this computer (`local`: Ollama on a loopback address)
and which do not (`cloud`).

**Consent.** A task for a cloud provider is refused by the runtime until you
confirm it in a dialog that names the provider, the model, what is sent
(the image with its size in bytes and pixels, or your text) and an
approximate image token count. The confirmation is stored on that task only.

**Preview (centre).** The input image and the compiled result side by side.
A result is shown only when the isolated compile succeeded; otherwise the
panel says why (failed, refused by validation, not compiled).

**Source (right).** The LaTeX in an editor (**Save as new version**,
**Validate**), and for plots the CSV and the axes and style. **Structure**
shows the structured model the source was generated from.

**Results (bottom).** Warnings, validation and compile diagnostics, packages,
the compile log and the version history (compare any two, restore any).

**Actions (toolbar).** Improve (a change in words), Simplify or a style
preset, Reconstruct, Precise, Explain, Compile, Approve, Insert, Copy and
Export (`.tex` snippet, standalone document, CSV with origins, JSON
structure).

Panels resize and collapse; below 1100 px they become tabs. Tasks run in
the background and the page stays usable.

## 3. Versions, approval, insertion

- Every change is a new version: model output, hand edit, refinement,
  restyle, recalibration and restore. Nothing is overwritten. Restoring copies
  an old version into a new one.
- **Approve** names one version, and only a version that compiled can be
  approved (captions have nothing to compile on their own). A later version
  needs approval again.
- **Insert** opens a review dialog: choose the project and the `.tex` file
  (default: the main file, before `\end{document}`), caption and label, and
  whether to add missing packages to the main file's preamble. **Review
  changes** shows every new file (diagrams, circuits and plots go to
  `figures/<name>.tex`, plots also `figures/<name>-data.csv`, with unique names)
  and a diff of every changed file. Nothing is written until **Apply**.
- Applying writes exactly the reviewed plan: the runtime recomputes the plan
  and refuses with `STALE_PREVIEW` if anything differs. New files are
  create-only; changed files are written only if unchanged since the review.
  If a later write fails, earlier writes of that insertion are undone.
- **Undo** (rollback) restores the changed files and removes the new ones,
  but only when none of them changed after the insertion; otherwise it refuses
  and lists the files.

## 4. Architecture

```
apps/web  features/visual/*  ──HTTP + events──▶  apps/runtime  VisualRuntime
                                                  ├─ VisualAssetService   (packages/visual-assets)
                                                  ├─ runVisualTask, refineArtifact, builders,
                                                  │  generators, validators, IsolatedCompiler
                                                  │                        (packages/visual-engine)
                                                  ├─ ArtifactService, ProjectInsertionService
                                                  │                        (packages/visual-artifacts)
                                                  ├─ AiProviderService     (existing, M2)
                                                  └─ ProjectService        (existing, M1)
```

- **visual-assets**: validation (signature, declared type, size, dimensions,
  decode, pixel limit), SVG sanitising and rasterising, content-addressed
  storage in `<RS_DATA_DIR>/visual` (the M3.2 store class with its own root),
  variants with their operations, lineage, renders.
- **visual-engine**: Zod schemas for every model answer (sent as JSON
  Schema), provider routing and consent, prompts (versioned), the
  orchestrator, deterministic generators (equation formatter, TikZ,
  Quantikz, Circuitikz, PGFPlots, CSV), validators, the plot digitiser,
  refinement patches, standalone documents and the isolated compiler.
- **visual-artifacts**: artifacts, versions, restore, line diff, approval,
  insertion plan, apply and rollback.
- **Runtime** (`apps/runtime/src/services/visual-runtime.ts`): the task
  queue (two at a time by default, `RS_VISUAL_CONCURRENCY`), cancellation,
  retry, restart recovery (running tasks become failed), compile scheduling,
  the files port over `ProjectService`, audit events and the `visual.task`
  and `visual.artifact` events. Routes: `routes-visual.ts`; contracts:
  `packages/api-contracts/src/visual.ts`.

Model answers are always structured (JSON Schema, validated with Zod).
Diagram, circuit and plot source is generated from the structure by code;
it is not taken from the model. Equations are normalised and validated.

## 5. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RS_VISUAL_DIR` | `<data dir>/visual` | image and preview store |
| `RS_VISUAL_COMPILE_TIMEOUT_MS` | `60000` | per preview compile |
| `RS_VISUAL_MAX_IMAGE_BYTES` | `20971520` | per uploaded image |
| `RS_VISUAL_MAX_IMAGE_PIXELS` | `40000000` | decoded pixel limit (decompression bombs) |
| `RS_VISUAL_CONCURRENCY` | `2` | tasks run at once |

Compile workspaces are created under `<data dir>/visual-builds` and removed
after every compile.

## 6. Limits

- Accuracy depends on the model. Everything is a draft to check against the
  image; the app says so where it matters (uncertain symbols, dashed
  uncertain components, digitised values, interpretations).
- Only Ollama on this computer counts as local. Other hosts, including an
  Ollama server elsewhere on the network, are cloud and need consent.
- Per-model vision support is checked for Ollama (`/api/show`); for hosted
  providers a model without vision fails with the provider's error.
- No OCR engine and no non-model digitiser: reconstruction always uses the
  chosen model.
