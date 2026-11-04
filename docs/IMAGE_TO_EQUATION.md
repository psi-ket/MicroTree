# Image to equation (M4)

Tasks `equation`, `handwritten-equation` and `derivation` turn an image of
mathematics into LaTeX.

## 1. Model answer

The model returns `EquationOutputSchema` (`packages/visual-engine/src/schemas/equation.schema.ts`):

| Field | Meaning |
| --- | --- |
| `latex` | the mathematics only, without `$…$`, `\[…\]` or an environment |
| `environment` | `inline`, `equation`, `align`, `gather`, `cases`, `matrix` or `custom` |
| `explanation` | one sentence on what the expression is |
| `symbolUncertainties` | `{ location, alternatives, reason }` for every symbol that could be read more than one way |
| `missingParts` | parts that are illegible or cut off |
| `warnings` | anything else to check |
| `confidence` | the model's own confidence (not a calibrated probability) |

Handwriting gets a prompt that asks for alternatives instead of guesses;
derivations ask for one aligned line per step.

## 2. Processing

1. **Normalise** (`equation-normalizer.ts`): wrappers the model added
   (`$…$`, `\[…\]`, `\begin{equation}…`) are removed; Unicode symbols are
   mapped to commands (`α` → `\alpha`, `≤` → `\leq`, `ℏ` → `\hbar`, …) and
   every mapping is reported.
2. **Validate** (`equation-validator.ts`): braces, `\begin`/`\end` and
   `\left`/`\right` balance, alignment markers only in multi-line
   environments, and the static safety check
   ([`VISUAL_VALIDATION.md`](VISUAL_VALIDATION.md)). Errors mark the version
   `invalid` (it is never compiled); warnings are listed.
3. **Format** (`equation-formatter.ts`): the chosen environment, with an
   optional label and starred form.
4. **Packages**: detected from the commands used (`amsmath`, `amssymb`,
   `mathtools`, `bm`, `braket` or `physics`, `siunitx`, `cancel`,
   `upgreek`, `esint`, `tensor`, `xcolor`).
5. **Compile**: a `standalone` document (`varwidth`) in the isolated
   compiler. Only a version that compiled can be approved.

Uncertainties, missing parts and model warnings appear in the Warnings tab;
nothing is filled in silently.

## 3. Insertion

Equations are inserted as their source into the chosen `.tex` file (with
`\label{…}` added to numbered environments when a label is given). The
packages the equation needs are compared with the main file's preamble;
adding them is a separate, explicit choice in the review.

## 4. Tests

`packages/visual-engine/test/generators.test.ts` compiles every environment
with pdfLaTeX, checks normalisation, the unsafe-construct refusals and
unbalanced input; `test/orchestrator.test.ts` runs the task with a scripted
provider; `apps/runtime/test/visual.test.ts` runs it over HTTP with a real
compile.
