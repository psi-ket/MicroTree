import type { ClaimQuantity } from '@research-studio/shared-types';

/**
 * Plain text of a LaTeX claim for retrieval and comparison: citations and
 * references removed, formatting commands unwrapped, accents and spacing
 * normalised. Inline maths is kept as written (it carries meaning).
 */
export function normalizeClaimText(latex: string): string {
  return latex
    .replace(/\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^{}]*\}/g, '')
    .replace(/\\(?:eq|c|C|auto|page|name)?ref\s*\{[^{}]*\}/g, '[ref]')
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:emph|textbf|textit|textrm|textsf|texttt|underline|mbox|text)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\%/g, '%')
    .replace(/\\&/g, '&')
    .replace(/~|\\[,;: ]/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT = String.raw`(?:%|\\%|percent|K|mK|µK|μK|nK|Hz|kHz|MHz|GHz|THz|s|ms|µs|μs|us|ns|ps|fs|m|cm|mm|µm|μm|nm|pm|km|eV|meV|keV|MeV|GeV|TeV|J|W|mW|V|mV|A|mA|T|mT|G|Pa|bar|dB|rad|deg|°|qubits?|gates?|photons?|atoms?|ions?|electrons?|layers?|rounds?|samples?|cycles?|times)`;
const QUANTITY = new RegExp(String.raw`(?<![\w.])([-+−]?\d+(?:[.,]\d+)?(?:\s*(?:×|\\times|x)\s*10\^?\{?[-−]?\d+\}?)?)\s*(?:\$?\\?(?:mu|mathrm\{[^}]*\})?\$?\s*)?(${UNIT})?(?![\w])`, 'g');

/** Numbers with their units and the words around them. */
export function extractQuantities(text: string): ClaimQuantity[] {
  const plain = normalizeClaimText(text);
  const out: ClaimQuantity[] = [];
  for (const m of plain.matchAll(QUANTITY)) {
    const value = m[1]!.replace('−', '-');
    // Years and section numbers are not quantities.
    if (!m[2] && /^(1[5-9]|20)\d\d$/.test(value)) continue;
    if (!m[2] && /^\d$/.test(value) && !/\d/.test(plain.slice(Math.max(0, m.index - 3), m.index))) continue;
    const at = m.index ?? 0;
    const context = plain.slice(Math.max(0, at - 40), Math.min(plain.length, at + m[0].length + 40)).trim();
    out.push({ value, ...(m[2] ? { unit: m[2].replace('\\%', '%') } : {}), context });
  }
  return out.slice(0, 20);
}

const STOP = new Set(
  'a an the and or but of in on at to for with by from as is are was were be been being has have had this that these those it its their there which who whom whose than then thus also such can could may might will would should must not no we our us they them he she his her i you your into onto over under between within without about above below more most less least very well both each all any some many much other another same so if when where while because since however therefore although though only just even still yet do does did done using use used based via per et al e g i e'.split(
    ' ',
  ),
);

/** Technical terms: hyphenated words, acronyms, capitalised names, words with digits, and two- or three-word noun phrases. */
export function extractTerms(text: string): { entities: string[]; concepts: string[] } {
  const plain = normalizeClaimText(text).replace(/\$[^$]*\$/g, ' ');
  const entities = new Set<string>();
  for (const m of plain.matchAll(/\b(?:[A-Z][a-z]+(?:[-\s][A-Z][a-z]+)+|[A-Z]{2,}[a-z]?s?|[A-Z][a-z]*\d[\w-]*|[A-Z][a-z]+(?=\s+(?:code|codes|model|algorithm|effect|equation|theorem|decoder|simulator|method)\b))\b/g)) {
    const e = m[0].trim();
    if (!STOP.has(e.toLowerCase())) entities.add(e);
  }
  const words = plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const concepts = new Set<string>();
  let run: string[] = [];
  const close = () => {
    if (run.length >= 2) concepts.add(run.slice(-3).join(' '));
    else if (run.length === 1 && (run[0]!.includes('-') || run[0]!.length >= 8)) concepts.add(run[0]!);
    run = [];
  };
  for (const w of words) {
    if (STOP.has(w) || /^\d/.test(w)) close();
    else run.push(w);
  }
  close();
  return { entities: [...entities].slice(0, 20), concepts: [...concepts].slice(0, 20) };
}
