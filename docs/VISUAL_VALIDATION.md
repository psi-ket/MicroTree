# Visual validation and isolated compilation (M4)

## 1. Image validation (`packages/visual-engine/src/preprocessing`, `packages/visual-assets`)

Every image is checked before it is stored:

| Check | Rule |
| --- | --- |
| Signature | PNG, JPEG, WebP or SVG by content; a declared type that disagrees is refused (`415`) |
| Size | `RS_VISUAL_MAX_IMAGE_BYTES` (default 20 MB), also enforced by the multipart limit |
| Decode | the image must decode with sharp (`failOn: 'error'`) |
| Pixels | `RS_VISUAL_MAX_IMAGE_PIXELS` (default 40 million) through `limitInputPixels`, checked before decoding the pixels: decompression bombs are refused (`413`) |
| Dimensions | at most 12 000 px per side, at least 1 |
| SVG | parsed with the hardened XML reader from M3.3 (no DTD, no entities, size, depth and node limits) and rebuilt from an allowlist of drawing elements and presentation attributes. Scripts, `foreignObject`, event handlers, external references (anything but `#id`), `style` with `url(` or `@import` are removed and reported. The sanitised SVG is rasterised to PNG for display and for the model; the SVG source is never served. |

Preprocessing (`auto-orient`, `rotate`, `crop`, `resize`, `grayscale`,
`contrast`, `normalize`, `sharpen`, `upscale`) makes a variant: a new image
with its parent, the original, the operations and the preprocessing version.
The original is never changed. Images sent to a model are scaled to at most
2048 px per side and re-encoded as PNG or JPEG under the providers' limits.

Stored images are served with `Content-Security-Policy: default-src 'none';
…; sandbox`, `X-Content-Type-Options: nosniff` and `inline` disposition.

## 2. Static checks on generated LaTeX (`compile/latex-safety.ts`)

Before compiling or inserting, source is checked:

- **Forbidden** (error): file and stream access (`\input`, `\include`,
  `\openin`, `\openout`, `\read`, `\write`, `\immediate`, `\write18`, …),
  definitions and aliases (`\def`, `\let`, `\newcommand`,
  `\renewcommand`, `\newenvironment`, `\DeclareRobustCommand`, …),
  catcode and character-code changes (`\catcode`, `\lccode`, `^^`),
  control sequences built from strings (`\csname`, `\scantokens`,
  `\expandafter`), Lua and PDF primitives (`\directlua`, `\special`,
  `\pdfobj`, …), `\includegraphics`, `\usepackage`, `\documentclass`,
  `\makeatletter`, `\begin{document}`, `\end{document}`, mode changes
  and control characters.
- **PGFPlots tables** may only name a plain relative `.csv` file.
- **Structure**: balanced braces, `\begin`/`\end` and `\left`/`\right`.
- **Length**: 200 000 characters.

A version with errors is stored as `invalid` and never compiled.

## 3. Packages

Packages are loaded only by the wrapper, from an allowlist: `amsmath`,
`amssymb`, `amsfonts`, `mathtools`, `bm`, `braket`, `physics`, `xcolor`,
`tikz`, `quantikz`, `circuitikz`, `pgfplots`, `siunitx`, `tensor`, `esint`,
`cancel`, `upgreek`; TikZ libraries `arrows.meta`, `positioning`,
`shapes.geometric`, `calc`, `decorations.pathmorphing`, `fit`,
`backgrounds`. Before compiling, `kpsewhich` checks that they are
installed; missing ones fail the compile with an install hint. **Packages
are never installed** by Research Studio, and a project's preamble changes
only when you tick the option in the insertion review.

## 4. Isolated compile (`compile/isolated-compiler.ts`)

- A new owner-only folder `<data dir>/visual-builds/vb-<random>` per
  compile, never inside a project, holding only `main.tex` and the plot's
  CSV; removed afterwards whatever happened.
- The existing hardened `compileProject` from `latex-engine`: `latexmk
  -norc`, pdfLaTeX, `shell_escape=f`, `openout_any=p`, `openin_any=p`,
  sanitised environment, link check, process-tree kill.
- Time limit `RS_VISUAL_COMPILE_TIMEOUT_MS` (60 s); cancellation stops it.
- The result is `succeeded` only with a PDF and no error diagnostics.
  Diagnostics, the log tail and the PDF (as a `render` asset) are stored on
  the version.

The app never calls a result validated without a successful compile, and
approval requires one.

## 5. Tests

`packages/visual-engine/test/generators.test.ts` compiles every output
format, checks every forbidden construct class, timeouts, cleanup of the
workspace and missing-package reporting.
`packages/visual-assets/test/assets.test.ts` covers signatures, mismatched
types, oversized files, a decompression bomb, malicious SVG (scripts,
handlers, external references, `foreignObject`, entity payloads) and
variant lineage. `apps/runtime/test/visual.test.ts` checks the HTTP
behaviour (inert serving, no SVG source, refused types).
