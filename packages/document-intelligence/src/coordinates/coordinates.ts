/**
 * Source locations in a PDF, and the explicit transformations between the
 * coordinate systems involved.
 *
 * Canonical form (what is stored): `coordinateSystem: 'pdf-points'`,
 * `origin: 'top-left'`, measured from the top-left corner of the page's
 * **CropBox** in the **unrotated** page frame, with `pageWidth`/`pageHeight`
 * the unrotated CropBox size. Page numbers are one-based everywhere.
 *
 * - GROBID reports `p,x,y,w,h` in PDF units from the top-left of the CropBox
 *   (falling back to the MediaBox), with page sizes in `<facsimile>`.
 *   Whether its frame is rotated is checked against the page geometry
 *   (`fromGrobidBox`), never assumed.
 * - PyMuPDF text coordinates are CropBox-relative, top-left origin, unrotated
 *   frame (`page.rect` is the rotated size, `get_text("dict")` width/height the
 *   unrotated one).
 * - PDF user space has a bottom-left origin and absolute positions
 *   (`fromPdfUserSpace`).
 * - PDF.js renders the rotated page; `toViewportRect` maps a canonical box to
 *   viewport pixels for any `viewport.rotation`.
 */

export type CoordinateSystem = 'pdf-points' | 'normalized' | 'pymupdf';
export type CoordinateOrigin = 'top-left' | 'bottom-left';

export interface DocumentCoordinate {
  /** One-based. */
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSystem: CoordinateSystem;
  pageWidth: number;
  pageHeight: number;
  origin: CoordinateOrigin;
}

export type Rotation = 0 | 90 | 180 | 270;

/** `[x0, y0, x1, y1]` in PDF user space (bottom-left origin). */
export type PdfBox = [number, number, number, number];

export interface PageGeometry {
  /** One-based. */
  pageNumber: number;
  /** Unrotated CropBox width in points. */
  width: number;
  /** Unrotated CropBox height in points. */
  height: number;
  rotation: Rotation;
  mediaBox: PdfBox | null;
  cropBox: PdfBox | null;
}

export class CoordinateError extends Error {
  override name = 'CoordinateError';
}

const EPS = 0.5;

export function normalizeRotation(value: number): Rotation {
  const r = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

function finite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

/** Clamp a canonical box to its page; boxes entirely outside the page are dropped (null). */
export function clampToPage(c: DocumentCoordinate): DocumentCoordinate | null {
  const x0 = Math.max(0, c.x);
  const y0 = Math.max(0, c.y);
  const x1 = Math.min(c.pageWidth, c.x + c.width);
  const y1 = Math.min(c.pageHeight, c.y + c.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { ...c, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function canonical(pageNumber: number, x: number, y: number, width: number, height: number, page: { width: number; height: number }): DocumentCoordinate {
  return { pageNumber, x, y, width, height, coordinateSystem: 'pdf-points', pageWidth: page.width, pageHeight: page.height, origin: 'top-left' };
}

/** Rotate a normalised rectangle (unrotated frame, top-left origin) into the frame displayed with `rotation` (clockwise). */
export function rotateNormalizedRect(r: { x: number; y: number; width: number; height: number }, rotation: Rotation) {
  const corners: [number, number][] = [
    [r.x, r.y],
    [r.x + r.width, r.y + r.height],
  ];
  const mapped = corners.map(([u, v]) => {
    switch (rotation) {
      case 90:
        return [1 - v, u] as const;
      case 180:
        return [1 - u, 1 - v] as const;
      case 270:
        return [v, 1 - u] as const;
      default:
        return [u, v] as const;
    }
  });
  const xs = mapped.map((m) => m[0]);
  const ys = mapped.map((m) => m[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The inverse of `rotateNormalizedRect`: a box seen on the displayed page, back to the unrotated frame. */
export function unrotateNormalizedRect(r: { x: number; y: number; width: number; height: number }, rotation: Rotation) {
  return rotateNormalizedRect(r, ((360 - rotation) % 360) as Rotation);
}

/** Any supported coordinate, in canonical form. */
export function toCanonical(c: DocumentCoordinate): DocumentCoordinate {
  if (!finite(c.x, c.y, c.width, c.height, c.pageWidth, c.pageHeight) || c.pageWidth <= 0 || c.pageHeight <= 0) {
    throw new CoordinateError('Coordinate has non-finite values or an empty page');
  }
  if (!Number.isInteger(c.pageNumber) || c.pageNumber < 1) throw new CoordinateError('Page numbers are one-based integers');
  let { x, y, width, height } = c;
  if (c.coordinateSystem === 'normalized') {
    x *= c.pageWidth;
    width *= c.pageWidth;
    y *= c.pageHeight;
    height *= c.pageHeight;
  }
  if (c.origin === 'bottom-left') y = c.pageHeight - y - height;
  return canonical(c.pageNumber, x, y, width, height, { width: c.pageWidth, height: c.pageHeight });
}

/** A canonical box as fractions of the page (0..1), still unrotated and top-left. */
export function toNormalized(c: DocumentCoordinate): DocumentCoordinate {
  const k = toCanonical(c);
  return { ...k, x: k.x / k.pageWidth, y: k.y / k.pageHeight, width: k.width / k.pageWidth, height: k.height / k.pageHeight, coordinateSystem: 'normalized' };
}

/** A PyMuPDF `bbox` (`[x0, y0, x1, y1]`, CropBox-relative, top-left, unrotated) on a page. */
export function fromPyMuPdfBox(bbox: readonly number[], page: PageGeometry): DocumentCoordinate | null {
  const [x0, y0, x1, y1] = bbox;
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || !finite(x0, y0, x1, y1)) return null;
  return clampToPage(canonical(page.pageNumber, x0, y0, x1 - x0, y1 - y0, page));
}

/** A box in absolute PDF user space (bottom-left origin) on a page with a known CropBox. */
export function fromPdfUserSpace(box: PdfBox, page: PageGeometry): DocumentCoordinate | null {
  const crop = page.cropBox ?? page.mediaBox ?? [0, 0, page.width, page.height];
  const [bx0, by0, bx1, by1] = box;
  const x = Math.min(bx0, bx1) - Math.min(crop[0], crop[2]);
  const yTop = Math.max(crop[1], crop[3]) - Math.max(by0, by1);
  return clampToPage(canonical(page.pageNumber, x, yTop, Math.abs(bx1 - bx0), Math.abs(by1 - by0), page));
}

/** A canonical box back to PDF user space (bottom-left origin, absolute). */
export function toPdfUserSpace(c: DocumentCoordinate, page: PageGeometry): PdfBox {
  const k = toCanonical(c);
  const crop = page.cropBox ?? page.mediaBox ?? [0, 0, page.width, page.height];
  const left = Math.min(crop[0], crop[2]);
  const top = Math.max(crop[1], crop[3]);
  return [left + k.x, top - k.y - k.height, left + k.x + k.width, top - k.y];
}

/**
 * A GROBID box (`p,x,y,w,h`) with GROBID's page size for that page. When the
 * page geometry (from PyMuPDF) is known, the frame is checked:
 * - same size as the unrotated CropBox → same frame;
 * - width and height swapped on a 90°/270° page → GROBID saw the displayed page; unrotated here;
 * - another size → scaled, with a warning from the caller.
 */
export function fromGrobidBox(
  box: { page: number; x: number; y: number; w: number; h: number },
  grobidPage: { width: number; height: number } | null,
  page: PageGeometry | null,
): { coordinate: DocumentCoordinate | null; frame: 'same' | 'rotated' | 'scaled' | 'grobid-only' } {
  if (!finite(box.x, box.y, box.w, box.h) || box.w < 0 || box.h < 0) return { coordinate: null, frame: 'same' };
  if (!page) {
    if (!grobidPage) return { coordinate: null, frame: 'grobid-only' };
    return { coordinate: clampToPage(canonical(box.page, box.x, box.y, box.w, box.h, grobidPage)), frame: 'grobid-only' };
  }
  const gw = grobidPage?.width ?? page.width;
  const gh = grobidPage?.height ?? page.height;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(EPS, 0.01 * b);
  if (near(gw, page.width) && near(gh, page.height)) {
    return { coordinate: clampToPage(canonical(page.pageNumber, box.x, box.y, box.w, box.h, page)), frame: 'same' };
  }
  const normalized = { x: box.x / gw, y: box.y / gh, width: box.w / gw, height: box.h / gh };
  if ((page.rotation === 90 || page.rotation === 270) && near(gw, page.height) && near(gh, page.width)) {
    const r = unrotateNormalizedRect(normalized, page.rotation);
    return { coordinate: clampToPage(canonical(page.pageNumber, r.x * page.width, r.y * page.height, r.width * page.width, r.height * page.height, page)), frame: 'rotated' };
  }
  return {
    coordinate: clampToPage(canonical(page.pageNumber, normalized.x * page.width, normalized.y * page.height, normalized.width * page.width, normalized.height * page.height, page)),
    frame: 'scaled',
  };
}

/** Parse GROBID's `coords` attribute (`p,x,y,w,h;p,x,y,w,h`). Malformed entries are skipped. */
export function parseGrobidCoords(attr: string | null | undefined): { page: number; x: number; y: number; w: number; h: number }[] {
  if (!attr) return [];
  const out: { page: number; x: number; y: number; w: number; h: number }[] = [];
  for (const part of attr.split(';')) {
    const nums = part.split(',').map((s) => Number(s.trim()));
    if (nums.length < 5) continue;
    const [page, x, y, w, h] = nums as [number, number, number, number, number];
    if (!Number.isInteger(page) || page < 1 || !finite(x, y, w, h)) continue;
    out.push({ page, x, y, w, h });
  }
  return out;
}

export interface Viewport {
  /** Displayed width and height in CSS pixels (PDF.js `viewport.width/height`). */
  width: number;
  height: number;
  /** Total rotation PDF.js applied (`viewport.rotation`: the page's /Rotate plus any extra). */
  rotation: number;
}

/** Where a canonical box appears on a PDF.js viewport, in pixels from the viewport's top-left. */
export function toViewportRect(c: DocumentCoordinate, viewport: Viewport): { left: number; top: number; width: number; height: number } {
  const n = toNormalized(c);
  const r = rotateNormalizedRect(n, normalizeRotation(viewport.rotation));
  return { left: r.x * viewport.width, top: r.y * viewport.height, width: r.width * viewport.width, height: r.height * viewport.height };
}

/** First and last page of a set of boxes (null when there are none). */
export function pageRange(coords: readonly DocumentCoordinate[]): { pageStart: number | null; pageEnd: number | null } {
  if (!coords.length) return { pageStart: null, pageEnd: null };
  let pageStart = Infinity;
  let pageEnd = -Infinity;
  for (const c of coords) {
    pageStart = Math.min(pageStart, c.pageNumber);
    pageEnd = Math.max(pageEnd, c.pageNumber);
  }
  return { pageStart, pageEnd };
}

/**
 * Merge boxes that sit on the same line and touch (words of one line), keeping
 * separate lines and pages apart: a multi-line paragraph stays a list of line
 * boxes, never one rectangle that would cover the neighbouring column.
 */
export function mergeLineBoxes(coords: readonly DocumentCoordinate[], gap = 3): DocumentCoordinate[] {
  const out: DocumentCoordinate[] = [];
  for (const c of coords) {
    const last = out.at(-1);
    if (
      last &&
      last.pageNumber === c.pageNumber &&
      Math.abs(last.y - c.y) <= Math.max(1, 0.3 * Math.min(last.height, c.height)) &&
      Math.abs(last.height - c.height) <= Math.max(1.5, 0.5 * Math.max(last.height, c.height)) &&
      c.x >= last.x - gap &&
      c.x <= last.x + last.width + gap
    ) {
      const x0 = Math.min(last.x, c.x);
      const y0 = Math.min(last.y, c.y);
      const x1 = Math.max(last.x + last.width, c.x + c.width);
      const y1 = Math.max(last.y + last.height, c.y + c.height);
      out[out.length - 1] = { ...last, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

/** The smallest box around boxes on one page. */
export function unionOnPage(coords: readonly DocumentCoordinate[]): DocumentCoordinate | null {
  const first = coords[0];
  if (!first) return null;
  if (coords.some((c) => c.pageNumber !== first.pageNumber)) throw new CoordinateError('unionOnPage needs boxes on one page');
  const x0 = Math.min(...coords.map((c) => c.x));
  const y0 = Math.min(...coords.map((c) => c.y));
  const x1 = Math.max(...coords.map((c) => c.x + c.width));
  const y1 = Math.max(...coords.map((c) => c.y + c.height));
  return { ...first, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
