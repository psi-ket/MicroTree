import type { BuiltInClaimType, NonClaimKind } from '@research-studio/shared-types';
import { normalizeClaimText } from './claim-normalizer';

export type SentenceKind = { claim: true } | { claim: false; kind: NonClaimKind; reason: string };

/**
 * Decide whether a sentence states something that could need evidence.
 * Questions, instructions, headings, bare citations, equation references,
 * transitions and statements about the manuscript itself are not claims.
 * This is a fast first pass; model extraction refines it, and the
 * researcher can override both.
 */
export function classifySentence(latex: string): SentenceKind {
  const raw = latex.trim();
  const text = normalizeClaimText(raw);
  const plain = text.replace(/\$[^$]*\$/g, 'X');
  if (/^\\(section|subsection|subsubsection|chapter|paragraph)\b/.test(raw)) return { claim: false, kind: 'heading', reason: 'a heading' };
  if (!plain.replace(/[\s.,;:()[\]]/g, '')) return { claim: false, kind: 'citation-only', reason: 'only citations or references' };
  if (/\?\s*$/.test(plain)) return { claim: false, kind: 'question', reason: 'a question' };
  if (/^(see|as shown in|as given (in|by))\s+(eq|equation|fig|figure|table|section|appendix)/i.test(plain) && plain.split(/\s+/).length < 9) return { claim: false, kind: 'equation-reference', reason: 'points to an equation or figure' };
  if (/^(note|recall|consider|see|cf\.?|let|suppose|assume that we|define)\b/i.test(plain) && !/\b(is|are|was|were|has|have)\b.*\b(shown|known|found|reported)\b/i.test(plain)) {
    return /^(let|suppose|define)\b/i.test(plain) ? { claim: false, kind: 'structural', reason: 'introduces notation' } : { claim: false, kind: 'instruction', reason: 'an instruction to the reader' };
  }
  if (/^(in|throughout) (this|the (present|following|next|previous)) (section|chapter|paper|work|article|appendix)\b|^(the )?(rest|remainder) of (this|the) (paper|article|section)|^(this|the present) (paper|article|work|section) (is organi[sz]ed|proceeds|is structured)|^we (now )?(turn|proceed|begin|start|conclude|summari[sz]e)\b|^(finally|next|first|second|third|in summary|to summari[sz]e|in conclusion),? we (discuss|present|describe|turn)\b/i.test(plain)) {
    return { claim: false, kind: 'transition', reason: 'describes the structure of the manuscript' };
  }
  if (plain.split(/\s+/).filter((w) => /[\p{L}]/u.test(w)).length < 4) return { claim: false, kind: 'connective', reason: 'too short to state a proposition' };
  return { claim: true };
}

const RULES: [BuiltInClaimType, RegExp][] = [
  ['definition', /\b(is|are) (defined|called|termed|referred to) as\b|\bwe (define|call|denote|refer to)\b|\bdenotes?\b|\bis known as\b|:=|\\coloneqq/i],
  ['assumption', /\bwe assume\b|\bassuming\b|\bunder the assumption\b|\bis assumed\b/i],
  ['hypothesis', /\bwe (hypothesi[sz]e|conjecture|expect|propose that)\b|\bhypothesis\b|\bconjecture\b/i],
  ['mathematical', /\b(theorem|lemma|corollary|proposition|identity|holds for all|for all|equals|is equal to|is bounded by|converges to|is proportional to)\b|\$[^$]*[=<>≤≥∝][^$]*\$/i],
  ['historical', /\b(first|originally|initially) (proposed|introduced|demonstrated|observed|described|discovered)\b|\b(in|since|by) (1[5-9]|20)\d\d\b|\bhistorically\b|\bwas introduced by\b/i],
  ['comparative', /\b(more|less|better|worse|higher|lower|faster|slower|larger|smaller|greater|fewer) than\b|\boutperform|\bcompared (to|with)\b|\bexceeds?\b|\bsuperior to\b|\binferior to\b/i],
  ['causal', /\b(causes?|caused by|leads? to|results? in|due to|because of|gives rise to|induces?|drives?|is responsible for)\b/i],
  ['quantitative', /\d+(?:[.,]\d+)?\s*(%|\\%|percent|[a-zA-Zµμ]{1,4}\b)|\b\d+(?:\.\d+)?\b/],
  ['methodological', /\bwe (use|employ|apply|simulate|measure|compute|implement|train|fit|perform|adopt|follow)\b|\b(is|are|was|were) (measured|computed|simulated|estimated|obtained|calibrated) (using|with|by)\b/i],
  ['interpretive', /\b(suggests?|indicates?|implies|imply|we interpret|can be interpreted|points to|is consistent with|appears? to|seems? to)\b/i],
  ['empirical', /\b(observed|measured|experiments?|experimental(ly)?|data show|we find|was found|were found|reported|demonstrated)\b/i],
  ['theoretical', /\b(predicts?|predicted|theory|theoretical(ly)?|in principle|model(s)? (predict|show)|framework)\b/i],
];

/** A first guess at the claim type (the model and the researcher can change it). */
export function guessClaimType(latex: string): BuiltInClaimType {
  const text = normalizeClaimText(latex);
  for (const [type, re] of RULES) if (re.test(text)) return type;
  return 'background';
}
