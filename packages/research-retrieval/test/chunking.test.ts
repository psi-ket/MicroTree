import { describe, expect, it } from 'vitest';
import { emptyMetadata, type DocumentCoordinate, type NormalizedBlock, type NormalizedDocument, type NormalizedSection } from '@research-studio/document-intelligence';
import { DEFAULT_CHUNKING, embeddingInput, segmentDocument } from '../src';

const box = (page: number, y: number): DocumentCoordinate => ({ pageNumber: page, x: 72, y, width: 400, height: 10, coordinateSystem: 'pdf-points', pageWidth: 612, pageHeight: 792, origin: 'top-left' });

function words(n: number, word = 'qubit'): string {
  return Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ') + '.';
}

function doc(blocks: Partial<NormalizedBlock>[], sections: Partial<NormalizedSection>[]): NormalizedDocument {
  return {
    extractor: 'grobid',
    extractorVersion: '0.8.2',
    metadata: emptyMetadata(),
    pages: [],
    sections: sections.map((s, i) => ({ key: `s${i}`, parentKey: null, heading: `H${i}`, number: null, level: 1, order: i, path: `H${i}`, type: 'body', pageStart: 1, pageEnd: 1, coordinates: [], ...s })),
    blocks: blocks.map((b, i) => ({
      key: `b${i}`,
      sectionKey: 's0',
      type: 'paragraph',
      order: i,
      spans: [],
      plainText: '',
      sourceId: null,
      pageStart: 1,
      pageEnd: 1,
      coordinates: [box(1, 100 + i * 20)],
      sentences: [],
      sentenceSource: 'none',
      elementKey: null,
      ...b,
    })),
    elements: [],
    references: [],
    quality: { textCoverage: null, hasTitle: false, hasAbstract: false, sectionCount: 0, paragraphCount: 0, referenceCount: 0, coordinateCoverage: 0, emptyPages: [], structure: 'structured' },
    warnings: [],
  };
}

describe('passage segmentation', () => {
  it('groups paragraphs of one section up to the target and never crosses sections', () => {
    const d = doc(
      [
        { plainText: words(100) },
        { plainText: words(100) },
        { plainText: words(150) },
        { sectionKey: 's1', plainText: words(20) },
      ],
      [{ path: '1 Introduction', type: 'introduction' }, { path: '2 Methods', type: 'methods' }],
    );
    const p = segmentDocument(d, 'sha');
    expect(p.map((x) => [x.sectionPath, x.blockKeys])).toEqual([
      ['1 Introduction', ['b0', 'b1', 'b2']],
      ['2 Methods', ['b3']],
    ]);
    expect(p[0]!.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNKING.targetTokens);
    expect(p[0]!.text.split('\n\n')).toHaveLength(3); // paragraph boundaries kept in the text
    expect(p[0]!.coordinates).toHaveLength(3);
    expect(p[1]!.sectionType).toBe('methods');
  });

  it('starts a new passage when the next paragraph would pass the target', () => {
    const d = doc([{ plainText: words(300) }, { plainText: words(200) }], [{}]);
    expect(segmentDocument(d, 'sha').map((x) => x.blockKeys)).toEqual([['b0'], ['b1']]);
  });

  it('splits a long paragraph at sentence boundaries with overlap, using sentence boxes', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => ({ order: i, text: words(30, `s${i}w`), pageStart: 1, pageEnd: 1, coordinates: [box(1, 100 + i * 12)] }));
    const d = doc([{ plainText: sentences.map((s) => s.text).join(' '), sentences, sentenceSource: 'extractor' }], [{}]);
    const p = segmentDocument(d, 'sha');
    expect(p.length).toBeGreaterThan(1);
    for (const x of p) expect(x.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNKING.targetTokens);
    // Consecutive pieces share whole sentences (overlap), and every sentence is somewhere.
    const orders = p.map((x) => x.sentences.map((s) => s.order));
    expect(orders[1]![0]).toBeLessThan(orders[0]!.at(-1)! + 1);
    expect(new Set(orders.flat()).size).toBe(30);
    expect(p[0]!.coordinates).toHaveLength(orders[0]!.length);
    expect(p.every((x) => x.blockKeys[0] === 'b0')).toBe(true);
  });

  it('keeps formulas and captions as their own passages and references separate', () => {
    const d = doc(
      [
        { plainText: words(20) },
        { type: 'display_formula', plainText: 'dρ/dt = -i[H, ρ] (1)' },
        { plainText: words(20) },
        { type: 'figure_caption', plainText: 'Fig. 1. Wigner function.' },
        { type: 'abstract', sectionKey: 's1', plainText: 'We study bosonic codes.' },
        { type: 'reference', sectionKey: 's2', plainText: 'P. W. Shor, Phys. Rev. A 52 (1995).' },
        { type: 'reference', sectionKey: 's2', plainText: 'A. Vaswani, arXiv:1706.03762.' },
        { type: 'heading', plainText: 'Not a passage' },
      ],
      [{}, { type: 'abstract', path: 'Abstract' }, { type: 'references', path: 'References' }],
    );
    const p = segmentDocument(d, 'sha');
    expect(p.map((x) => x.kind)).toEqual(['body', 'formula', 'body', 'caption', 'abstract', 'reference', 'reference']);
    expect(p[1]!.text).toBe('dρ/dt = -i[H, ρ] (1)');
    expect(p[1]!.normalizedText).toContain('ρ');
  });

  it('gives stable keys across runs and distinct keys to repeated text', () => {
    const d = doc([{ plainText: 'Same text.' }, { type: 'display_formula', plainText: 'x' }, { plainText: 'Same text.' }], [{}]);
    const a = segmentDocument(d, 'sha');
    const b = segmentDocument(d, 'sha');
    expect(a.map((x) => x.stableKey)).toEqual(b.map((x) => x.stableKey));
    expect(a[0]!.textHash).toBe(a[2]!.textHash);
    expect(a[0]!.stableKey).not.toBe(a[2]!.stableKey);
    expect(segmentDocument(d, 'other-pdf')[0]!.stableKey).not.toBe(a[0]!.stableKey);
  });

  it('keeps footnotes apart from the body and refuses inconsistent settings', () => {
    const d = doc([{ plainText: words(10) }, { type: 'footnote', plainText: 'A note.' }, { plainText: words(10) }], [{}]);
    expect(segmentDocument(d, 'sha').map((x) => x.blockKeys)).toEqual([['b0'], ['b1'], ['b2']]);
    expect(() => segmentDocument(d, 'sha', { targetTokens: 800, maxTokens: 700, overlapTokens: 10 })).toThrow(RangeError);
  });

  it('prefixes the section path to the embedding input', () => {
    expect(embeddingInput({ sectionPath: '2 Methods', text: 'Body' })).toBe('2 Methods\nBody');
    expect(embeddingInput({ sectionPath: '', text: 'Body' })).toBe('Body');
  });
});
