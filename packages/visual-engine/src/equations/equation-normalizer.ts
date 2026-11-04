/**
 * Normalisation of model-written mathematics: wrappers the model added
 * (`$…$`, `\[…\]`, `\begin{equation}…`) are removed so the chosen
 * environment decides the wrapper, and Unicode math characters are mapped
 * to their LaTeX commands (reported, never silently).
 */
const UNICODE: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', τ: '\\tau', υ: '\\upsilon', φ: '\\phi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '∂': '\\partial', '∇': '\\nabla', '∞': '\\infty', '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx',
  '≡': '\\equiv', '∝': '\\propto', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '±': '\\pm', '∓': '\\mp', '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow', '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq', '∪': '\\cup', '∩': '\\cap', '∀': '\\forall', '∃': '\\exists', '⟨': '\\langle',
  '⟩': '\\rangle', '†': '^\\dagger', 'ℏ': '\\hbar', '⊗': '\\otimes', '⊕': '\\oplus', '√': '\\sqrt', '−': '-', '′': "'", '∘': '\\circ', '…': '\\ldots', '⋯': '\\cdots',
};

export function stripMathWrappers(latex: string): { latex: string; stripped: boolean } {
  let s = latex.trim();
  const before = s;
  const pairs: [RegExp, RegExp][] = [
    [/^\$\$/, /\$\$$/],
    [/^\$/, /\$$/],
    [/^\\\[/, /\\\]$/],
    [/^\\\(/, /\\\)$/],
    [/^\\begin\{(equation|align|gather|multline|displaymath)\*?\}/, /\\end\{(equation|align|gather|multline|displaymath)\*?\}$/],
  ];
  for (const [open, close] of pairs) {
    if (open.test(s) && close.test(s)) s = s.replace(open, '').replace(close, '').trim();
  }
  return { latex: s, stripped: s !== before };
}

export function normalizeEquationLatex(latex: string): { latex: string; notes: string[] } {
  const notes: string[] = [];
  const { latex: unwrapped, stripped } = stripMathWrappers(latex);
  if (stripped) notes.push('The model’s math delimiters were removed; the chosen environment adds its own.');
  const converted = new Set<string>();
  let s = '';
  for (const ch of unwrapped) {
    const cmd = UNICODE[ch];
    if (cmd) {
      converted.add(ch);
      // A command followed by a letter needs a space (\alpha x, not \alphax).
      s += /\\[A-Za-z]+$/.test(cmd) ? `${cmd} ` : cmd;
    } else s += ch;
  }
  if (converted.size) notes.push(`Unicode symbols were written as LaTeX commands: ${[...converted].join(' ')}`);
  return { latex: s.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim(), notes };
}
