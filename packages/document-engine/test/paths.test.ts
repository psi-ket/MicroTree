import { describe, expect, it } from 'vitest';
import { normalizeProjectPath, slugify, validateEntryName, extname, dirname } from '../src';

describe('normalizeProjectPath', () => {
  it.each([
    ['main.tex', 'main.tex'],
    ['./chapters//intro.tex', 'chapters/intro.tex'],
    ['chapters\\intro.tex', 'chapters/intro.tex'],
    ['figures/plot 1.png', 'figures/plot 1.png'],
    ['ünïcödé/naïve.tex', 'ünïcödé/naïve.tex'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeProjectPath(input)).toBe(expected);
  });

  it.each([
    ['../secret.txt'],
    ['chapters/../../etc/passwd'],
    ['..\\..\\Windows\\win.ini'],
    ['/etc/passwd'],
    ['\\\\server\\share\\file'],
    ['C:\\Windows\\win.ini'],
    ['c:relative'],
    ['file.tex:stream'],
    ['nul'],
    ['CON.tex'],
    ['dir/com1.txt'],
    ['trailing.'],
    ['trailing '],
    ['a\u0000b'],
    ['line\nbreak'],
    ['wild*card'],
    [''],
    ['.'],
  ])('rejects %j', (input) => {
    expect(() => normalizeProjectPath(input)).toThrowError(
      expect.objectContaining({ code: 'PATH_VIOLATION' }),
    );
  });

  it('allows the root only when requested', () => {
    expect(normalizeProjectPath('', { allowRoot: true })).toBe('');
    expect(normalizeProjectPath('./', { allowRoot: true })).toBe('');
  });

  it('protects reserved top-level directories for writes', () => {
    expect(() => normalizeProjectPath('.rs-build/main.pdf', { forWrite: true })).toThrow();
    expect(() => normalizeProjectPath('.GIT/config', { forWrite: true })).toThrow();
    expect(normalizeProjectPath('.rs-build/main.pdf')).toBe('.rs-build/main.pdf');
    expect(normalizeProjectPath('docs/.git/x', { forWrite: true })).toBe('docs/.git/x');
  });

  it('rejects non-strings and very long paths', () => {
    expect(() => normalizeProjectPath(42)).toThrow();
    expect(() => normalizeProjectPath('a/'.repeat(600))).toThrow();
  });
});

describe('helpers', () => {
  it('validates single names', () => {
    expect(validateEntryName('intro.tex')).toBe('intro.tex');
    expect(() => validateEntryName('a/b.tex')).toThrow();
  });

  it('computes extensions and dirnames', () => {
    expect(extname('a/b/Figure.PNG')).toBe('png');
    expect(extname('.latexmkrc')).toBe('');
    expect(dirname('a/b/c.tex')).toBe('a/b');
    expect(dirname('c.tex')).toBe('');
  });

  it('slugifies project names', () => {
    expect(slugify('Quantum Error Correction — Draft #2')).toBe('quantum-error-correction-draft-2');
    expect(slugify('Ångström')).toBe('angstrom');
    expect(slugify('***')).toBe('project-untitled');
    expect(slugify('con')).toBe('project-con');
  });
});
