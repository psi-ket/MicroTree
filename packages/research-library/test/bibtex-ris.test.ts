import { parseBibtex } from '@research-studio/document-engine';
import { describe, expect, it } from 'vitest';
import { exportBibtex, itemToBibtex } from '../src/exports/bibtex-exporter';
import { exportRis } from '../src/exports/ris-exporter';
import { importBibtex } from '../src/imports/bibtex-importer';
import { importRis } from '../src/imports/ris-importer';
import { generateCitationKey, uniqueCitationKey, validateCitationKey, validateKeyTemplate } from '../src/library/citation-keys';
import { workFromReference } from '../src/metadata/metadata-merger';

const NOW = '2026-11-03T10:00:00.000Z';

// Test data only: the 10.5555 prefix is reserved for examples.
const BIB = String.raw`
% A file exported from another reference manager.
@string{pra = {Physical Review A}}

@Article{shor1995scheme,
  author    = {Shor, Peter W.},
  title     = {Scheme for reducing decoherence in quantum computer memory},
  journal   = pra,
  year      = 1995,
  month     = oct,
  volume    = {52},
  number    = {4},
  pages     = {R2493--R2496},
  doi       = {10.1103/PhysRevA.52.R2493},
  file      = {:papers/shor1995.pdf:PDF},
  groups    = {QEC},
  mynote    = {Read {twice}},
}

@misc{vaswani2017attention,
  title         = {Attention Is All You Need},
  author        = {Vaswani, Ashish and Shazeer, Noam and others},
  year          = {2017},
  eprint        = {1706.03762},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
}

@phdthesis{example2020,
  author = {M{\"u}ller, J{\"o}rg and {The Example Consortium}},
  title  = {{Bosonic} codes in {\"O}sterreich},
  school = {Universit{\"a}t Wien},
  date   = {2020-03-15},
  doi    = {10.5555/example.thesis},
  url    = {https://example.org/thesis},
}

@article{broken, title = {Missing brace, year = 2020

@book{knuth1984, title = {The {\TeX}book}, author = {Donald E. Knuth}, publisher = {Addison-Wesley}, year = 1984}
`;

describe('BibTeX import', () => {
  const { references, warnings } = importBibtex(BIB);

  it('reads every valid entry and reports the broken one with its line', () => {
    expect(references.map((r) => r.citationKey)).toEqual(['shor1995scheme', 'vaswani2017attention', 'example2020', 'knuth1984']);
    expect(warnings).toHaveLength(1);
    const brokenLine = BIB.split('\n').findIndex((l) => l.startsWith('@article{broken')) + 1;
    expect(warnings[0]!.line).toBe(brokenLine);
    expect(warnings[0]!.message).toMatch(/Missing "}"/);
  });

  it('maps known fields and expands @string macros', () => {
    const shor = references[0]!;
    expect(shor).toMatchObject({
      origin: 'bibtex',
      bibtexType: 'article',
      title: 'Scheme for reducing decoherence in quantum computer memory',
      authors: [{ familyName: 'Shor', givenName: 'Peter W.', name: null }],
      publicationYear: 1995,
      publicationDate: '1995-10',
      venue: 'Physical Review A',
      volume: '52',
      issue: '4',
      pages: 'R2493–R2496',
      doi: '10.1103/physreva.52.r2493',
      publicationType: 'journal-article',
    });
  });

  it('keeps unknown and unmapped fields verbatim, including macros', () => {
    expect(references[0]!.extraFields).toEqual([
      { name: 'month', value: 'oct', bare: true },
      { name: 'file', value: ':papers/shor1995.pdf:PDF' },
      { name: 'groups', value: 'QEC' },
      { name: 'mynote', value: 'Read {twice}' },
    ]);
  });

  it('recognises arXiv e-prints and drops "others" from the author list', () => {
    const v = references[1]!;
    expect(v).toMatchObject({ arxivId: '1706.03762', publicationType: 'preprint', publicationYear: 2017 });
    expect(v.authors.map((a) => a.familyName)).toEqual(['Vaswani', 'Shazeer']);
    expect(v.extraFields).toEqual([{ name: 'primaryclass', value: 'cs.CL' }]);
  });

  it('decodes LaTeX to Unicode, keeps organisations whole, and reads biblatex dates', () => {
    const t = references[2]!;
    expect(t.title).toBe('Bosonic codes in Österreich');
    expect(t.authors).toEqual([
      { familyName: 'Müller', givenName: 'Jörg', name: null },
      { givenName: null, familyName: null, name: 'The Example Consortium' },
    ]);
    expect(t).toMatchObject({ publisher: 'Universität Wien', publicationDate: '2020-03-15', publicationYear: 2020, publicationType: 'dissertation' });
    // With a DOI, export writes no url, so the url is kept verbatim.
    expect(t.extraFields).toEqual([
      { name: 'date', value: '2020-03-15' },
      { name: 'url', value: 'https://example.org/thesis' },
    ]);
  });

  it('warns about a key used twice and imports both entries', () => {
    const { references: refs, warnings: w } = importBibtex('@misc{a, title={One}}\n@misc{A, title={Two}}');
    expect(refs).toHaveLength(2);
    expect(w[0]!.message).toMatch(/Key "A" is used again \(first on line 1\)/);
  });
});

describe('BibTeX export', () => {
  const { references } = importBibtex(BIB);
  const item = (i: number) => {
    const ref = references[i]!;
    return { work: workFromReference(ref, `w${i}`, NOW), citationKey: ref.citationKey!, bibtexType: ref.bibtexType, bibtexExtra: ref.extraFields };
  };

  it('writes valid BibTeX that reads back to the same metadata and extra fields', () => {
    const text = exportBibtex([item(0), item(1), item(2), item(3)]);
    const parsed = parseBibtex(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map((e) => [e.type, e.key])).toEqual([
      ['article', 'shor1995scheme'],
      ['misc', 'vaswani2017attention'],
      ['phdthesis', 'example2020'],
      ['book', 'knuth1984'],
    ]);
    const reimported = importBibtex(text).references;
    for (const [i, r] of reimported.entries()) {
      const original = references[i]!;
      expect(r.title).toBe(original.title);
      expect(r.authors).toEqual(original.authors);
      expect(r.doi).toBe(original.doi);
      expect(r.arxivId).toBe(original.arxivId);
      expect(r.venue).toBe(original.venue);
      expect(r.extraFields).toEqual(original.extraFields);
    }
  });

  it('writes month macros bare and keeps the original entry type', () => {
    const text = itemToBibtex(item(0));
    expect(text).toMatch(/month\s+= oct,/);
    expect(text).toMatch(/journal\s+= \{Physical Review A\}/);
    expect(text).toMatch(/pages\s+= \{R2493--R2496\}/);
    expect(itemToBibtex(item(2))).toMatch(/school\s+= \{Universität Wien\}/);
  });

  it('moves the venue to the field the chosen entry type uses', () => {
    const base = item(0);
    const text = itemToBibtex({ ...base, bibtexType: 'inproceedings' });
    expect(text).toMatch(/booktitle\s+= \{Physical Review A\}/);
    expect(text).not.toMatch(/journal/);
  });

  it('never invents metadata: a reference with only a title exports only a title', () => {
    const { references: [only] } = importBibtex('@misc{bare, title = {Just a title}}');
    const text = itemToBibtex({ work: workFromReference(only!, 'x', NOW), citationKey: 'bare', bibtexType: 'misc', bibtexExtra: [] });
    expect(text).toBe('@misc{bare,\n  title = {Just a title}\n}\n');
  });
});

describe('RIS', () => {
  const RIS = `TY  - JOUR
ID  - shor95
AU  - Shor, Peter W.
TI  - Scheme for reducing decoherence
  in quantum computer memory
T2  - Physical Review A
PY  - 1995/10/01/
VL  - 52
IS  - 4
SP  - R2493
EP  - R2496
DO  - https://doi.org/10.1103/PhysRevA.52.R2493
KW  - quantum error correction
KW  - decoherence
N1  - Seminal.
ER  -

TY  - UNPB
AU  - Vaswani, Ashish
TI  - Attention Is All You Need
PY  - 2017
UR  - https://arxiv.org/abs/1706.03762v5
ER  -
TY  - BOOK
TI  - No end tag
`;

  it('reads records, continuation lines, repeated tags and dates', () => {
    const { references, warnings } = importRis(RIS);
    expect(references).toHaveLength(3);
    expect(references[0]).toMatchObject({
      title: 'Scheme for reducing decoherence in quantum computer memory',
      authors: [{ familyName: 'Shor', givenName: 'Peter W.', name: null }],
      publicationDate: '1995-10-01',
      publicationYear: 1995,
      venue: 'Physical Review A',
      pages: 'R2493–R2496',
      doi: '10.1103/physreva.52.r2493',
      keywords: ['quantum error correction', 'decoherence'],
      notes: 'Seminal.',
      citationKey: 'shor95',
      publicationType: 'journal-article',
      bibtexType: 'article',
    });
    expect(references[1]).toMatchObject({ arxivId: '1706.03762', publicationType: 'preprint', publicationYear: 2017 });
    expect(warnings.map((w) => w.message)).toEqual(['Record has no "ER" line at the end of the file']);
  });

  it('writes RIS that reads back', () => {
    const { references } = importRis(RIS);
    const text = exportRis(references.slice(0, 2).map((r, i) => ({ work: workFromReference(r, `r${i}`, NOW), citationKey: r.citationKey, tags: r.keywords })));
    const again = importRis(text).references;
    expect(again.map((r) => [r.title, r.doi, r.arxivId, r.publicationYear, r.pages])).toEqual([
      ['Scheme for reducing decoherence in quantum computer memory', '10.1103/physreva.52.r2493', null, 1995, 'R2493–R2496'],
      ['Attention Is All You Need', null, '1706.03762', 2017, null],
    ]);
    expect(again[0]!.keywords).toEqual(['quantum error correction', 'decoherence']);
  });
});

describe('citation keys', () => {
  const work = (title: string, families: string[], year: number | null) =>
    workFromReference(
      {
        ...importBibtex('@misc{x, title={x}}').references[0]!,
        title,
        authors: families.map((f) => ({ familyName: f, givenName: 'A.', name: null })),
        publicationYear: year,
      },
      'k',
      NOW,
    );

  it('generates keys in each format, ASCII only', () => {
    const w = work('The Quantum Information and Error Correction', ['Smith', 'Brown', 'Østergaard'], 2025);
    expect(generateCitationKey(w, 'author-year')).toBe('smith2025');
    expect(generateCitationKey(w, 'author-year-keyword')).toBe('smith2025quantum');
    expect(generateCitationKey(w, 'author-year-title')).toBe('smith2025QuantumInformationError');
    expect(generateCitationKey(w, 'custom', '{Author}:{yy}-{authors}')).toBe('Smith:25-smithBrownOstergaard');
    expect(generateCitationKey(work('Über Schrödinger', ['Gödel'], 1931), 'author-year-keyword')).toBe('godel1931uber');
  });

  it('starts from the title when there is no author, and never returns an empty key', () => {
    expect(generateCitationKey(work('Surface codes', [], 2012), 'author-year')).toBe('surface2012');
    expect(generateCitationKey(work('', [], null), 'author-year')).toBe('ref');
    // A template that already uses the title does not repeat its first word (seen in E2E as "attentionattention").
    expect(generateCitationKey(work('Attention Is All You Need', [], null), 'author-year-keyword')).toBe('attention');
    expect(generateCitationKey(work('Surface codes', [], 2012), 'author-year-keyword')).toBe('2012surface');
  });

  it('adds suffixes on collision, case-insensitively', () => {
    const taken = new Set(['smith2025', 'smith2025a']);
    expect(uniqueCitationKey('Smith2025', (k) => taken.has(k))).toBe('Smith2025b');
    expect(uniqueCitationKey('new2025', (k) => taken.has(k))).toBe('new2025');
    const all = new Set(['x', ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `x${c}`)]);
    expect(uniqueCitationKey('x', (k) => all.has(k))).toBe('xaa');
  });

  it('validates typed keys and custom templates', () => {
    expect(validateCitationKey('shor1995scheme')).toBeNull();
    expect(validateCitationKey('bad key')).toMatch(/letters, digits/);
    expect(validateCitationKey('')).toMatch(/empty/);
    expect(validateKeyTemplate('{author}{year}')).toBeNull();
    expect(validateKeyTemplate('{author}{journal}')).toMatch(/Unknown placeholder: \{journal\}/);
    expect(validateKeyTemplate('plain')).toMatch(/at least one placeholder/);
    expect(validateKeyTemplate('{author} {year}')).toMatch(/Outside placeholders/);
  });
});
