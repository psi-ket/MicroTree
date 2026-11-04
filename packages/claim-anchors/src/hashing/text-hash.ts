import { createHash } from 'node:crypto';

/**
 * Text normalisation for identity: LaTeX spacing (`~`, `\,`, `\ `) and
 * whitespace collapse to one space, Unicode NFC, lower case. Comments are
 * removed by the parser before this runs. Content (commands, math, citation
 * keys) is kept, so a changed citation or number changes the hash.
 */
export function normalizeForIdentity(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\\[,;:! ]|~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function identityHash(text: string): string {
  return createHash('sha256').update(normalizeForIdentity(text), 'utf8').digest('hex').slice(0, 32);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Words and numbers, for similarity (LaTeX command names are kept as tokens). */
export function tokens(text: string): string[] {
  return normalizeForIdentity(text).match(/\\?[\p{L}\p{N}]+(?:[.,]\d+)?/gu) ?? [];
}

function counts(xs: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function intersection(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [k, v] of a) n += Math.min(v, b.get(k) ?? 0);
  return n;
}

/** Sørensen–Dice coefficient over token multisets (0 to 1). */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  return (2 * intersection(counts(ta), counts(tb))) / (ta.length + tb.length);
}

/** Share of `part`'s tokens found in `whole` (1 when `part` is contained). */
export function containment(part: string, whole: string): number {
  const tp = tokens(part);
  if (!tp.length) return 0;
  return intersection(counts(tp), counts(tokens(whole))) / tp.length;
}
