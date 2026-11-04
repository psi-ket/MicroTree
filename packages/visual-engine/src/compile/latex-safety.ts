/**
 * Static checks on generated LaTeX before it is compiled or inserted. This
 * is defence in depth on top of the restricted TeX run (no shell escape,
 * paranoid reads and writes, throwaway workspace): generated source may not
 * read, write or run anything, define or alias control sequences, change
 * catcodes or build control sequences from strings, and may load packages
 * only through the wrapper (from an allowlist).
 */

export interface LatexIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Character offset when known. */
  at: number | null;
}

const FORBIDDEN = [
  'input', 'include', 'includeonly', 'InputIfFileExists', 'IfFileExists', 'openin', 'openout', 'read', 'readline', 'write', 'immediate', 'newwrite', 'newread',
  'closein', 'closeout', 'catcode', 'lccode', 'uccode', 'mathcode', 'csname', 'endcsname', 'scantokens', 'def', 'gdef', 'edef', 'xdef', 'let', 'futurelet',
  'expandafter', 'directlua', 'latelua', 'luaexec', 'luadirect', 'special', 'pdfobj', 'pdfximage', 'pdfrefximage', 'pdffiledump', 'pdffilesize', 'pdffilemoddate',
  'pdfmdfivesum', 'includegraphics', 'usepackage', 'RequirePackage', 'documentclass', 'makeatletter', 'makeatother', 'endinput', 'end{document}', 'begin{document}',
  'ShellEscape', 'write18', 'jobname', 'detokenize', 'string', 'meaning', 'loop', 'pgfplotstableread', 'pgfplotsinvokeforeach', 'foreach@', 'tikzexternalize',
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'NewDocumentCommand', 'RenewDocumentCommand', 'newenvironment', 'renewenvironment',
  'ExplSyntaxOn', 'pdfprimitive', 'primitive', 'everyjob', 'everypar', 'everymath', 'errorstopmode', 'batchmode', 'scrollmode', 'nonstopmode', 'output',
];

const FORBIDDEN_RE = new RegExp(`\\\\(${FORBIDDEN.map((f) => f.replace(/[{}@]/g, (c) => `\\${c}`)).join('|')})(?![A-Za-z@])`, 'g');

/** Find forbidden constructs; `allowFileTable` permits pgfplots `table {<name>.csv}` reading a file written next to the source. */
export function checkLatexSafety(source: string, opts: { maxLength?: number } = {}): LatexIssue[] {
  const issues: LatexIssue[] = [];
  const max = opts.maxLength ?? 200_000;
  if (source.length > max) issues.push({ severity: 'error', message: `The source is longer than ${max} characters`, at: null });
  if (source.includes('^^')) issues.push({ severity: 'error', message: 'Character-code escapes (^^) are not allowed', at: source.indexOf('^^') });
  // Control characters other than tab and newline can hide content.
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  const ctrl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(source);
  if (ctrl) issues.push({ severity: 'error', message: 'The source contains control characters', at: ctrl.index });
  for (const m of source.matchAll(FORBIDDEN_RE)) {
    issues.push({ severity: 'error', message: `\\${m[1]} is not allowed in generated source`, at: m.index ?? null });
  }
  // A file table in pgfplots may only name a plain relative CSV file.
  for (const m of source.matchAll(/\btable\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g)) {
    const name = m[2]!.trim();
    if (name.includes('\n') || name.includes(',')) continue; // inline data
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.csv$/.test(name)) issues.push({ severity: 'error', message: `The data file "${name.slice(0, 60)}" must be a relative .csv name`, at: m.index ?? null });
  }
  return issues;
}

/** Balanced `{}` (ignoring `\{`, `\}`), `\begin`/`\end`, and `\left`/`\right`. */
export function checkStructure(source: string): LatexIssue[] {
  const issues: LatexIssue[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '%') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) {
        issues.push({ severity: 'error', message: 'Unmatched closing brace }', at: i });
        depth = 0;
      }
    }
  }
  if (depth > 0) issues.push({ severity: 'error', message: `${depth} unclosed brace${depth > 1 ? 's' : ''} {`, at: null });
  const stack: string[] = [];
  for (const m of source.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]!);
    else {
      const open = stack.pop();
      if (open !== m[2]) issues.push({ severity: 'error', message: open ? `\\end{${m[2]}} closes \\begin{${open}}` : `\\end{${m[2]}} without \\begin`, at: m.index ?? null });
    }
  }
  for (const env of stack) issues.push({ severity: 'error', message: `\\begin{${env}} is not closed`, at: null });
  const lefts = (source.match(/\\left(?![a-zA-Z])/g) ?? []).length;
  const rights = (source.match(/\\right(?![a-zA-Z])/g) ?? []).length;
  if (lefts !== rights) issues.push({ severity: 'error', message: `${lefts} \\left but ${rights} \\right`, at: null });
  return issues;
}

/** Packages generated source may use (loaded by the wrapper, never by the source itself). */
export const PACKAGE_ALLOWLIST = [
  'amsmath', 'amssymb', 'amsfonts', 'mathtools', 'bm', 'braket', 'physics', 'xcolor', 'tikz', 'quantikz', 'circuitikz', 'pgfplots', 'siunitx', 'tensor', 'esint', 'cancel', 'upgreek',
] as const;
export type AllowedPackage = (typeof PACKAGE_ALLOWLIST)[number];

export const TIKZ_LIBRARIES = ['arrows.meta', 'positioning', 'shapes.geometric', 'calc', 'decorations.pathmorphing', 'fit', 'backgrounds'] as const;

const PACKAGE_RULES: [AllowedPackage, RegExp][] = [
  ['amsmath', /\\(begin\{(align|gather|multline|cases|pmatrix|bmatrix|vmatrix|Vmatrix|matrix|split|aligned|gathered)\*?\}|text|dfrac|tfrac|binom|operatorname|boldsymbol|xrightarrow|tag|eqref|substack)(?![A-Za-z])/],
  ['amssymb', /\\(mathbb|mathfrak|leqslant|geqslant|lesssim|gtrsim|square|blacksquare|therefore|because|varnothing|nexists|mathscr|checkmark|rtimes|ltimes|lll|ggg|curlyvee|curlywedge)(?![A-Za-z])/],
  ['mathtools', /\\(coloneqq|eqqcolon|begin\{(dcases|rcases|psmallmatrix)\*?\}|mathclap|prescript|DeclarePairedDelimiter)(?![A-Za-z])/],
  ['bm', /\\bm(?![A-Za-z])/],
  ['braket', /\\(bra|ket|braket|Bra|Ket|Braket|set|Set)(?![A-Za-z])/],
  ['siunitx', /\\(SI|si|num|qty|unit|ang)(?![A-Za-z])/],
  ['cancel', /\\(cancel|bcancel|xcancel|cancelto)(?![A-Za-z])/],
  ['upgreek', /\\up(alpha|beta|gamma|delta|mu|pi|sigma|tau|omega)(?![A-Za-z])/],
  ['esint', /\\(oiint|oiiint|ointctrclockwise)(?![A-Za-z])/],
  ['tensor', /\\tensor(?![A-Za-z])/],
  ['xcolor', /\\(color|textcolor|colorbox)(?![A-Za-z])/],
];

/** Packages a piece of mathematics or a picture body needs, beyond what the generator adds itself. */
export function detectPackages(source: string): AllowedPackage[] {
  const out = new Set<AllowedPackage>();
  for (const [pkg, re] of PACKAGE_RULES) if (re.test(source)) out.add(pkg);
  if (/\\begin\{tikzpicture\}/.test(source)) out.add('tikz');
  if (/\\begin\{quantikz\}/.test(source)) out.add('quantikz');
  if (/\\begin\{circuitikz\}/.test(source)) out.add('circuitikz');
  if (/\\begin\{axis\}|\\begin\{semilogyaxis\}|\\begin\{loglogaxis\}|\\begin\{semilogxaxis\}/.test(source)) out.add('pgfplots');
  // physics and braket define \bra/\ket differently; prefer braket unless physics-only commands appear.
  if (/\\(dv|pdv|expval|mel|comm|acomm|abs|norm|order|qty)\{?/.test(source) && /\\(dv|pdv|expval|mel|comm|acomm)(?![A-Za-z])/.test(source)) {
    out.add('physics');
    out.delete('braket');
  }
  return [...out].sort();
}

export function hasErrors(issues: readonly LatexIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
