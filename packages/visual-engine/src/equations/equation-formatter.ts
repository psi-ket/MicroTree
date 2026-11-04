import type { EquationEnvironment } from '../schemas/equation.schema';

export interface EquationFormatOptions {
  /** `\label{…}` for numbered environments. */
  label?: string | null;
  /** Unnumbered (`equation*`, `align*`, `gather*`). */
  starred?: boolean;
}

const LABEL = /^[A-Za-z][A-Za-z0-9:._-]{0,60}$/;

/**
 * The complete source for an environment. `cases` and `matrix` sit inside an
 * `equation`; when the mathematics lacks the inner environment, it is added.
 */
export function formatEquation(latex: string, environment: EquationEnvironment, opts: EquationFormatOptions = {}): string {
  const body = latex.trim();
  const label = opts.label && LABEL.test(opts.label) ? `\\label{${opts.label}}\n` : '';
  const star = opts.starred ? '*' : '';
  const display = (env: string, inner: string) => `\\begin{${env}${star}}\n${label}${inner}\n\\end{${env}${star}}`;
  switch (environment) {
    case 'inline':
      return `$${body.replace(/\s*\n\s*/g, ' ')}$`;
    case 'equation':
      return display('equation', body);
    case 'align':
      return display('align', body);
    case 'gather':
      return display('gather', body);
    case 'cases':
      return display('equation', /\\begin\{(cases|dcases|rcases)\}/.test(body) ? body : `\\begin{cases}\n${body}\n\\end{cases}`);
    case 'matrix':
      return display('equation', /\\begin\{[pbvBV]?matrix\}|\\begin\{array\}/.test(body) ? body : `\\begin{pmatrix}\n${body}\n\\end{pmatrix}`);
    case 'custom':
      return body;
  }
}
