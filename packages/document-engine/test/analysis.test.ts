import { describe, expect, it } from 'vitest';
import {
  bibtexEntrySnippet,
  classifyFile,
  editorLanguageFor,
  escapeLatex,
  extractCitations,
  extractFileReferences,
  extractLabels,
  extractOutline,
  isRootDocument,
  parseBibEntries,
  renderTemplate,
  stripComment,
} from '../src';

const DOC = String.raw`\documentclass{article}
\begin{document}
\section{Intro}\label{sec:intro}
% \label{commented}
As shown in~\cite{knuth1984, lamport94} and \citep[p.~3]{doe2020}.
50\% of \label{eq:one} text
\subsection*{Details}
\input{sections/methods}
\includegraphics[width=\linewidth]{figures/plot.png}
\bibliography{refs,extra}
\end{document}
`;

describe('latex analysis', () => {
  it('strips comments but keeps escaped percent signs', () => {
    expect(stripComment('a % b')).toBe('a ');
    expect(stripComment('50\\% done % note')).toBe('50\\% done ');
    expect(stripComment('\\\\% comment')).toBe('\\\\');
  });

  it('extracts labels outside comments', () => {
    expect(extractLabels(DOC)).toEqual([
      { label: 'sec:intro', line: 3 },
      { label: 'eq:one', line: 6 },
    ]);
  });

  it('extracts citation keys including natbib optional args', () => {
    expect(extractCitations(DOC).map((c) => c.key)).toEqual(['knuth1984', 'lamport94', 'doe2020']);
  });

  it('extracts an outline', () => {
    expect(extractOutline(DOC)).toEqual([
      { kind: 'section', level: 2, title: 'Intro', line: 3 },
      { kind: 'subsection', level: 3, title: 'Details', line: 7 },
    ]);
  });

  it('extracts file references', () => {
    expect(extractFileReferences(DOC).map((r) => `${r.kind}:${r.target}`)).toEqual([
      'input:sections/methods',
      'graphics:figures/plot.png',
      'bibliography:refs',
      'bibliography:extra',
    ]);
  });

  it('detects root documents', () => {
    expect(isRootDocument(DOC)).toBe(true);
    expect(isRootDocument('\\section{x}')).toBe(false);
  });
});

describe('bibtex', () => {
  it('parses entries tolerantly', () => {
    const bib = `
@comment{ignored}
@string{jcs = "J. Comp. Sci."}
@Article{knuth1984,
  author = {Knuth, Donald E.},
  title  = {{Literate} Programming},
  year   = 1984
}
@book(lamport94, title = "LaTeX", date = {1994-01-01})
@misc{broken
`;
    const entries = parseBibEntries(bib);
    expect(entries).toEqual([
      {
        key: 'knuth1984',
        type: 'article',
        line: 4,
        title: 'Literate Programming',
        author: 'Knuth, Donald E.',
        year: '1984',
      },
      { key: 'lamport94', type: 'book', line: 9, title: 'LaTeX', author: null, year: '1994' },
    ]);
  });

  it('builds entry snippets', () => {
    expect(bibtexEntrySnippet('article')).toContain('journal = {${4}}');
  });
});

describe('file kinds & templates', () => {
  it('classifies files', () => {
    expect(classifyFile('main.tex')).toBe('tex');
    expect(classifyFile('refs.BIB')).toBe('bib');
    expect(classifyFile('fig.jpeg')).toBe('image');
    expect(classifyFile('x.unknown')).toBe('other');
    expect(editorLanguageFor('a.sty')).toBe('latex');
    expect(editorLanguageFor('a.bib')).toBe('bibtex');
  });

  it('escapes user input inside templates', () => {
    expect(escapeLatex('50% & $x_1$ \\ ~')).toBe(
      '50\\% \\& \\$x\\_1\\$ \\textbackslash{} \\textasciitilde{}',
    );
    const files = renderTemplate('article', { title: 'R&D}\\input{/etc/passwd}', author: 'A' });
    const main = files.find((f) => f.path === 'main.tex')!;
    expect(main.content).toContain('\\title{R\\&D\\}\\textbackslash{}input\\{/etc/passwd\\}}');
    expect(files.map((f) => f.path)).toEqual(['main.tex', 'sections/introduction.tex', 'references.bib']);
  });

  it('renders every template with a root document', () => {
    for (const t of ['article', 'report', 'beamer', 'empty'] as const) {
      const main = renderTemplate(t, { title: 'T' }).find((f) => f.path === 'main.tex');
      expect(main && isRootDocument(main.content)).toBe(true);
    }
  });
});
