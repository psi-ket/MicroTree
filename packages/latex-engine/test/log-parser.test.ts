import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBiberLog, parseBibtexLog, parseLatexLog, parseLatexmkOutput } from '../src';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** Mimics the runtime resolver: only `./`-relative project files resolve. */
const resolve = (raw: string) => {
  const clean = raw.replace(/^\.\//, '');
  if (/^[a-zA-Z]:|^\//.test(clean) || clean.startsWith('.rs-build/')) return null;
  return clean;
};

describe('parseLatexLog (real pdfTeX logs)', () => {
  it('extracts undefined control sequences and reference warnings', () => {
    const diagnostics = parseLatexLog(fixture('undefined-control.log'), resolve);
    expect(diagnostics).toContainEqual({
      severity: 'error',
      source: 'latex',
      message: 'Undefined control sequence.',
      file: 'main.tex',
      line: 6,
      context: 'l.6 \\undefinedcmd',
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: "Reference `nope' on page 1 undefined on input line 7.",
        file: 'main.tex',
        line: 7,
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ message: "Citation `nobody' on page 1 undefined on input line 7." }),
    );
    // The thebibliography warning comes from the .bbl in the build dir, so it has no project file.
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('thebibliography'), file: null }),
    );
    // Summary noise is dropped.
    expect(diagnostics.some((d) => d.message.startsWith('There were undefined references'))).toBe(false);
  });

  it('attributes missing package errors to the emergency stop location', () => {
    const diagnostics = parseLatexLog(fixture('missing-package.log'), resolve);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: "LaTeX Error: File `doesnotexist.sty' not found.",
        file: 'main.tex',
        line: 3,
      }),
    ]);
  });

  it('handles package warnings, box warnings and LaTeX errors', () => {
    const diagnostics = parseLatexLog(fixture('mixed.log'), resolve);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: "hyperref: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 4.",
        file: 'main.tex',
        line: 4,
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'info', message: expect.stringMatching(/^Overfull \\hbox/), line: 6 }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: "LaTeX Error: Something's wrong--perhaps a missing \\item.",
        file: 'main.tex',
        line: 8,
      }),
    );
    // Duplicate hyperref warnings collapse.
    expect(diagnostics.filter((d) => d.message.startsWith('hyperref:'))).toHaveLength(1);
  });

  it('tracks nested files for warnings without a file:line prefix', () => {
    const log = [
      '(./main.tex',
      '(./chapters/one.tex',
      'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.',
      ') (./chapters/two.tex (some parenthetical text)',
      'LaTeX Warning: Reference `y\' on page 2 undefined on input line 9.',
      '))',
    ].join('\n');
    const diagnostics = parseLatexLog(log, resolve);
    expect(diagnostics.map((d) => [d.file, d.line])).toEqual([
      ['chapters/one.tex', 3],
      ['chapters/two.tex', 9],
    ]);
  });

  it('handles errors without file-line-error and quoted file names', () => {
    const log = ['("./my file.tex"', '! Missing $ inserted.', '<inserted text>', 'l.4 a_', '     b', ')'].join('\n');
    expect(parseLatexLog(log, resolve)).toEqual([
      {
        severity: 'error',
        source: 'latex',
        message: 'Missing $ inserted.',
        file: 'my file.tex',
        line: 4,
        context: 'l.4 a_ ⟨…⟩ b',
      },
    ]);
  });

  it('reports the expected epstopdf shell-escape notice as info', () => {
    const log = ['(./main.tex', 'Package epstopdf Warning: Shell escape feature is not enabled.', ')'].join('\n');
    expect(parseLatexLog(log, resolve).map((d) => [d.severity, d.message])).toEqual([
      ['info', 'epstopdf: Shell escape feature is not enabled.'],
    ]);
  });
});

describe('parseBibtexLog', () => {
  it('extracts syntax errors and missing entries', () => {
    const diagnostics = parseBibtexLog(fixture('bibtex-error.blg'), resolve);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        source: 'bibtex',
        message: "I was expecting a `,' or a `}'",
        file: 'refs.bib',
        line: 8,
      }),
      expect.objectContaining({
        severity: 'warning',
        message: 'I didn\'t find a database entry for "missing"',
      }),
    ]);
  });

  it('reports missing databases', () => {
    const blg = "I couldn't open database file nothere.bib\n---line 3 of file main.aux";
    expect(parseBibtexLog(blg, resolve)[0]).toMatchObject({ severity: 'error' });
  });

  it('treats a bibliography without citations as a warning', () => {
    const blg = 'I found no \\citation commands---while reading file main.aux';
    expect(parseBibtexLog(blg, resolve)).toEqual([
      expect.objectContaining({ severity: 'warning', message: 'I found no \\citation commands' }),
    ]);
  });
});

describe('parseBiberLog / parseLatexmkOutput', () => {
  it('extracts biber warnings and errors', () => {
    const blg = '[0] Config.pm:307> INFO - This is Biber 2.19\n[12] Biber.pm:1234> WARN - Duplicate entry key x\n[13] Utils.pm:1> ERROR - Cannot find refs.bib';
    expect(parseBiberLog(blg).map((d) => d.severity)).toEqual(['warning', 'error']);
  });

  it('detects unstable runs', () => {
    const out = 'Latexmk: Maximum runs of pdflatex reached without getting stable files';
    expect(parseLatexmkOutput(out)).toHaveLength(1);
  });
});
