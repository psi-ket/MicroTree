import { detectPackages, PACKAGE_ALLOWLIST, TIKZ_LIBRARIES, type AllowedPackage } from './latex-safety';

export type StandaloneKind = 'math' | 'picture';

/**
 * A complete standalone document around generated source, loading only
 * allowlisted packages. `math` uses `varwidth` so display environments work;
 * `picture` crops to the drawing.
 */
export function standaloneDocument(body: string, kind: StandaloneKind, extraPackages: readonly string[] = []): { document: string; packages: AllowedPackage[] } {
  const detected = detectPackages(body);
  const packages = [...new Set<AllowedPackage>([...detected, ...extraPackages.filter((p): p is AllowedPackage => (PACKAGE_ALLOWLIST as readonly string[]).includes(p))])];
  if (kind === 'math' && !packages.includes('amsmath')) packages.push('amsmath');
  if (kind === 'math' && !packages.includes('amssymb')) packages.push('amssymb');
  if (packages.includes('pgfplots') && !packages.includes('tikz')) packages.push('tikz');
  const order: AllowedPackage[] = [...PACKAGE_ALLOWLIST];
  packages.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const lines = [
    kind === 'math' ? '\\documentclass[border=6pt,varwidth=16cm]{standalone}' : '\\documentclass[border=6pt]{standalone}',
    ...packages.map((p) => `\\usepackage{${p}}`),
  ];
  if (packages.includes('tikz') || packages.includes('circuitikz') || packages.includes('quantikz')) lines.push(`\\usetikzlibrary{${TIKZ_LIBRARIES.join(',')}}`);
  if (packages.includes('pgfplots')) lines.push('\\pgfplotsset{compat=1.18}');
  lines.push('\\begin{document}', body, '\\end{document}', '');
  return { document: lines.join('\n'), packages };
}

/** Preamble lines a project needs for an artifact (shown for approval before any preamble change). */
export function preambleLines(packages: readonly string[]): string[] {
  const lines = packages.map((p) => `\\usepackage{${p}}`);
  if (packages.some((p) => p === 'tikz' || p === 'circuitikz' || p === 'quantikz')) lines.push(`\\usetikzlibrary{${TIKZ_LIBRARIES.join(',')}}`);
  if (packages.includes('pgfplots')) lines.push('\\pgfplotsset{compat=1.18}');
  return lines;
}
