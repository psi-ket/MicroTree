import type { ProjectTemplate } from '@research-studio/shared-types';

export interface TemplateFile {
  path: string;
  content: string;
}

export interface TemplateOptions {
  title: string;
  author?: string;
}

/** Escape text so it can be placed inside a LaTeX argument verbatim. */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\textbackslash{}';
      case '~':
        return '\\textasciitilde{}';
      case '^':
        return '\\textasciicircum{}';
      default:
        return `\\${ch}`;
    }
  });
}

const REFERENCES_BIB = `@article{knuth1984literate,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  year    = {1984},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  doi     = {10.1093/comjnl/27.2.97}
}

@book{lamport1994latex,
  author    = {Lamport, Leslie},
  title     = {{\\LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  year      = {1994},
  edition   = {2}
}
`;

function article(o: Required<TemplateOptions>): TemplateFile[] {
  return [
    {
      path: 'main.tex',
      content: `\\documentclass[11pt]{article}

\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}

\\graphicspath{{figures/}}

\\title{${o.title}}
\\author{${o.author}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
  A short summary of the contribution.
\\end{abstract}

\\input{sections/introduction}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
    },
    {
      path: 'sections/introduction.tex',
      content: `\\section{Introduction}
\\label{sec:introduction}

Literate programming~\\cite{knuth1984literate} treats programs as works of
literature, and \\LaTeX{}~\\cite{lamport1994latex} made high-quality
typesetting broadly accessible.

\\begin{equation}
  \\label{eq:euler}
  e^{i\\pi} + 1 = 0
\\end{equation}

Equation~\\eqref{eq:euler} is typeset in Section~\\ref{sec:introduction}.
`,
    },
    { path: 'references.bib', content: REFERENCES_BIB },
  ];
}

function report(o: Required<TemplateOptions>): TemplateFile[] {
  return [
    {
      path: 'main.tex',
      content: `\\documentclass[11pt]{report}

\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[hidelinks]{hyperref}

\\graphicspath{{figures/}}

\\title{${o.title}}
\\author{${o.author}}

\\begin{document}

\\maketitle
\\tableofcontents

\\include{chapters/introduction}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
    },
    {
      path: 'chapters/introduction.tex',
      content: `\\chapter{Introduction}
\\label{chap:introduction}

This report builds on~\\cite{lamport1994latex}.
`,
    },
    { path: 'references.bib', content: REFERENCES_BIB },
  ];
}

function beamer(o: Required<TemplateOptions>): TemplateFile[] {
  return [
    {
      path: 'main.tex',
      content: `\\documentclass{beamer}

\\usepackage[T1]{fontenc}
\\usepackage{graphicx}

\\title{${o.title}}
\\author{${o.author}}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Motivation}
  \\begin{itemize}
    \\item First point
    \\item Second point
  \\end{itemize}
\\end{frame}

\\end{document}
`,
    },
  ];
}

function empty(o: Required<TemplateOptions>): TemplateFile[] {
  return [
    {
      path: 'main.tex',
      content: `\\documentclass{article}

\\title{${o.title}}
\\author{${o.author}}

\\begin{document}

\\maketitle

\\end{document}
`,
    },
  ];
}

/** Files (with escaped user input) that make up a new project of the given template. */
export function renderTemplate(template: ProjectTemplate, options: TemplateOptions): TemplateFile[] {
  const o = {
    title: escapeLatex(options.title.trim() || 'Untitled'),
    author: escapeLatex(options.author?.trim() || 'Author'),
  };
  switch (template) {
    case 'article':
      return article(o);
    case 'report':
      return report(o);
    case 'beamer':
      return beamer(o);
    case 'empty':
      return empty(o);
  }
}

/** Directories created for every new project. */
export const TEMPLATE_DIRECTORIES = ['figures'];
