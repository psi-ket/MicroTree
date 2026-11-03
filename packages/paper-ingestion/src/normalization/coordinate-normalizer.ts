import { fromGrobidBox, mergeLineBoxes, type DocumentCoordinate, type PageGeometry } from '@research-studio/document-intelligence';

type Box = { page: number; x: number; y: number; w: number; h: number };

/**
 * Converts extractor boxes to canonical coordinates using the best page
 * geometry available (PyMuPDF's MediaBox/CropBox/rotation, else GROBID's
 * page sizes). Frame mismatches are reported once per kind as warnings.
 */
export class CoordinateNormalizer {
  private readonly geometry = new Map<number, PageGeometry>();
  private readonly grobidPages = new Map<number, { width: number; height: number }>();
  private readonly frames = new Set<string>();
  dropped = 0;

  constructor(pages: readonly PageGeometry[], grobidSurfaces: readonly { page: number; width: number; height: number }[] = []) {
    for (const p of pages) this.geometry.set(p.pageNumber, p);
    for (const s of grobidSurfaces) this.grobidPages.set(s.page, { width: s.width, height: s.height });
  }

  get pageCount(): number {
    return Math.max(this.geometry.size, this.grobidPages.size);
  }

  fromGrobid(boxes: readonly Box[]): DocumentCoordinate[] {
    const out: DocumentCoordinate[] = [];
    for (const b of boxes) {
      const { coordinate, frame } = fromGrobidBox(b, this.grobidPages.get(b.page) ?? null, this.geometry.get(b.page) ?? null);
      if (frame !== 'same') this.frames.add(frame);
      if (coordinate) out.push(coordinate);
      else this.dropped++;
    }
    return mergeLineBoxes(out);
  }

  warnings(): string[] {
    const w: string[] = [];
    if (this.frames.has('rotated')) w.push('GROBID reported some pages in their displayed (rotated) orientation; their boxes were rotated back.');
    if (this.frames.has('scaled')) w.push("GROBID's page sizes differ from the PDF's CropBox on some pages; boxes were scaled and may be offset.");
    if (this.frames.has('grobid-only')) w.push('Page geometry (rotation, CropBox) was not available; boxes assume unrotated pages.');
    if (this.dropped) w.push(`${this.dropped} boxes outside their page were dropped.`);
    return w;
  }
}
