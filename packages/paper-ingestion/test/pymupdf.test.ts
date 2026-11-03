import { describe, expect, it } from 'vitest';
import { fromPdfUserSpace } from '@research-studio/document-intelligence';
import { ExtractionError, normalizeLayout, pageGeometry, PyMuPdfClient, textLayerKind, type PyMuPdfConfiguration } from '../src';
import { lines, makeLayoutPdf } from '../../document-intelligence/test/fixtures/make-pdf';

const python = process.env.RS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const config: PyMuPdfConfiguration = { python, timeoutMs: 60_000, memoryMb: 1536, maxPages: 500, maxOutputBytes: 64 * 1024 * 1024, concurrency: 2 };
const client = new PyMuPdfClient(config);
const available = (await client.status()).status === 'available';
const signal = () => new AbortController().signal;
const limits = { maxBlocks: 10_000, maxReferences: 1000 };

const para = (prefix: string, n = 4) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1} of the paragraph text here`);

describe.skipIf(!available)('PyMuPDF extraction (real PyMuPDF)', () => {
  it('reports page sizes, rotation and the CropBox', async () => {
    const pdf = makeLayoutPdf([
      { texts: [{ x: 72, y: 700, text: 'Letter page', size: 12 }] },
      { width: 595, height: 842, texts: [{ x: 72, y: 700, text: 'A4 page' }] },
      { rotate: 90, texts: [{ x: 72, y: 700, text: 'Rotated page' }] },
      { cropBox: [50, 60, 562, 742], texts: [{ x: 100, y: 600, text: 'Cropped page', size: 12 }] },
    ]);
    const out = await client.extract(pdf, signal());
    const g = pageGeometry(out);
    expect(g.map((p) => [p.pageNumber, Math.round(p.width), Math.round(p.height), p.rotation])).toEqual([
      [1, 612, 792, 0],
      [2, 595, 842, 0],
      [3, 612, 792, 90],
      [4, 512, 682, 0],
    ]);
    expect(g[3]!.cropBox).toEqual([50, 60, 562, 742]);
  });

  it('gives text boxes that agree with the position in the PDF (CropBox-relative, top-left)', async () => {
    const pdf = makeLayoutPdf([
      { texts: [{ x: 72, y: 700, text: 'Lindblad master equation', size: 12 }] },
      { cropBox: [50, 60, 562, 742], texts: [{ x: 100, y: 600, text: 'Hamiltonian simulation', size: 12 }] },
    ]);
    const out = await client.extract(pdf, signal(), { words: true });
    const geometry = pageGeometry(out);
    for (const [i, x, y] of [
      [0, 72, 700],
      [1, 100, 600],
    ] as const) {
      const line = out.pages[i]!.blocks[0]!.lines[0]!;
      const expected = fromPdfUserSpace([x, y, x + 10, y + 10], geometry[i]!)!;
      expect(line.bbox[0]).toBeCloseTo(expected.x, 0);
      // The line box spans the font's ascent and descent around the baseline.
      expect(line.bbox[3]).toBeGreaterThan(expected.y + 10);
      expect(line.bbox[1]).toBeLessThan(expected.y + 10);
    }
    expect(out.pages[0]!.words!.map((w) => w[4])).toEqual(['Lindblad', 'master', 'equation']);
  });

  it('reads two columns column by column, with a full-width title first', async () => {
    const left = [...lines(72, 640, para('Left A')), ...lines(72, 560, para('Left B'))];
    const right = [...lines(320, 640, para('Right A')), ...lines(320, 560, para('Right B'))];
    const pdf = makeLayoutPdf([{ texts: [{ x: 120, y: 720, text: 'A Two Column Paper About Tensor Networks', size: 18 }, ...left, ...right] }]);
    const doc = normalizeLayout(await client.extract(pdf, signal()), limits);
    const order = doc.blocks.map((b) => b.plainText.slice(0, 7));
    expect(order[0]).toBe('A Two C');
    const iLA = order.findIndex((t) => t.startsWith('Left A'));
    const iLB = order.findIndex((t) => t.startsWith('Left B'));
    const iRA = order.findIndex((t) => t.startsWith('Right A'));
    const iRB = order.findIndex((t) => t.startsWith('Right B'));
    expect([iLA, iLB, iRA, iRB].every((i) => i > 0)).toBe(true);
    expect(iLA < iLB && iLB < iRA && iRA < iRB).toBe(true);
    // No paragraph mixes the two columns.
    expect(doc.blocks.some((b) => b.plainText.includes('Left') && b.plainText.includes('Right'))).toBe(false);
    expect(doc.blocks[0]!.type).toBe('title');
    expect(doc.extractor).toBe('pymupdf');
  });

  it('drops running heads and page numbers repeated on most pages, and guesses headings', async () => {
    const page = (n: number) => ({
      texts: [
        { x: 200, y: 770, text: 'Journal of Synthetic Physics', size: 8 },
        { x: 300, y: 30, text: `${n}`, size: 8 },
        { x: 72, y: 700, text: `${n} Section number ${n}`, size: 14, bold: true },
        ...lines(72, 670, para(`Body ${n}`)),
      ],
    });
    const doc = normalizeLayout(await client.extract(makeLayoutPdf([page(1), page(2), page(3), page(4)]), signal()), limits);
    const text = doc.blocks.map((b) => b.plainText).join('\n');
    expect(text).not.toContain('Journal of Synthetic Physics');
    expect(doc.sections.map((s) => s.heading)).toEqual(['Section number 1', 'Section number 2', 'Section number 3', 'Section number 4']);
    expect(doc.blocks.filter((b) => b.type === 'paragraph')).toHaveLength(4);
    expect(doc.blocks.every((b) => b.coordinates.length > 0)).toBe(true);
    expect(doc.blocks.find((b) => b.type === 'paragraph')!.sentenceSource).toBe('segmenter');
  });

  it('finds captions and splits a reference list', async () => {
    const pdf = makeLayoutPdf([
      {
        texts: [
          ...lines(72, 700, ['Figure 1: Wigner function of a cat state.']),
          { x: 72, y: 600, text: 'References', size: 14, bold: true },
          ...lines(72, 570, ['[1] P. W. Shor, Phys. Rev. A 52, R2493 (1995), doi:10.1103/PhysRevA.52.R2493.']),
          ...lines(72, 540, ['[2] A. Vaswani et al., arXiv:1706.03762 (2017).']),
        ],
      },
    ]);
    const doc = normalizeLayout(await client.extract(pdf, signal()), limits);
    expect(doc.elements[0]).toMatchObject({ type: 'figure', label: '1' });
    expect(doc.references.map((r) => [r.doi, r.arxivId, r.parsed.year])).toEqual([
      ['10.1103/physreva.52.r2493', null, 1995],
      [null, '1706.03762', 2017],
    ]);
  });

  it('tells scans (images, no text) from empty PDFs', async () => {
    expect(textLayerKind(await client.extract(makeLayoutPdf([{ image: true }, { image: true }]), signal()))).toBe('image-only');
    expect(textLayerKind(await client.extract(makeLayoutPdf([{}, {}]), signal()))).toBe('empty');
    expect(textLayerKind(await client.extract(makeLayoutPdf([{ texts: lines(72, 700, para('Text', 6)) }]), signal()))).toBe('text');
  });

  it('refuses malformed PDFs and too many pages', async () => {
    const err = await client.extract(new Uint8Array(Buffer.from('%PDF-1.4 this is not a pdf %%EOF')), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).code).toBe('malformed');
    const small = new PyMuPdfClient({ ...config, maxPages: 1 });
    const many = await small.extract(makeLayoutPdf([{}, {}]), signal()).catch((e: unknown) => e);
    expect((many as ExtractionError).code).toBe('too-many-pages');
  });

  it('stops on timeout and on cancellation', async () => {
    const slow = new PyMuPdfClient({ ...config, timeoutMs: 1 });
    expect(((await slow.extract(makeLayoutPdf([{}]), signal()).catch((e: unknown) => e)) as ExtractionError).code).toBe('timeout');
    const ac = new AbortController();
    const p = client.extract(makeLayoutPdf([{}]), ac.signal).catch((e: unknown) => e);
    ac.abort();
    expect(((await p) as ExtractionError).code).toBe('cancelled');
  });
});

describe('PyMuPDF availability', () => {
  it('reports a missing Python as unavailable instead of failing', async () => {
    const missing = new PyMuPdfClient({ ...config, python: 'definitely-not-a-python-binary' });
    expect(await missing.status()).toMatchObject({ status: 'unavailable', message: expect.stringContaining('not found') });
    const err = await missing.extract(makeLayoutPdf([{}]), signal()).catch((e: unknown) => e);
    expect((err as ExtractionError).code).toBe('unavailable');
  });
});
