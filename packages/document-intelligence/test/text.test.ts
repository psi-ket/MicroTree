import { describe, expect, it } from 'vitest';
import {
  classifySection,
  cleanText,
  estimateTokens,
  findArxivId,
  findDoi,
  levelFromNumber,
  normalizeSearchText,
  segmentSentences,
  splitHeadingNumber,
  stableStringify,
  staleReasons,
} from '../src';

describe('sentence segmentation', () => {
  it('splits ordinary sentences and keeps their offsets', () => {
    const text = 'Bosonic codes protect information. They use oscillators! Do they scale? Yes.';
    const s = segmentSentences(text);
    expect(s.map((x) => x.text)).toEqual(['Bosonic codes protect information.', 'They use oscillators!', 'Do they scale?', 'Yes.']);
    for (const x of s) expect(text.slice(x.start, x.end)).toBe(x.text);
  });

  it('does not split after abbreviations, initials, decimals or identifiers', () => {
    const text =
      'As shown by Shor et al. in Fig. 2 and Eq. 3, the rate is 0.5 per cycle. J. Preskill discussed this, i.e. the threshold, see arXiv:1706.03762 for details. A new sentence starts here.';
    expect(segmentSentences(text).map((x) => x.text)).toEqual([
      'As shown by Shor et al. in Fig. 2 and Eq. 3, the rate is 0.5 per cycle.',
      'J. Preskill discussed this, i.e. the threshold, see arXiv:1706.03762 for details.',
      'A new sentence starts here.',
    ]);
  });

  it('keeps a trailing citation with its sentence and handles Greek capitals', () => {
    const s = segmentSentences('The Lindblad equation is standard [12]. Ω denotes the drive. (A) holds.');
    expect(s.map((x) => x.text)).toEqual(['The Lindblad equation is standard [12].', 'Ω denotes the drive.', '(A) holds.']);
  });

  it('returns nothing for empty text and one span without punctuation', () => {
    expect(segmentSentences('   ')).toEqual([]);
    expect(segmentSentences('tensor networks')).toHaveLength(1);
  });
});

describe('search text', () => {
  it('folds compatibility forms but keeps Greek, subscripts and hyphens', () => {
    expect(normalizeSearchText('The ﬁdelity of H_2 at ψ² – qubit‑level')).toBe('the fidelity of h_2 at ψ2 - qubit-level');
  });

  it('repairs line-break hyphenation and invisible characters only', () => {
    expect(cleanText('entan-\nglement of­ two​ modes')).toBe('entanglement of two modes');
    expect(cleanText('Majorana-\nZero')).toBe('Majorana- Zero');
  });

  it('estimates tokens conservatively', () => {
    expect(estimateTokens('quantum error correction')).toBe(4);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('ρ(t) = e^{-iHt}')).toBeGreaterThan(5);
  });
});

describe('sections and identifiers', () => {
  it('splits printed numbers and classifies headings', () => {
    expect(splitHeadingNumber('2.1 Numerical methods')).toEqual({ number: '2.1', text: 'Numerical methods' });
    expect(splitHeadingNumber('IV. RESULTS')).toEqual({ number: 'IV', text: 'RESULTS' });
    expect(levelFromNumber('2.1.3')).toBe(3);
    expect(classifySection('1 Introduction')).toBe('introduction');
    expect(classifySection('IV. RESULTS')).toBe('results');
    expect(classifySection('Acknowledgments')).toBe('acknowledgement');
    expect(classifySection('Appendix A: Proof of Lemma 2')).toBe('appendix');
    expect(classifySection('Stabilizer formalism')).toBe('body');
    expect(classifySection('Stabilizer formalism', 'appendix')).toBe('appendix');
  });

  it('finds DOIs and arXiv identifiers in reference strings', () => {
    expect(findDoi('Phys. Rev. A 52, R2493 (1995), doi:10.1103/PhysRevA.52.R2493.')).toBe('10.1103/physreva.52.r2493');
    expect(findArxivId('preprint arXiv:1706.03762v5')).toBe('1706.03762');
    expect(findArxivId('see arXiv:quant-ph/9512032')).toBe('quant-ph/9512032');
    expect(findDoi('no identifier here')).toBeNull();
  });
});

describe('versioning', () => {
  it('hashes configurations independently of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: null } })).toBe(stableStringify({ a: { c: null, d: [1, 2] }, b: 1 }));
  });

  it('reports why an extraction is stale', () => {
    const existing = { sourceSha256: 'a', extractor: 'grobid', extractorVersion: '0.8.1', parserVersion: '1.0.0', configHash: 'x' };
    expect(staleReasons(existing, { ...existing })).toEqual([]);
    expect(staleReasons(existing, { extractorVersion: '0.9.0', configHash: 'y' })).toEqual(['extractor-version-changed', 'config-changed']);
    expect(staleReasons(existing, { extractorVersion: null })).toEqual([]);
  });
});
