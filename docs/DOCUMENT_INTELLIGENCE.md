# Document intelligence model (M3.3)

`packages/document-intelligence` defines the scholarly document model shared
by ingestion, retrieval, the API and the web app. It is pure TypeScript with
no dependencies, independent of GROBID's XML and of PyMuPDF's output.

## 1. Structures

| Structure | Contents |
| --- | --- |
| Metadata | title, authors (with affiliations and e-mail when given), abstract, publication date, DOI, arXiv ID, keywords, venue, language |
| Section | heading, printed number, level, order, path (`2 Methods › 2.1 Setup`), type, pages, heading boxes, parent |
| Block | one of `title`, `abstract`, `heading`, `paragraph`, `list`, `display_formula`, `inline_formula`, `figure_caption`, `table_caption`, `footnote`, `acknowledgement`, `reference`, `other`; inline spans (text, citation/figure/table/formula markers with their targets, inline formulas), plain text, extractor ID, pages, boxes, sentences |
| Sentence | text, pages, boxes (from GROBID `<s>`), or from the rule-based segmenter without boxes |
| Element | equation, figure or table: label, caption, extracted content, pages, boxes |
| Reference | raw string, parsed title, authors, venue, year, volume, pages, publisher, DOI, arXiv ID, pages, boxes |
| Quality | text coverage against the PDF's text layer, title and abstract found, counts, share of blocks with boxes, empty pages, `structured` or `layout` |

**Nothing is fabricated.** A structure the extractor did not report is
absent, and the absence is listed in the extraction's warnings ("No abstract
was found", "No bibliography was found"). An equation's `content` is the
characters extracted from the PDF; it is not a faithful rendering of the
mathematics and the interface says so. Tables keep their cell text only.
References are stored as extracted and are never marked verified; a link to
a library paper is shown only when the DOI or arXiv ID is identical.

Section types are classified from headings only (`Introduction`, `Methods`,
`Results`, `Discussion`, `Conclusion`, `Appendix`, `Acknowledgements`,
`References`, …); unknown headings are `body`, and subsections inherit
their parent's type.

## 2. Coordinates

```ts
interface DocumentCoordinate {
  pageNumber: number;          // one-based, everywhere
  x: number; y: number; width: number; height: number;
  coordinateSystem: 'pdf-points' | 'normalized' | 'pymupdf';
  pageWidth: number; pageHeight: number;
  origin: 'top-left' | 'bottom-left';
}
```

**Stored (canonical) form:** PDF points, origin at the top-left corner of the
page's **CropBox**, in the **unrotated** page frame; `pageWidth` and
`pageHeight` are the unrotated CropBox size. Page geometry (`PageGeometry`)
keeps width, height, rotation (0, 90, 180, 270), MediaBox and CropBox.

| Source | Its convention | Conversion |
| --- | --- | --- |
| GROBID TEI `coords="p,x,y,w,h;…"` | points, top-left of the CropBox (MediaBox when there is none), page sizes in `<facsimile>` | `fromGrobidBox` compares GROBID's page size with the PDF's: same size, the same frame; width and height swapped on a 90°/270° page, the displayed frame, rotated back; other sizes, scaled (with a warning). Never assumed. |
| PyMuPDF `bbox` | points, top-left of the CropBox, unrotated frame (verified with PyMuPDF 2.1) | `fromPyMuPdfBox` (clamped to the page) |
| PDF user space | points, bottom-left, absolute | `fromPdfUserSpace` / `toPdfUserSpace` through the CropBox |
| PDF.js viewport | pixels of the rotated, zoomed page | `toViewportRect(coord, viewport)` applies `viewport.rotation` and size |

A paragraph keeps one box per line (`mergeLineBoxes` joins words on a line,
never lines into one rectangle), and a passage that spans pages keeps the
boxes of each page. When no boxes exist, the page is still known when the
extractor reported it, and the viewer opens the page without a highlight.

The transforms are tested against PDF.js itself on generated PDFs (US
Letter, A4, rotations 90/180/270, a CropBox, a CropBox with rotation, two
zoom levels), and in Chromium end to end.

## 3. Provenance and versions

`PassageProvenance` ties every passage to the attachment and its SHA-256, the
extraction (extractor, version, parser version, configuration hash, time),
the section path and type, and the pages and boxes. `PARSER_VERSION` and
`SEGMENTER_VERSION` change whenever normalisation or segmentation would
produce different output; `staleReasons` compares an extraction with the
current settings.

## 4. Text helpers

- `normalizeSearchText`: NFKC (ligatures, full-width forms, superscript
  digits), soft hyphens and zero-width characters removed, line-break
  hyphenation repaired, dashes and quotes unified, lower case. Greek letters,
  `H_2`-style subscripts and identifiers are kept. The original text is never
  changed.
- `segmentSentences`: punctuation followed by a sentence start, except after
  common abbreviations (`et al.`, `Fig.`, `Eq.`, `i.e.`, …), single initials,
  decimals and identifiers; a trailing citation stays with its sentence.
- `estimateTokens`: a conservative token estimate without a tokenizer.
