# Diagram reconstruction (M4)

Tasks `diagram` (from an image) and `text-to-diagram` (from a description)
produce TikZ through an intermediate structured model. The model never writes
TikZ itself.

## 1. Structured model

`DiagramOutputSchema` (`packages/visual-engine/src/schemas/diagram.schema.ts`):

- `nodes`: `id`, `label` (LaTeX text), `shape` (rectangle, rounded,
  circle, ellipse, diamond, point, text, cylinder), position `x`, `y` in
  centimetres (y up), optional `width` and `height`, `style` reference,
  `uncertain`, `note`
- `edges`: `id`, `from`, `to`, `label`, `arrow` (`->`, `<-`, `<->`, `-`),
  `line` (solid, dashed, dotted, thick), `bend` in degrees, `uncertain`
- `annotations`: free text at a position with an anchor
- `styles`: named fill, draw, line width, text colour, font
- `title`, `description`, `ambiguities`, `warnings`

Colours are restricted to named colours and `name!percent` mixes.

## 2. Layout modes

| Mode | Effect |
| --- | --- |
| `preserve` | positions as read from the image |
| `improve` | snapped to a 0.5 cm grid; nodes that land on the same point are moved apart |
| `publication` | as `improve`, without fills and colours, and uncertain elements not dashed |
| `alternative` | layered left-to-right layout from the edge structure |

Layout changes positions only; nodes, edges and labels stay the same.

## 3. Generation and validation

`generateTikz` writes a `tikzpicture` with named styles, nodes, edges
(arrow tips from `arrows.meta`, bends, loops),
annotations and the title. Uncertain elements are drawn dashed (except in the publication layout, where they are listed in the warnings only).
`validateDiagram` checks unique IDs, edges between known nodes, styles that
exist, and every label (balanced braces and `$`, the safety check). The
output is deterministic: the same structure gives the same source.

## 4. Refinement

**Improve** sends the instruction and the current structure; the model
answers with operations (`add-node`, `update-node`, `remove-node`,
`add-edge`, …, `set-style`, `set-title`) instead of a new diagram.
`applyDiagramPatch` applies them to the existing structure, so every
element not mentioned stays as it was, including your earlier changes. Changes
to connections are reported as topology changes; renaming IDs is refused.
Once the source has been edited by hand, refinements use exact find and
replace edits on the source (each `find` must occur exactly once), so hand
edits are not lost. Each refinement is a new version to compare or undo.

## 5. Tests

Real compiles of preserve, improve, publication and alternative layouts,
patch application and refusal, label safety
(`packages/visual-engine/test/generators.test.ts`), refinement with a
scripted provider (`test/orchestrator.test.ts`), and generation from text,
refinement, compare and restore over HTTP (`apps/runtime/test/visual.test.ts`).
