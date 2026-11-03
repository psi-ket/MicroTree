import { describe, expect, it } from 'vitest';
import { familyKey, nameTokens, normalizeAuthor } from '../src/normalization/author-normalizer';
import { compareDates, fromDateParts, normalizeDate, normalizeYear, yearOf } from '../src/normalization/date-normalizer';
import {
  arxivDoi,
  normalizeDoi,
  normalizeIssn,
  normalizeOpenAlexId,
  normalizeOrcid,
  normalizePmid,
  normalizeSemanticScholarId,
  parseArxivId,
} from '../src/normalization/identifier-normalizer';
import { cleanText, contentTokens, decodeEntities, safeUrl, stripMarkup, titleKey } from '../src/normalization/work-normalizer';

describe('normalizeDoi', () => {
  const cases: [string, string | null][] = [
    ['10.1103/PhysRevA.52.R2493', '10.1103/physreva.52.r2493'],
    ['https://doi.org/10.1103/PhysRevA.52.R2493', '10.1103/physreva.52.r2493'],
    ['http://dx.doi.org/10.1103/PhysRevA.52.R2493', '10.1103/physreva.52.r2493'],
    ['doi: 10.1038/nature14539', '10.1038/nature14539'],
    ['info:doi/10.1038/nature14539', '10.1038/nature14539'],
    ['<10.1038/nature14539>', '10.1038/nature14539'],
    ['10.1038/nature14539.', '10.1038/nature14539'],
    ['(see 10.1038/nature14539)', null],
    ['10.1002/(SICI)1097-4636(199706)35:4<419::AID-JBM1>3.0.CO;2-K', '10.1002/(sici)1097-4636(199706)35:4<419::aid-jbm1>3.0.co;2-k'],
    ['10.1016/s0140-6736(20)30183-5)', '10.1016/s0140-6736(20)30183-5'],
    ['https://doi.org/10.1000%2Fxyz%20abc', '10.1000/xyzabc'],
    ['10.123/too-short-prefix', null],
    ['not a doi', null],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${String(expected)}`, () => expect(normalizeDoi(input)).toBe(expected));
  }
});

describe('parseArxivId', () => {
  const cases: [string, { id: string; version: string | null } | null][] = [
    ['1706.03762', { id: '1706.03762', version: null }],
    ['arXiv:1706.03762v5', { id: '1706.03762', version: 'v5' }],
    ['https://arxiv.org/abs/2610.40567v2', { id: '2610.40567', version: 'v2' }],
    ['https://arxiv.org/pdf/1706.03762v1.pdf', { id: '1706.03762', version: 'v1' }],
    ['https://export.arxiv.org/abs/quant-ph/9605011', { id: 'quant-ph/9605011', version: null }],
    ['quant-ph/9605011v2', { id: 'quant-ph/9605011', version: 'v2' }],
    ['math.GT/0309136', { id: 'math/0309136', version: null }],
    ['10.48550/arXiv.1706.03762', { id: '1706.03762', version: null }],
    ['https://doi.org/10.48550/arXiv.2106.15928', { id: '2106.15928', version: null }],
    // Five digits only from 2015, four only before; month must exist; new style starts 0704.
    ['1412.12345', null],
    ['1501.1234', null],
    ['1713.01234', null],
    ['0612.1234', null],
    ['madeup-ph/9605011', null],
    ['10.1103/physreva.52.r2493', null],
    ['W2741809807', null],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${JSON.stringify(expected)}`, () => expect(parseArxivId(input)).toEqual(expected));
  }

  it('builds the arXiv DataCite DOI', () => {
    expect(arxivDoi('1706.03762')).toBe('10.48550/arxiv.1706.03762');
    expect(parseArxivId(arxivDoi('quant-ph/9605011'))).toEqual({ id: 'quant-ph/9605011', version: null });
  });
});

describe('other identifiers', () => {
  it('normalises OpenAlex IDs by kind', () => {
    expect(normalizeOpenAlexId('https://openalex.org/W1999706070')).toBe('W1999706070');
    expect(normalizeOpenAlexId('openalex:w1999706070')).toBe('W1999706070');
    expect(normalizeOpenAlexId('https://api.openalex.org/authors/A5020744800', 'A')).toBe('A5020744800');
    expect(normalizeOpenAlexId('A5020744800')).toBeNull();
    expect(normalizeOpenAlexId('W12x')).toBeNull();
  });

  it('accepts only 40-hex Semantic Scholar paper IDs', () => {
    const id = '067b1059f443e53276d39fc6eddbf273cc103531';
    expect(normalizeSemanticScholarId(id.toUpperCase())).toBe(id);
    expect(normalizeSemanticScholarId(`https://www.semanticscholar.org/paper/Some-Title/${id}`)).toBe(id);
    expect(normalizeSemanticScholarId('1756931')).toBeNull();
  });

  it('verifies ORCID and ISSN checksums', () => {
    expect(normalizeOrcid('https://orcid.org/0000-0003-4626-5648')).toBe('0000-0003-4626-5648');
    expect(normalizeOrcid('0000-0002-1694-233X')).toBe('0000-0002-1694-233X');
    expect(normalizeOrcid('0000-0003-4626-5649')).toBeNull();
    expect(normalizeIssn('10502947')).toBe('1050-2947');
    expect(normalizeIssn('1050-2948')).toBeNull();
    expect(normalizeIssn('2434-561x')).toBe('2434-561X');
  });

  it('reads PubMed IDs', () => {
    expect(normalizePmid('https://pubmed.ncbi.nlm.nih.gov/9912632/')).toBe('9912632');
    expect(normalizePmid('PMID9912632')).toBeNull();
  });
});

describe('dates', () => {
  it('keeps the precision the source gave', () => {
    expect(fromDateParts([[1995, 10, 1]])).toBe('1995-10-01');
    expect(fromDateParts([[1995, 10]])).toBe('1995-10');
    expect(fromDateParts([[1995]])).toBe('1995');
    expect(fromDateParts([[null]])).toBeNull();
    expect(fromDateParts([['1995', '2']])).toBe('1995-02');
    expect(normalizeDate('2017-06-12T17:57:34Z')).toBe('2017-06-12');
    // An impossible month or day keeps only the part that is valid.
    expect(normalizeDate('2017-13-01')).toBe('2017');
    expect(normalizeDate('2017-02-30')).toBe('2017');
    expect(normalizeDate('nonsense')).toBeNull();
  });

  it('reads years only in a plausible range', () => {
    expect(yearOf('1995-10-01')).toBe(1995);
    expect(normalizeYear(2017)).toBe(2017);
    expect(normalizeYear('2017')).toBe(2017);
    expect(normalizeYear(17)).toBeNull();
    expect(normalizeYear(99999)).toBeNull();
  });

  it('compares dates of mixed precision', () => {
    expect(compareDates('1995-10-01', '1995-11')).toBeLessThan(0);
    expect(compareDates('2017', '2016-12-31')).toBeGreaterThan(0);
    expect(compareDates('1995-10', '1995-10')).toBe(0);
  });
});

describe('text', () => {
  it('decodes entities and strips JATS markup', () => {
    expect(decodeEntities('AT&amp;T &lt;b&gt; &#x3B1; &#946;')).toBe('AT&T <b> α β');
    // The JATS section heading ("Abstract") is dropped with its element.
    expect(stripMarkup('<jats:title>Abstract</jats:title><jats:p>We show <jats:italic>x</jats:italic> &amp; y.</jats:p>')).toBe('We show x & y.');
    expect(stripMarkup('  ')).toBeNull();
    expect(cleanText('  a \n  b ')).toBe('a b');
  });

  it('builds comparison keys and content tokens', () => {
    expect(titleKey('Scheme for reducing decoherence in quantum computer memory.')).toBe('scheme for reducing decoherence in quantum computer memory');
    expect(titleKey('Équations de Navier–Stokes')).toBe(titleKey('Equations de Navier-Stokes'));
    expect(contentTokens('A review of the surface code')).toEqual(['review', 'surface', 'code']);
  });

  it('accepts only http(s) URLs', () => {
    expect(safeUrl('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/abs/1706.03762');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});

describe('authors', () => {
  it('never splits a display name itself', () => {
    expect(normalizeAuthor({ name: 'Peter W. Shor' })).toMatchObject({ name: 'Peter W. Shor', givenName: null, familyName: null });
    expect(normalizeAuthor({ given: 'Peter W.', family: 'Shor' })).toMatchObject({ name: 'Peter W. Shor', givenName: 'Peter W.', familyName: 'Shor' });
    expect(normalizeAuthor({ name: '  ' })).toBeNull();
  });

  it('keeps only valid ORCIDs and distinct affiliations', () => {
    const a = normalizeAuthor({ name: 'A. Person', orcid: 'https://orcid.org/0000-0003-4626-5648', affiliations: ['MIT', 'MIT', null] });
    expect(a?.orcid).toBe('0000-0003-4626-5648');
    expect(a?.affiliations).toEqual(['MIT']);
    expect(normalizeAuthor({ name: 'B', orcid: '0000-0000-0000-0000X' })?.orcid).toBeNull();
  });

  it('derives family keys for matching only', () => {
    expect(familyKey({ name: 'Peter W. Shor', familyName: null })).toBe('shor');
    expect(familyKey({ name: 'P. Shor', familyName: null })).toBe('shor');
    // Particles stay part of the key, the same way from a split or an unsplit name.
    expect(familyKey({ name: 'Ludwig van Beethoven', familyName: 'van Beethoven' })).toBe('vanbeethoven');
    expect(familyKey({ name: 'Ludwig van Beethoven', familyName: null })).toBe('vanbeethoven');
    expect(familyKey({ name: 'Shor, Peter W.', familyName: null })).toBe('shor');
    expect(familyKey({ name: 'Martin Luther King Jr.', familyName: null })).toBe('king');
    expect(nameTokens({ name: 'Peter W. Shor' })).toEqual(['peter', 'shor']);
  });
});
