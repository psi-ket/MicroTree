/**
 * Static LaTeX completion catalog. Snippets use the LSP/Monaco snippet
 * syntax (`${1:placeholder}`, `$0`).
 */

export interface CommandCompletion {
  /** Command name without the leading backslash. */
  name: string;
  snippet: string;
  detail: string;
  /** Package providing the command, when not part of the LaTeX kernel. */
  package?: string;
}

export interface EnvironmentCompletion {
  name: string;
  /** Body inserted between \begin and \end. */
  body: string;
  detail: string;
  package?: string;
}

export const LATEX_COMMANDS: readonly CommandCompletion[] = [
  { name: 'documentclass', snippet: 'documentclass[${2:11pt}]{${1:article}}', detail: 'Document class' },
  { name: 'usepackage', snippet: 'usepackage{${1:package}}', detail: 'Load a package' },
  { name: 'title', snippet: 'title{${1:Title}}', detail: 'Document title' },
  { name: 'author', snippet: 'author{${1:Author}}', detail: 'Document author' },
  { name: 'date', snippet: 'date{${1:\\today}}', detail: 'Document date' },
  { name: 'maketitle', snippet: 'maketitle', detail: 'Typeset the title block' },
  { name: 'tableofcontents', snippet: 'tableofcontents', detail: 'Table of contents' },
  { name: 'part', snippet: 'part{${1:title}}', detail: 'Part heading' },
  { name: 'chapter', snippet: 'chapter{${1:title}}', detail: 'Chapter heading' },
  { name: 'section', snippet: 'section{${1:title}}', detail: 'Section heading' },
  { name: 'subsection', snippet: 'subsection{${1:title}}', detail: 'Subsection heading' },
  { name: 'subsubsection', snippet: 'subsubsection{${1:title}}', detail: 'Subsubsection heading' },
  { name: 'paragraph', snippet: 'paragraph{${1:title}}', detail: 'Paragraph heading' },
  { name: 'label', snippet: 'label{${1:key}}', detail: 'Cross-reference label' },
  { name: 'ref', snippet: 'ref{${1:key}}', detail: 'Reference a label' },
  { name: 'eqref', snippet: 'eqref{${1:key}}', detail: 'Reference an equation', package: 'amsmath' },
  { name: 'pageref', snippet: 'pageref{${1:key}}', detail: 'Page of a label' },
  { name: 'autoref', snippet: 'autoref{${1:key}}', detail: 'Named reference', package: 'hyperref' },
  { name: 'cref', snippet: 'cref{${1:key}}', detail: 'Clever reference', package: 'cleveref' },
  { name: 'cite', snippet: 'cite{${1:key}}', detail: 'Citation' },
  { name: 'citep', snippet: 'citep{${1:key}}', detail: 'Parenthetical citation', package: 'natbib' },
  { name: 'citet', snippet: 'citet{${1:key}}', detail: 'Textual citation', package: 'natbib' },
  { name: 'parencite', snippet: 'parencite{${1:key}}', detail: 'Parenthetical citation', package: 'biblatex' },
  { name: 'textcite', snippet: 'textcite{${1:key}}', detail: 'Textual citation', package: 'biblatex' },
  { name: 'nocite', snippet: 'nocite{${1:*}}', detail: 'Include without citing' },
  { name: 'bibliography', snippet: 'bibliography{${1:references}}', detail: 'BibTeX database' },
  { name: 'bibliographystyle', snippet: 'bibliographystyle{${1:plain}}', detail: 'BibTeX style' },
  { name: 'addbibresource', snippet: 'addbibresource{${1:references.bib}}', detail: 'Bib resource', package: 'biblatex' },
  { name: 'printbibliography', snippet: 'printbibliography', detail: 'Print bibliography', package: 'biblatex' },
  { name: 'input', snippet: 'input{${1:file}}', detail: 'Input a file' },
  { name: 'include', snippet: 'include{${1:file}}', detail: 'Include a file on a new page' },
  { name: 'includegraphics', snippet: 'includegraphics[width=${2:\\linewidth}]{${1:file}}', detail: 'Insert an image', package: 'graphicx' },
  { name: 'caption', snippet: 'caption{${1:text}}', detail: 'Float caption' },
  { name: 'centering', snippet: 'centering', detail: 'Center content' },
  { name: 'footnote', snippet: 'footnote{${1:text}}', detail: 'Footnote' },
  { name: 'emph', snippet: 'emph{${1:text}}', detail: 'Emphasis' },
  { name: 'textbf', snippet: 'textbf{${1:text}}', detail: 'Bold' },
  { name: 'textit', snippet: 'textit{${1:text}}', detail: 'Italic' },
  { name: 'texttt', snippet: 'texttt{${1:text}}', detail: 'Monospace' },
  { name: 'textsc', snippet: 'textsc{${1:text}}', detail: 'Small caps' },
  { name: 'underline', snippet: 'underline{${1:text}}', detail: 'Underline' },
  { name: 'url', snippet: 'url{${1:https://}}', detail: 'URL', package: 'hyperref' },
  { name: 'href', snippet: 'href{${1:https://}}{${2:text}}', detail: 'Hyperlink', package: 'hyperref' },
  { name: 'item', snippet: 'item ', detail: 'List item' },
  { name: 'newcommand', snippet: 'newcommand{\\\\${1:name}}[${2:0}]{${3:definition}}', detail: 'Define a command' },
  { name: 'renewcommand', snippet: 'renewcommand{\\\\${1:name}}{${2:definition}}', detail: 'Redefine a command' },
  { name: 'frac', snippet: 'frac{${1:num}}{${2:den}}', detail: 'Fraction' },
  { name: 'sqrt', snippet: 'sqrt{${1:x}}', detail: 'Square root' },
  { name: 'sum', snippet: 'sum_{${1:i=1}}^{${2:n}}', detail: 'Summation' },
  { name: 'int', snippet: 'int_{${1:a}}^{${2:b}}', detail: 'Integral' },
  { name: 'prod', snippet: 'prod_{${1:i=1}}^{${2:n}}', detail: 'Product' },
  { name: 'lim', snippet: 'lim_{${1:x \\to \\infty}}', detail: 'Limit' },
  { name: 'mathbb', snippet: 'mathbb{${1:R}}', detail: 'Blackboard bold', package: 'amssymb' },
  { name: 'mathcal', snippet: 'mathcal{${1:L}}', detail: 'Calligraphic' },
  { name: 'mathrm', snippet: 'mathrm{${1:text}}', detail: 'Upright math text' },
  { name: 'mathbf', snippet: 'mathbf{${1:x}}', detail: 'Bold math' },
  { name: 'text', snippet: 'text{${1:text}}', detail: 'Text in math', package: 'amsmath' },
  { name: 'left', snippet: 'left${1:(} $0 \\right${2:)}', detail: 'Scaled delimiters' },
  { name: 'alpha', snippet: 'alpha', detail: 'α' },
  { name: 'beta', snippet: 'beta', detail: 'β' },
  { name: 'gamma', snippet: 'gamma', detail: 'γ' },
  { name: 'delta', snippet: 'delta', detail: 'δ' },
  { name: 'epsilon', snippet: 'epsilon', detail: 'ε' },
  { name: 'varepsilon', snippet: 'varepsilon', detail: 'ε (variant)' },
  { name: 'theta', snippet: 'theta', detail: 'θ' },
  { name: 'lambda', snippet: 'lambda', detail: 'λ' },
  { name: 'mu', snippet: 'mu', detail: 'μ' },
  { name: 'pi', snippet: 'pi', detail: 'π' },
  { name: 'sigma', snippet: 'sigma', detail: 'σ' },
  { name: 'phi', snippet: 'phi', detail: 'φ' },
  { name: 'omega', snippet: 'omega', detail: 'ω' },
  { name: 'Delta', snippet: 'Delta', detail: 'Δ' },
  { name: 'Sigma', snippet: 'Sigma', detail: 'Σ' },
  { name: 'Omega', snippet: 'Omega', detail: 'Ω' },
  { name: 'infty', snippet: 'infty', detail: '∞' },
  { name: 'partial', snippet: 'partial', detail: '∂' },
  { name: 'nabla', snippet: 'nabla', detail: '∇' },
  { name: 'cdot', snippet: 'cdot', detail: '·' },
  { name: 'times', snippet: 'times', detail: '×' },
  { name: 'leq', snippet: 'leq', detail: '≤' },
  { name: 'geq', snippet: 'geq', detail: '≥' },
  { name: 'neq', snippet: 'neq', detail: '≠' },
  { name: 'approx', snippet: 'approx', detail: '≈' },
  { name: 'in', snippet: 'in', detail: '∈' },
  { name: 'to', snippet: 'to', detail: '→' },
  { name: 'hline', snippet: 'hline', detail: 'Horizontal table rule' },
  { name: 'toprule', snippet: 'toprule', detail: 'Top rule', package: 'booktabs' },
  { name: 'midrule', snippet: 'midrule', detail: 'Middle rule', package: 'booktabs' },
  { name: 'bottomrule', snippet: 'bottomrule', detail: 'Bottom rule', package: 'booktabs' },
  { name: 'newpage', snippet: 'newpage', detail: 'Page break' },
  { name: 'clearpage', snippet: 'clearpage', detail: 'Flush floats and break page' },
  { name: 'vspace', snippet: 'vspace{${1:1em}}', detail: 'Vertical space' },
  { name: 'hspace', snippet: 'hspace{${1:1em}}', detail: 'Horizontal space' },
  { name: 'today', snippet: 'today', detail: 'Current date' },
  { name: 'appendix', snippet: 'appendix', detail: 'Start appendices' },
];

export const LATEX_ENVIRONMENTS: readonly EnvironmentCompletion[] = [
  { name: 'document', body: '\t$0', detail: 'Document body' },
  { name: 'abstract', body: '\t$0', detail: 'Abstract' },
  { name: 'itemize', body: '\t\\item $0', detail: 'Bulleted list' },
  { name: 'enumerate', body: '\t\\item $0', detail: 'Numbered list' },
  { name: 'description', body: '\t\\item[${1:term}] $0', detail: 'Description list' },
  { name: 'figure', body: '\t\\centering\n\t\\includegraphics[width=${1:\\linewidth}]{${2:file}}\n\t\\caption{${3:caption}}\n\t\\label{fig:${4:label}}', detail: 'Figure float' },
  { name: 'table', body: '\t\\centering\n\t\\caption{${1:caption}}\n\t\\label{tab:${2:label}}\n\t\\begin{tabular}{${3:lr}}\n\t\t$0\n\t\\end{tabular}', detail: 'Table float' },
  { name: 'tabular', body: '\t$0', detail: 'Table body' },
  { name: 'equation', body: '\t$0', detail: 'Numbered equation' },
  { name: 'equation*', body: '\t$0', detail: 'Unnumbered equation', package: 'amsmath' },
  { name: 'align', body: '\t$0', detail: 'Aligned equations', package: 'amsmath' },
  { name: 'align*', body: '\t$0', detail: 'Aligned equations (unnumbered)', package: 'amsmath' },
  { name: 'gather', body: '\t$0', detail: 'Gathered equations', package: 'amsmath' },
  { name: 'cases', body: '\t$0', detail: 'Piecewise cases', package: 'amsmath' },
  { name: 'pmatrix', body: '\t$0', detail: 'Matrix (parentheses)', package: 'amsmath' },
  { name: 'bmatrix', body: '\t$0', detail: 'Matrix (brackets)', package: 'amsmath' },
  { name: 'theorem', body: '\t$0', detail: 'Theorem (amsthm)' },
  { name: 'lemma', body: '\t$0', detail: 'Lemma (amsthm)' },
  { name: 'proof', body: '\t$0', detail: 'Proof', package: 'amsthm' },
  { name: 'definition', body: '\t$0', detail: 'Definition (amsthm)' },
  { name: 'quote', body: '\t$0', detail: 'Short quotation' },
  { name: 'verbatim', body: '$0', detail: 'Verbatim text' },
  { name: 'center', body: '\t$0', detail: 'Centered block' },
  { name: 'minipage', body: '\t$0', detail: 'Minipage' },
  { name: 'frame', body: '\t\\frametitle{${1:Title}}\n\t$0', detail: 'Beamer frame' },
  { name: 'tikzpicture', body: '\t$0', detail: 'TikZ picture', package: 'tikz' },
  { name: 'thebibliography', body: '\t\\bibitem{${1:key}} $0', detail: 'Manual bibliography' },
];

export const BIBTEX_ENTRY_TYPES = [
  'article',
  'book',
  'inproceedings',
  'incollection',
  'phdthesis',
  'mastersthesis',
  'techreport',
  'misc',
  'online',
  'unpublished',
] as const;

const BIBTEX_FIELDS: Record<string, string[]> = {
  article: ['author', 'title', 'journal', 'year', 'volume', 'number', 'pages', 'doi'],
  book: ['author', 'title', 'publisher', 'year', 'address', 'isbn'],
  inproceedings: ['author', 'title', 'booktitle', 'year', 'pages', 'publisher', 'doi'],
  incollection: ['author', 'title', 'booktitle', 'editor', 'publisher', 'year', 'pages'],
  phdthesis: ['author', 'title', 'school', 'year'],
  mastersthesis: ['author', 'title', 'school', 'year'],
  techreport: ['author', 'title', 'institution', 'year', 'number'],
  misc: ['author', 'title', 'howpublished', 'year', 'note'],
  online: ['author', 'title', 'url', 'urldate', 'year'],
  unpublished: ['author', 'title', 'note', 'year'],
};

/** Build a BibTeX entry snippet with tab stops for each field. */
export function bibtexEntrySnippet(type: string): string {
  const fields = BIBTEX_FIELDS[type] ?? ['author', 'title', 'year'];
  const body = fields.map((f, i) => `\t${f} = {\${${i + 2}}},`).join('\n');
  return `@${type}{\${1:key},\n${body}\n}`;
}
