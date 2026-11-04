import { checkLatexSafety, checkStructure, type LatexIssue } from '../compile/latex-safety';
import type { EquationEnvironment } from '../schemas/equation.schema';

/** Equation-specific checks on top of the safety and structure checks. */
export function validateEquation(latex: string, environment: EquationEnvironment): LatexIssue[] {
  const issues = [...checkLatexSafety(latex, { maxLength: 20_000 }), ...checkStructure(latex)];
  if (!latex.trim()) issues.push({ severity: 'error', message: 'The equation is empty', at: null });
  if (environment !== 'custom' && /(^|[^\\])\$/.test(latex)) issues.push({ severity: 'error', message: 'Dollar signs inside mathematics are not allowed', at: latex.indexOf('$') });
  if (environment === 'inline' && /\\\\/.test(latex)) issues.push({ severity: 'warning', message: 'Line breaks (\\\\) have no effect in inline mathematics', at: null });
  if (environment === 'equation' && /\\\\/.test(latex) && !/\\begin\{(cases|[pbvBV]?matrix|array|aligned|split|gathered)\}/.test(latex)) {
    issues.push({ severity: 'warning', message: 'Several lines in an equation environment: an align environment is probably intended', at: null });
  }
  if ((environment === 'equation' || environment === 'inline' || environment === 'gather') && /(^|[^\\])&/.test(latex.replace(/\\begin\{([pbvBV]?matrix|cases|array|aligned|split)\}[\s\S]*?\\end\{\1\}/g, ''))) {
    issues.push({ severity: 'error', message: 'Alignment points (&) outside align, cases or matrix', at: latex.indexOf('&') });
  }
  if (/\\(placeholder|missing|unclear|\?\?)/.test(latex) || /\?\?/.test(latex)) issues.push({ severity: 'warning', message: 'The equation contains a placeholder for an unreadable part', at: null });
  return issues;
}
