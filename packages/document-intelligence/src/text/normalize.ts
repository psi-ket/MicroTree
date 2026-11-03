/**
 * Text normalisation for search. The original passage text is never changed;
 * these functions produce a separate search text.
 *
 * Kept on purpose: Greek letters (ψ, Ω), mathematical operators, subscripts
 * written as `H_2`, hyphenated terms (`qubit-level`), case-preserving
 * abbreviations are lower-cased only for matching. Changed: Unicode
 * compatibility forms are folded (NFKC: ligatures `ﬁ` → `fi`, full-width
 * forms, `²` → `2`), soft hyphens and zero-width characters are removed,
 * words hyphenated across line breaks are joined, and whitespace collapses.
 */

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const DASHES = /[‐‑‒–−]/g;

/** Repair "entan- glement" left by line-break hyphenation (lower-case continuation only). */
export function repairHyphenation(text: string): string {
  return text.replace(/(\p{L}{2,})-\s*\n\s*(\p{Ll}{2,})/gu, '$1$2');
}

/** Clean extracted text for display: invisible characters gone, whitespace collapsed. Case and symbols kept. */
export function cleanText(text: string): string {
  return repairHyphenation(text.replace(INVISIBLE, ''))
    .replace(/[ \t\f\v\r\n]+/g, ' ')
    .trim();
}

/** The text that is indexed and matched; never shown in place of the original. */
export function normalizeSearchText(text: string): string {
  return cleanText(text.normalize('NFKC'))
    .replace(DASHES, '-')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

/** A rough token count for budget decisions (no tokenizer needed). Conservative for sub-word tokenizers. */
export function estimateTokens(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const symbols = text.match(/[^\s\p{L}\p{N}]/gu)?.length ?? 0;
  return Math.ceil(words * 1.3 + symbols * 0.5);
}
