import { describe, expect, it } from 'vitest';
import type { PageGeometry } from '@research-studio/document-intelligence';
import { DEFAULT_PROCESSING_LIMITS, ExtractionError, normalizeTei, parseTei, parseXmlSecure } from '../src';
import { HEADER_ONLY_TEI, SAMPLE_TEI } from './fixtures/tei';

const xmlLimits = { maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 100_000 };
const limits = { maxBlocks: 1000, maxReferences: 1000, maxElements: 1000 };

describe('secure XML reader', () => {
  it('refuses external entities and DTDs (XXE)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE TEI [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><TEI>&xxe;</TEI>`;
    expect(() => parseXmlSecure(xxe, xmlLimits)).toThrow(/document type declaration/);
    const bomb = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><TEI>&lol2;</TEI>`;
    expect(() => parseXmlSecure(bomb, xmlLimits)).toThrow(ExtractionError);
    expect(() => parseXmlSecure('<TEI>&unknown;</TEI>', xmlLimits)).toThrow(/unknown entity/);
    expect(() => parseXmlSecure('<TEI><!ELEMENT x ANY></TEI>', xmlLimits)).toThrow();
  });

  it('enforces depth, node and size limits', () => {
    const deep = `${'<a>'.repeat(70)}${'</a>'.repeat(70)}`;
    expect(() => parseXmlSecure(deep, xmlLimits)).toThrow(/nested too deeply/);
    const wide = `<r>${'<a/>'.repeat(200)}</r>`;
    expect(() => parseXmlSecure(wide, { ...xmlLimits, maxNodes: 100 })).toThrow(/too many elements/);
    expect(() => parseXmlSecure(`<r>${'x'.repeat(2000)}</r>`, { ...xmlLimits, maxBytes: 1000 })).toThrow(/larger than the limit/);
  });

  it('rejects malformed documents and keeps mixed content and character references', () => {
    expect(() => parseXmlSecure('<a><b></a>', xmlLimits)).toThrow(/mismatched/);
    expect(() => parseXmlSecure('<a>', xmlLimits)).toThrow(/unclosed/);
    expect(() => parseXmlSecure('<a/><b/>', xmlLimits)).toThrow(/more than one root/);
    const node = parseXmlSecure('<p>x &lt; y <ref n="1">[1]</ref> &#968; &#x3A9;<![CDATA[<raw>]]></p>', xmlLimits);
    expect(node.children).toEqual(['x < y ', { name: 'ref', attributes: { n: '1' }, children: ['[1]'] }, ' ψ Ω', '<raw>']);
  });
});

describe('TEI parsing and normalisation', () => {
  const tei = parseTei(SAMPLE_TEI, xmlLimits);

  it('reads the header: title, authors, affiliations, date, identifiers, keywords, abstract', () => {
    expect(tei.title).toBe('Bosonic Codes and the Lindblad Master Equation');
    expect(tei.authors).toHaveLength(2);
    expect(tei.authors[0]).toMatchObject({ forenames: ['Ada', 'Q'], surname: 'Example', email: 'ada@example.org', affiliations: ['Department of Physics, Example University, Nowhere'] });
    expect(tei.date).toBe('2024-03-15');
    expect(tei.doi).toBe('10.1234/jsp.2024.001');
    expect(tei.arxivId).toBe('2403.01234');
    expect(tei.keywords).toEqual(['quantum error correction', 'bosonic codes']);
    expect(tei.venue).toBe('Journal of Synthetic Physics');
    expect(tei.grobidVersion).toBe('0.8.2');
    expect(tei.surfaces).toEqual([
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 612, height: 792 },
    ]);
  });

  it('builds the section hierarchy from heading numbers', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits });
    const sections = doc.sections.map((s) => [s.path, s.type, s.level]);
    expect(sections).toEqual([
      ['Abstract', 'abstract', 1],
      ['1 Introduction', 'introduction', 1],
      ['2 Model', 'background', 1],
      ['2 Model › 2.1 Cat codes', 'background', 2],
      ['3 Results', 'results', 1],
      ['Acknowledgements', 'acknowledgement', 1],
      ['A Appendix A: Derivation', 'appendix', 1],
      ['References', 'references', 1],
    ]);
    expect(doc.sections[3]!.parentKey).toBe(doc.sections[2]!.key);
    expect(doc.extractorVersion).toBe('0.8.2');
  });

  it('keeps paragraphs, sentences with boxes, citation markers and inline formulas', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: '0.8.2', limits });
    const intro = doc.blocks.find((b) => b.type === 'paragraph' && b.plainText.startsWith('Quantum error correction'))!;
    expect(intro.sentenceSource).toBe('extractor');
    expect(intro.sentences.map((s) => s.text)).toEqual(['Quantum error correction protects fragile states [1].', 'Majorana zero modes are a different route [2].']);
    expect(intro.sentences[0]!.coordinates).toHaveLength(2); // two lines, two boxes
    expect(intro.spans).toContainEqual({ kind: 'ref', text: '[1]', refType: 'bibr', target: 'b0' });
    expect(intro.pageStart).toBe(1);
    const model = doc.blocks.find((b) => b.plainText.includes('density matrix'))!;
    expect(model.spans).toContainEqual({ kind: 'formula', text: 'ρ' });
    expect(model.plainText).toContain('H_2');
  });

  it('extracts display equations, figures and tables as elements with captions', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits });
    const eq = doc.elements.find((e) => e.type === 'equation')!;
    expect(eq).toMatchObject({ label: '(1)', content: 'dρ/dt = -i[H, ρ] + κ D[a]ρ', sourceId: 'formula_0', pageStart: 1 });
    const block = doc.blocks.find((b) => b.type === 'display_formula')!;
    expect(block.elementKey).toBe(eq.key);
    const fig = doc.elements.find((e) => e.type === 'figure')!;
    expect(fig).toMatchObject({ label: '1', caption: 'Fig. 1.. Wigner function of a cat state.', pageStart: 2 });
    const table = doc.elements.find((e) => e.type === 'table')!;
    expect(table.content).toBe('Code\tRate\ncat\t0.01');
    expect(doc.blocks.find((b) => b.type === 'table_caption')!.elementKey).toBe(table.key);
    // Captions stay in the section they followed (2.1 Cat codes).
    expect(doc.blocks.find((b) => b.type === 'figure_caption')!.sectionKey).toBe(doc.sections[3]!.key);
  });

  it('reads references with raw strings, identifiers and parsed fields', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits });
    expect(doc.references).toHaveLength(2);
    expect(doc.references[0]).toMatchObject({
      raw: 'P. W. Shor, Scheme for reducing decoherence in quantum computer memory, Phys. Rev. A 52, R2493 (1995).',
      doi: '10.1103/physreva.52.r2493',
      parsed: { title: 'Scheme for reducing decoherence in quantum computer memory', authors: ['P W Shor'], venue: 'Physical Review A', year: 1995, volume: '52', pages: '2493–2496' },
      pageStart: 2,
    });
    expect(doc.references[1]).toMatchObject({ arxivId: '1706.03762', raw: null, parsed: { year: 2017 } });
    expect(doc.blocks.filter((b) => b.type === 'reference')).toHaveLength(2);
  });

  it('removes duplicate paragraphs, keeps lists, footnotes and acknowledgements', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits });
    expect(doc.blocks.filter((b) => b.plainText.startsWith('Tensor networks'))).toHaveLength(1);
    expect(doc.warnings).toContain('1 repeated blocks were removed.');
    expect(doc.blocks.find((b) => b.type === 'list')!.plainText).toBe('• first finding\n• second finding');
    expect(doc.blocks.find((b) => b.type === 'footnote')!.plainText).toBe('A footnote about topological phases.');
    expect(doc.blocks.find((b) => b.type === 'acknowledgement')!.plainText).toBe('We thank the synthetic funding agency.');
  });

  it('segments sentences itself where GROBID did not, without inventing boxes', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits });
    const appendix = doc.blocks.find((b) => b.plainText.startsWith('The derivation'))!;
    expect(appendix.sentenceSource).toBe('segmenter');
    expect(appendix.sentences[0]!.coordinates).toEqual([]);
  });

  it('uses PyMuPDF geometry when it is known and warns about mismatched frames', () => {
    const rotated: PageGeometry[] = [
      { pageNumber: 1, width: 792, height: 612, rotation: 90, mediaBox: [0, 0, 792, 612], cropBox: [0, 0, 792, 612] },
      { pageNumber: 2, width: 612, height: 792, rotation: 0, mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792] },
    ];
    const doc = normalizeTei(tei, { pages: rotated, extractorVersion: null, limits });
    expect(doc.pages).toBe(rotated);
    expect(doc.warnings.some((w) => w.includes('rotated'))).toBe(true);
  });

  it('marks missing structures instead of inventing them', () => {
    const doc = normalizeTei(parseTei(HEADER_ONLY_TEI, xmlLimits), { pages: [], extractorVersion: null, limits });
    expect(doc.metadata.abstract).toBeNull();
    expect(doc.references).toEqual([]);
    expect(doc.warnings).toContain('No abstract was found.');
    expect(doc.blocks.map((b) => b.type)).toEqual(['title']);
  });

  it('refuses XML that is not TEI', () => {
    expect(() => parseTei('<html><body/></html>', xmlLimits)).toThrow(/not <TEI>/);
  });

  it('applies the structure limits', () => {
    const doc = normalizeTei(tei, { pages: [], extractorVersion: null, limits: { maxBlocks: 3, maxReferences: 1, maxElements: 1 } });
    expect(doc.blocks.length).toBeLessThanOrEqual(3);
    expect(doc.warnings.some((w) => w.includes('processing limits'))).toBe(true);
    expect(DEFAULT_PROCESSING_LIMITS.maxPages).toBe(500);
  });
});
