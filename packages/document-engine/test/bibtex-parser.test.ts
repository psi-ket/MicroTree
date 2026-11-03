import { describe, expect, it } from 'vitest';
import { latexToUnicode, parseBibName, parseBibtex, splitBibNames } from '../src/bibtex-parser';

const field = (entry: { fields: { name: string; value: string }[] } | undefined, name: string) =>
  entry?.fields.find((f) => f.name === name)?.value;

describe('parseBibtex', () => {
  it('reads common entry types with braced, quoted and numeric values', () => {
    const { entries, errors } = parseBibtex(`
@Article{shor1995scheme,
  author  = {Shor, Peter W.},
  title   = "Scheme for reducing decoherence in quantum computer memory",
  journal = {Physical Review A},
  year    = 1995,
  volume  = {52},
  pages   = {R2493--R2496},
}
@inproceedings{fowler2012,
  title = {Surface codes},
  booktitle = {Proc. QEC}
}
@misc{nofields}
`);
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.type, e.key])).toEqual([
      ['article', 'shor1995scheme'],
      ['inproceedings', 'fowler2012'],
      ['misc', 'nofields'],
    ]);
    const shor = entries[0]!;
    expect(field(shor, 'title')).toBe('Scheme for reducing decoherence in quantum computer memory');
    expect(shor.fields.find((f) => f.name === 'year')).toMatchObject({ value: '1995', raw: '1995', bare: true });
    expect(field(shor, 'pages')).toBe('R2493--R2496');
    expect(shor.line).toBe(2);
  });

  it('expands @string definitions, concatenation and month macros', () => {
    const { entries, strings, errors } = parseBibtex(`
@string{pra = "Physical Review A"}
@STRING(aps = {American Physical Society})
@article{k1, journal = pra, publisher = aps # " (" # "APS" # ")", month = jan, note = "Vol. " # 52}
`);
    expect(errors).toEqual([]);
    expect(strings).toEqual({ pra: 'Physical Review A', aps: 'American Physical Society' });
    const e = entries[0]!;
    expect(field(e, 'journal')).toBe('Physical Review A');
    expect(field(e, 'publisher')).toBe('American Physical Society (APS)');
    expect(e.fields.find((f) => f.name === 'month')).toMatchObject({ value: 'January', raw: 'jan', bare: true });
    expect(field(e, 'note')).toBe('Vol. 52');
    expect(e.fields.find((f) => f.name === 'publisher')!.bare).toBe(false);
  });

  it('skips comments, @comment and @preamble, and free text between entries', () => {
    const { entries, preambles, errors } = parseBibtex(`
This line is a comment, as is anything outside an entry. Contact: me@example.org
% percent comment
@comment{ @article{fake, title = {not an entry}} }
@preamble{ "\\newcommand{\\noop}[1]{}" }
@article{real, title = {Real}}
`);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.key)).toEqual(['real']);
    expect(preambles).toEqual(['\\newcommand{\\noop}[1]{}']);
  });

  it('keeps nested braces and escaped characters inside values', () => {
    const { entries } = parseBibtex(String.raw`@article{k, title = {The {LaTeX} \{Companion\} and {\"{O}}sterreich {{Nested {deeply}}}}, note = "A \"quoted\" {brace}"}`);
    expect(field(entries[0], 'title')).toBe(String.raw`The {LaTeX} \{Companion\} and {\"{O}}sterreich {{Nested {deeply}}}`);
    expect(field(entries[0], 'note')).toBe(String.raw`A \"quoted\" {brace}`);
  });

  it('reads entries delimited by parentheses and allows a trailing comma', () => {
    const { entries, errors } = parseBibtex('@book(knuth, title = {The TeXbook}, year = 1984,)');
    expect(errors).toEqual([]);
    expect(entries[0]).toMatchObject({ type: 'book', key: 'knuth' });
    expect(field(entries[0], 'year')).toBe('1984');
  });

  it('reports malformed entries with line numbers and keeps the valid ones', () => {
    const { entries, errors } = parseBibtex(`@article{good1, title = {One}}
@article{broken, title = {Missing brace, year = 2020
@article{good2, title = {Two}}
@article{nokey title = {x}}
@article{badvalue, title = }
@article{undef, journal = nosuchmacro}
@article{good3, title = {Three}}
`);
    expect(entries.map((e) => e.key)).toEqual(['good1', 'good2', 'good3']);
    expect(errors.map((e) => e.line)).toEqual([2, 4, 5, 6]);
    expect(errors[0]!.message).toMatch(/Missing "}"/);
    expect(errors[1]!.message).toMatch(/Expected "=" after field "x"|Expected "," or "}"/);
    expect(errors[2]!.message).toMatch(/where a value was expected/);
    expect(errors[3]!.message).toMatch(/Undefined @string "nosuchmacro"/);
  });

  it('reports a field given twice and keeps the first', () => {
    const { entries, errors } = parseBibtex('@article{k,\n title = {First},\n title = {Second}\n}');
    expect(field(entries[0], 'title')).toBe('First');
    expect(errors).toEqual([{ line: 3, message: 'Field "title" appears twice in entry "k"; the first is kept' }]);
  });

  it('returns offsets that cover each entry exactly, and where fields end', () => {
    const text = 'preamble text\n@article{k, title = {T}, year = 2020 }\ntrailer';
    const e = parseBibtex(text).entries[0]!;
    expect(text.slice(e.start, e.end)).toBe('@article{k, title = {T}, year = 2020 }');
    expect(text.slice(e.start, e.fieldsEnd)).toBe('@article{k, title = {T}, year = 2020');
  });

  it('reads Unicode values as they are', () => {
    const { entries } = parseBibtex('@article{k, author = {Gödel, Kurt and Šimon, Petr}, title = {Über formal unentscheidbare Sätze — 量子}}');
    expect(field(entries[0], 'author')).toBe('Gödel, Kurt and Šimon, Petr');
    expect(field(entries[0], 'title')).toBe('Über formal unentscheidbare Sätze — 量子');
  });
});

describe('latexToUnicode', () => {
  it('turns accents, special letters and escapes into Unicode', () => {
    expect(latexToUnicode(String.raw`{\"O}sterreich, Erd\H{o}s, Schr{\"o}dinger, \'{E}cole, \c{c}a, \v{S}imon, Ma\~{n}ana`)).toBe(
      'Österreich, Erdős, Schrödinger, École, ça, Šimon, Mañana',
    );
    expect(latexToUnicode(String.raw`Stra{\ss}e, {\o}stergaard, \AA{}ngstr\"{o}m, Na\"{\i}ve, \l{}ukasz`)).toBe(
      'Straße, østergaard, Ångström, Naïve, łukasz',
    );
    expect(latexToUnicode(String.raw`R\&D at 50\% -- pp. 1--2 --- \emph{really} {DNA}`)).toBe('R&D at 50% – pp. 1–2 — really DNA');
    expect(latexToUnicode('A~B')).toBe('A B');
  });
});

describe('BibTeX names', () => {
  it('splits author lists on "and" outside braces', () => {
    expect(splitBibNames('Shor, Peter W. and {Barnes and Noble} and Fowler, A. G. and others')).toEqual([
      'Shor, Peter W.',
      '{Barnes and Noble}',
      'Fowler, A. G.',
      'others',
    ]);
  });

  it('reads the BibTeX name forms', () => {
    expect(parseBibName('Shor, Peter W.')).toEqual({ givenName: 'Peter W.', familyName: 'Shor', name: 'Peter W. Shor' });
    expect(parseBibName('Peter W. Shor')).toEqual({ givenName: 'Peter W.', familyName: 'Shor', name: 'Peter W. Shor' });
    expect(parseBibName('Ludwig van Beethoven')).toEqual({ givenName: 'Ludwig', familyName: 'van Beethoven', name: 'Ludwig van Beethoven' });
    expect(parseBibName('King, Jr, Martin Luther')).toMatchObject({ givenName: 'Martin Luther', familyName: 'King, Jr' });
    expect(parseBibName('{IBM Quantum}')).toEqual({ givenName: null, familyName: null, name: 'IBM Quantum' });
    expect(parseBibName('Schr{\\"o}dinger, Erwin')).toMatchObject({ familyName: 'Schrödinger' });
    expect(parseBibName('Aristotle')).toEqual({ givenName: null, familyName: 'Aristotle', name: 'Aristotle' });
  });
});
