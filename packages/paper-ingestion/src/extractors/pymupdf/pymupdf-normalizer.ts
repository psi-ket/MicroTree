import {
  classifySection,
  cleanText,
  emptyMetadata,
  findArxivId,
  findDoi,
  fromPyMuPdfBox,
  mergeLineBoxes,
  normalizeRotation,
  pageRange,
  splitHeadingNumber,
  levelFromNumber,
  type BlockType,
  type DocumentCoordinate,
  type NormalizedBlock,
  type NormalizedDocument,
  type NormalizedElement,
  type NormalizedReference,
  type NormalizedSection,
  type PageGeometry,
  type PdfBox,
  type SectionType,
} from '@research-studio/document-intelligence';
import { attachSentences, dedupeBlocks, emptyQuality, sectionPaths } from '../../normalization/structure-normalizer';
import type { ProcessingLimits } from '../../security/processing-limits';
import type { PyMuPdfBlock, PyMuPdfOutput, PyMuPdfPage } from './pymupdf-client';

/** Page geometry as PyMuPDF reports it (unrotated CropBox size, rotation, boxes in PDF user space). */
export function pageGeometry(out: PyMuPdfOutput): PageGeometry[] {
  return out.pages.map((p) => ({
    pageNumber: p.number,
    width: p.width,
    height: p.height,
    rotation: normalizeRotation(p.rotation),
    mediaBox: p.mediaBox as PdfBox,
    cropBox: p.cropBox as PdfBox,
  }));
}

/** All text PyMuPDF found, page by page (for coverage checks). */
export function pageTexts(out: PyMuPdfOutput): string[] {
  return out.pages.map((p) => p.blocks.flatMap((b) => b.lines.map((l) => l.spans.map((s) => s.text).join(''))).join('\n'));
}

export type TextLayerKind = 'text' | 'image-only' | 'empty';

/**
 * Whether the PDF has a usable text layer. Image-only means pages carry
 * images but (almost) no characters: a scan that needs OCR. A PDF with
 * neither is empty, not "scanned".
 */
export function textLayerKind(out: PyMuPdfOutput): TextLayerKind {
  const chars = out.pages.reduce((n, p) => n + p.charCount, 0);
  const minChars = Math.max(40, 10 * out.pages.length);
  if (chars >= minChars) return 'text';
  return out.pages.some((p) => p.imageCount > 0) ? 'image-only' : 'empty';
}

interface Line {
  text: string;
  size: number;
  bold: boolean;
  box: number[];
}

interface LayoutBlock {
  page: PyMuPdfPage;
  lines: Line[];
  box: number[];
  column: number;
}

const BOLD = 16;

function lineOf(l: PyMuPdfBlock['lines'][number]): Line {
  const text = l.spans.map((s) => s.text).join('');
  let chars = 0;
  let size = 0;
  let boldChars = 0;
  for (const s of l.spans) {
    const n = s.text.trim().length;
    chars += n;
    size += s.size * n;
    if (s.flags & BOLD || /bold|black|heavy/i.test(s.font)) boldChars += n;
  }
  return { text, size: chars ? size / chars : (l.spans[0]?.size ?? 0), bold: chars > 0 && boldChars / chars > 0.8, box: l.bbox };
}

/** The most common font size by characters: the body text size. */
function bodySize(blocks: LayoutBlock[]): number {
  const hist = new Map<number, number>();
  for (const b of blocks) for (const l of b.lines) hist.set(Math.round(l.size * 2) / 2, (hist.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.trim().length);
  let best = 10;
  let bestN = -1;
  for (const [s, n] of hist) if (n > bestN) [best, bestN] = [s, n];
  return best;
}

const shape = (t: string) => t.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');

/** Lines repeated near the top or bottom of most pages (running heads, page numbers). */
function repeatedMargins(pages: PyMuPdfPage[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const b of p.blocks)
      for (const l of b.lines) {
        const [, y0, , y1] = l.bbox as [number, number, number, number];
        if (y1 > p.height * 0.08 && y0 < p.height * 0.92) continue;
        const key = shape(l.spans.map((s) => s.text).join(''));
        if (key) seen.add(key);
      }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.5));
  return new Set([...counts].filter(([k, n]) => n >= min || /^(page )?#( of #)?$/.test(k)).map(([k]) => k));
}

/**
 * Reading order for one page: bands separated by full-width blocks; inside a
 * band, a gutter near the middle that no block crosses splits two columns,
 * read left then right, each top to bottom. Pages without such a gutter are
 * read top to bottom.
 */
export function readingOrder(page: PyMuPdfPage, blocks: { box: number[] }[]): number[] {
  const w = page.width;
  const idx = blocks.map((_, i) => i);
  const crosses = (b: { box: number[] }, x: number) => b.box[0]! < x - 2 && b.box[2]! > x + 2;
  let gutter: number | null = null;
  for (let x = w * 0.4; x <= w * 0.6; x += 2) {
    const narrow = blocks.filter((b) => b.box[2]! - b.box[0]! < w * 0.55);
    const left = narrow.filter((b) => b.box[2]! <= x + 2).length;
    const right = narrow.filter((b) => b.box[0]! >= x - 2).length;
    if (left >= 1 && right >= 1 && !narrow.some((b) => crosses(b, x))) {
      gutter = x;
      break;
    }
  }
  const byY = (a: number, b: number) => blocks[a]!.box[1]! - blocks[b]!.box[1]! || blocks[a]!.box[0]! - blocks[b]!.box[0]!;
  if (gutter === null) return idx.sort(byY);
  const full = idx.filter((i) => crosses(blocks[i]!, gutter)).sort(byY);
  const out: number[] = [];
  let top = -Infinity;
  for (const f of [...full, -1]) {
    const bottom = f === -1 ? Infinity : blocks[f]!.box[1]!;
    const band = idx.filter((i) => !full.includes(i) && blocks[i]!.box[1]! >= top && blocks[i]!.box[1]! < bottom);
    out.push(...band.filter((i) => blocks[i]!.box[0]! < gutter).sort(byY), ...band.filter((i) => blocks[i]!.box[0]! >= gutter).sort(byY));
    if (f !== -1) {
      out.push(f);
      top = blocks[f]!.box[3]!;
    }
  }
  // Anything above the first band boundary not yet placed (should not happen) keeps vertical order.
  for (const i of idx.sort(byY)) if (!out.includes(i)) out.push(i);
  return out;
}

const CAPTION = /^(fig(?:ure)?\.?|table|tab\.)\s*([\dIVX]+[a-z]?)[.:|]?\s/i;

/**
 * The text fallback: PyMuPDF blocks in reading order, with headings guessed
 * from font size and weight. There is no equation or table structure.
 */
export function normalizeLayout(out: PyMuPdfOutput, limits: Pick<ProcessingLimits, 'maxBlocks' | 'maxReferences'>): NormalizedDocument {
  const pages = pageGeometry(out);
  const geometryOf = new Map(pages.map((p) => [p.pageNumber, p]));
  const margins = repeatedMargins(out.pages);
  const warnings: string[] = [
    'Structured extraction (GROBID) was not available for this document; sections, equations and tables come from the page layout only.',
  ];
  if (out.truncated) warnings.push('The document has more text than the processing limit; the end was left out.');

  const ordered: LayoutBlock[] = [];
  for (const page of out.pages) {
    const blocks: LayoutBlock[] = [];
    for (const b of page.blocks) {
      const lines = b.lines
        .filter((l) => {
          const [, y0, , y1] = l.bbox as [number, number, number, number];
          const inMargin = y1 <= page.height * 0.08 || y0 >= page.height * 0.92;
          return !(inMargin && margins.has(shape(l.spans.map((s) => s.text).join(''))));
        })
        .map(lineOf)
        .filter((l) => l.text.trim());
      if (!lines.length) continue;
      const box = [Math.min(...lines.map((l) => l.box[0]!)), Math.min(...lines.map((l) => l.box[1]!)), Math.max(...lines.map((l) => l.box[2]!)), Math.max(...lines.map((l) => l.box[3]!))];
      blocks.push({ page, lines, box, column: 0 });
    }
    for (const i of readingOrder(page, blocks)) ordered.push(blocks[i]!);
  }

  const body = bodySize(ordered);
  const firstPageMax = Math.max(0, ...ordered.filter((b) => b.page.number === 1).flatMap((b) => b.lines.map((l) => l.size)));
  const sections: NormalizedSection[] = [];
  const blocks: NormalizedBlock[] = [];
  const elements: NormalizedElement[] = [];
  const references: NormalizedReference[] = [];
  let current: NormalizedSection | null = null;
  let titleDone = false;
  let truncated = false;

  const coordsOf = (b: LayoutBlock): DocumentCoordinate[] =>
    mergeLineBoxes(b.lines.map((l) => fromPyMuPdfBox(l.box, geometryOf.get(b.page.number)!)).filter((c): c is DocumentCoordinate => c !== null));

  const push = (type: BlockType, text: string, coordinates: DocumentCoordinate[], elementKey: string | null = null) => {
    if (blocks.length >= limits.maxBlocks) {
      truncated = true;
      return;
    }
    blocks.push({ key: `b${blocks.length}`, sectionKey: current?.key ?? null, type, order: blocks.length, spans: [{ kind: 'text', text }], plainText: text, sourceId: null, ...pageRange(coordinates), coordinates, sentences: [], sentenceSource: 'none', elementKey });
  };

  const newSection = (heading: string, type: SectionType, coordinates: DocumentCoordinate[]) => {
    const { number, text } = splitHeadingNumber(heading);
    const level = levelFromNumber(number) ?? 1;
    let parentKey: string | null = null;
    for (let i = sections.length - 1; i >= 0; i--) if (sections[i]!.level < level) {
      parentKey = sections[i]!.key;
      break;
    }
    current = { key: `s${sections.length}`, parentKey, heading: number ? text : heading, number, level, order: sections.length, path: '', type, coordinates, pageStart: null, pageEnd: null };
    sections.push(current);
  };

  for (const b of ordered) {
    const text = cleanText(b.lines.map((l) => l.text).join('\n'));
    if (!text) continue;
    const c = coordsOf(b);
    const size = Math.max(...b.lines.map((l) => l.size));
    const short = b.lines.length <= 2 && text.length <= 120;
    const allBold = b.lines.every((l) => l.bold);

    const looksLikeSection = /\d/.test(splitHeadingNumber(text).number ?? '') || classifySection(text) !== 'body';
    if (!titleDone && b.page.number === 1 && short && size >= body * 1.3 && size >= firstPageMax - 0.25 && !looksLikeSection && b.box[1]! < b.page.height * 0.5) {
      titleDone = true;
      push('title', text, c);
      continue;
    }
    const looksLikeHeading = short && !/[.:;,]$/.test(text) && (size >= body * 1.15 || (allBold && (/^\d+(\.\d+)*\.?\s+\p{Lu}/u.test(text) || text.length <= 60)));
    if (looksLikeHeading) {
      const parent = current as NormalizedSection | null;
      const type = classifySection(text, parent && splitHeadingNumber(text).number?.includes('.') ? parent.type : null);
      newSection(text, type, c);
      push('heading', text, c);
      continue;
    }
    const inReferences = (current as NormalizedSection | null)?.type === 'references';
    if (inReferences) {
      // One block may hold several entries; split at "[n]" or "n." starts.
      const entries = text.split(/\s(?=\[\d{1,4}\]\s)|\s(?=\d{1,4}\.\s\p{Lu})/u).map((s) => s.trim()).filter(Boolean);
      for (const e of entries) {
        if (references.length >= limits.maxReferences) {
          truncated = true;
          break;
        }
        references.push({
          key: `r${references.length}`,
          order: references.length,
          raw: e,
          parsed: { title: null, authors: [], venue: null, year: Number(/\b(1[89]\d\d|20\d\d)\b/.exec(e)?.[1]) || null, volume: null, pages: null, publisher: null },
          doi: findDoi(e),
          arxivId: findArxivId(e),
          sourceId: null,
          coordinates: entries.length === 1 ? c : [],
          ...pageRange(c),
        });
        push('reference', e, entries.length === 1 ? c : []);
      }
      continue;
    }
    const cap = CAPTION.exec(text);
    if (cap) {
      const isTable = /^tab/i.test(cap[1]!);
      const el: NormalizedElement = { key: `e${elements.length}`, type: isTable ? 'table' : 'figure', sectionKey: (current as NormalizedSection | null)?.key ?? null, label: cap[2]!, caption: text, content: null, sourceId: null, coordinates: c, ...pageRange(c) };
      elements.push(el);
      push(isTable ? 'table_caption' : 'figure_caption', text, c, el.key);
      continue;
    }
    if ((current as NormalizedSection | null)?.type === 'abstract' || (!current && /^abstract\b/i.test(text))) {
      if (!current) newSection('Abstract', 'abstract', []);
      push('abstract', text.replace(/^abstract[.:—–-]?\s*/i, ''), c);
      continue;
    }
    push((current as NormalizedSection | null)?.type === 'acknowledgement' ? 'acknowledgement' : 'paragraph', text, c);
  }
  if (truncated) warnings.push('The document has more structures than the processing limits allow; the rest were left out.');

  const finalBlocks = attachSentences(dedupeBlocks(blocks, warnings));
  sectionPaths(sections, finalBlocks);
  const meta = out.metadata ?? {};
  const fullText = finalBlocks.slice(0, 40).map((b) => b.plainText).join('\n');
  const title = finalBlocks.find((b) => b.type === 'title')?.plainText ?? null;
  return {
    extractor: 'pymupdf',
    extractorVersion: out.version,
    metadata: {
      ...emptyMetadata(),
      title: title ?? (meta.title?.trim() || null),
      abstract: finalBlocks.filter((b) => b.type === 'abstract').map((b) => b.plainText).join('\n\n') || null,
      doi: findDoi(fullText),
      arxivId: findArxivId(fullText),
      keywords: meta.keywords ? meta.keywords.split(/[;,]/).map((k) => k.trim()).filter(Boolean) : [],
    },
    pages,
    sections,
    blocks: finalBlocks,
    elements,
    references,
    quality: emptyQuality('layout'),
    warnings,
  };
}
