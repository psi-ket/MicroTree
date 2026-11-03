import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  CoordinateError,
  fromGrobidBox,
  fromPdfUserSpace,
  fromPyMuPdfBox,
  mergeLineBoxes,
  normalizeRotation,
  pageRange,
  parseGrobidCoords,
  rotateNormalizedRect,
  toCanonical,
  toNormalized,
  toPdfUserSpace,
  toViewportRect,
  unrotateNormalizedRect,
  type DocumentCoordinate,
  type PageGeometry,
  type Rotation,
} from '../src';
import { makeLayoutPdf } from './fixtures/make-pdf';

const letter: PageGeometry = { pageNumber: 1, width: 612, height: 792, rotation: 0, mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792] };

function box(page: number, x: number, y: number, w: number, h: number, size = { width: 612, height: 792 }): DocumentCoordinate {
  return { pageNumber: page, x, y, width: w, height: h, coordinateSystem: 'pdf-points', pageWidth: size.width, pageHeight: size.height, origin: 'top-left' };
}

describe('coordinate model', () => {
  it('parses GROBID coords with one-based pages and skips malformed entries', () => {
    expect(parseGrobidCoords('1,53.80,194.57,58.71,9.29;2,10,20,30,40')).toEqual([
      { page: 1, x: 53.8, y: 194.57, w: 58.71, h: 9.29 },
      { page: 2, x: 10, y: 20, w: 30, h: 40 },
    ]);
    expect(parseGrobidCoords('0,1,2,3,4;x,1,2,3,4;1,2,3;')).toEqual([]);
    expect(parseGrobidCoords(null)).toEqual([]);
  });

  it('converts bottom-left and normalised input to canonical top-left points', () => {
    const bl = toCanonical({ ...box(1, 72, 700, 100, 12), origin: 'bottom-left' });
    expect(bl).toMatchObject({ x: 72, y: 80, width: 100, height: 12, origin: 'top-left' });
    const n = toCanonical({ ...box(1, 0.5, 0.25, 0.1, 0.1), coordinateSystem: 'normalized' });
    expect(n).toMatchObject({ x: 306, y: 198, width: 61.2, height: 79.2, coordinateSystem: 'pdf-points' });
    expect(toNormalized(box(1, 306, 396, 61.2, 79.2))).toMatchObject({ x: 0.5, y: 0.5, coordinateSystem: 'normalized' });
  });

  it('rejects zero-based pages and broken values', () => {
    expect(() => toCanonical(box(0, 1, 1, 1, 1))).toThrow(CoordinateError);
    expect(() => toCanonical(box(1, Number.NaN, 1, 1, 1))).toThrow(CoordinateError);
  });

  it('round-trips PDF user space through CropBox offsets', () => {
    const cropped: PageGeometry = { ...letter, width: 512, height: 682, cropBox: [50, 60, 562, 742] };
    const c = fromPdfUserSpace([100, 600, 200, 612], cropped)!;
    expect(c).toMatchObject({ x: 50, y: 130, width: 100, height: 12, pageWidth: 512, pageHeight: 682 });
    expect(toPdfUserSpace(c, cropped)).toEqual([100, 600, 200, 612]);
  });

  it('takes PyMuPDF boxes as they are and clamps them to the page', () => {
    expect(fromPyMuPdfBox([72, 87.1, 182, 103.6], letter)).toMatchObject({ x: 72, y: 87.1 });
    expect(fromPyMuPdfBox([-10, -5, 20, 10], letter)).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
    expect(fromPyMuPdfBox([700, 900, 800, 950], letter)).toBeNull();
  });

  it('rotates normalised rectangles and inverts the rotation', () => {
    const r = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    expect(rotateNormalizedRect(r, 90)).toEqual({ x: expect.closeTo(0.7, 9), y: expect.closeTo(0.1, 9), width: expect.closeTo(0.1, 9), height: expect.closeTo(0.3, 9) });
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      const back = unrotateNormalizedRect(rotateNormalizedRect(r, rot), rot);
      expect(back.x).toBeCloseTo(r.x, 9);
      expect(back.y).toBeCloseTo(r.y, 9);
      expect(back.width).toBeCloseTo(r.width, 9);
    }
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
  });

  it('reads GROBID boxes in the same, rotated or scaled frame', () => {
    expect(fromGrobidBox({ page: 1, x: 10, y: 20, w: 30, h: 5 }, { width: 612, height: 792 }, letter).frame).toBe('same');
    const rotated: PageGeometry = { ...letter, rotation: 90 };
    // GROBID saw the displayed (landscape) page: a box at the displayed top-left
    // is at the unrotated bottom-left.
    const r = fromGrobidBox({ page: 1, x: 0, y: 0, w: 79.2, h: 61.2 }, { width: 792, height: 612 }, rotated);
    expect(r.frame).toBe('rotated');
    expect(r.coordinate).toMatchObject({ x: 0, width: expect.closeTo(61.2, 6), height: expect.closeTo(79.2, 6) });
    expect(r.coordinate!.y).toBeCloseTo(792 - 79.2, 6);
    const s = fromGrobidBox({ page: 1, x: 306, y: 396, w: 10, h: 10 }, { width: 1224, height: 1584 }, letter);
    expect(s.frame).toBe('scaled');
    expect(s.coordinate).toMatchObject({ x: 153, y: 198, width: 5 });
    expect(fromGrobidBox({ page: 1, x: 1, y: 1, w: 1, h: 1 }, null, null).coordinate).toBeNull();
  });

  it('keeps lines of a paragraph as separate boxes and merges words on a line', () => {
    const words = [box(1, 72, 100, 30, 10), box(1, 104, 100, 40, 10), box(1, 72, 114, 50, 10), box(2, 72, 80, 20, 10)];
    const merged = mergeLineBoxes(words);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ x: 72, width: 72 });
    expect(pageRange(merged)).toEqual({ pageStart: 1, pageEnd: 2 });
    expect(pageRange([])).toEqual({ pageStart: null, pageEnd: null });
  });

  it('places boxes on viewports of different sizes and rotations', () => {
    const c = box(1, 61.2, 79.2, 61.2, 79.2);
    expect(toViewportRect(c, { width: 612, height: 792, rotation: 0 })).toEqual({ left: 61.2, top: 79.2, width: 61.2, height: 79.2 });
    const r180 = toViewportRect(c, { width: 1224, height: 1584, rotation: 180 });
    expect(r180.left).toBeCloseTo(1224 - 244.8, 6);
    expect(r180.top).toBeCloseTo(1584 - 316.8, 6);
    const a4 = toViewportRect(box(1, 0, 0, 595, 842, { width: 595, height: 842 }), { width: 595 * 1.5, height: 842 * 1.5, rotation: 0 });
    expect(a4).toEqual({ left: 0, top: 0, width: 892.5, height: 1263 });
  });
});

describe('alignment with PDF.js rendering', () => {
  const cases: { name: string; rotate?: Rotation; cropBox?: [number, number, number, number]; width?: number; height?: number }[] = [
    { name: 'letter' },
    { name: 'A4', width: 595, height: 842 },
    { name: 'rotated 90', rotate: 90 },
    { name: 'rotated 180', rotate: 180 },
    { name: 'rotated 270', rotate: 270 },
    { name: 'CropBox', cropBox: [50, 60, 562, 742] },
    { name: 'CropBox and rotation', rotate: 90, cropBox: [40, 30, 500, 700] },
  ];

  for (const c of cases) {
    it(`maps a text box to the same viewport rectangle as PDF.js (${c.name})`, async () => {
      const w = c.width ?? 612;
      const h = c.height ?? 792;
      const bytes = makeLayoutPdf([{ width: w, height: h, rotate: c.rotate ?? 0, ...(c.cropBox ? { cropBox: c.cropBox } : {}), texts: [{ x: 120, y: 500, text: 'Majorana zero modes', size: 12 }] }]);
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const [vx0, vy0, vx1, vy1] = page.view as [number, number, number, number];
      const geometry: PageGeometry = {
        pageNumber: 1,
        width: vx1 - vx0,
        height: vy1 - vy0,
        rotation: normalizeRotation(page.rotate),
        mediaBox: [0, 0, w, h],
        cropBox: c.cropBox ?? null,
      };
      const item = (await page.getTextContent()).items[0] as { transform: number[]; width: number; height: number };
      const ex = item.transform[4]!;
      const ey = item.transform[5]!;
      const userBox: [number, number, number, number] = [ex, ey, ex + item.width, ey + item.height];
      const coord = fromPdfUserSpace(userBox, geometry)!;
      for (const scale of [1, 1.5]) {
        const viewport = page.getViewport({ scale });
        const [a, b] = viewport.convertToViewportPoint(userBox[0], userBox[1]) as [number, number];
        const [cc, d] = viewport.convertToViewportPoint(userBox[2], userBox[3]) as [number, number];
        const expected = { left: Math.min(a, cc), top: Math.min(b, d), width: Math.abs(cc - a), height: Math.abs(d - b) };
        const got = toViewportRect(coord, viewport);
        expect(got.left).toBeCloseTo(expected.left, 3);
        expect(got.top).toBeCloseTo(expected.top, 3);
        expect(got.width).toBeCloseTo(expected.width, 3);
        expect(got.height).toBeCloseTo(expected.height, 3);
      }
      await task.destroy();
    });
  }
});
