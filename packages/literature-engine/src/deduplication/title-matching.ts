import type { ScholarlySourceRecord } from '@research-studio/shared-types';
import { familyKey } from '../normalization/author-normalizer';
import { titleKey } from '../normalization/work-normalizer';

const NUMBERISH = /^(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/;

function bigrams(text: string): Map<string, number> {
  const s = text.replace(/ /g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient on character bigrams (0…1). */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  let overlap = 0;
  for (const n of A.values()) sizeA += n;
  for (const [g, n] of B) {
    sizeB += n;
    overlap += Math.min(n, A.get(g) ?? 0);
  }
  return sizeA + sizeB === 0 ? 0 : (2 * overlap) / (sizeA + sizeB);
}

function numberTokens(key: string): string {
  return key
    .split(' ')
    .filter((t) => NUMBERISH.test(t))
    .sort()
    .join(' ');
}

/**
 * Titles match when their comparison keys are equal, or nearly equal
 * (Dice ≥ 0.95, similar length) with exactly the same numbers and numerals,
 * so "Part I" never matches "Part II" and "… in 2019" never matches "… in 2020".
 */
export function titlesMatch(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length < 20 || kb.length < 20) return false;
  if (Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length) < 0.9) return false;
  if (numberTokens(ka) !== numberTokens(kb)) return false;
  return diceSimilarity(ka, kb) >= 0.95;
}

/**
 * Authors are compatible when both records list authors and either the first
 * authors' family names agree or at least half of the shorter list's family
 * names appear in the other. Records without authors never match on title.
 */
export function authorsCompatible(a: ScholarlySourceRecord, b: ScholarlySourceRecord): boolean {
  const fa = a.authors.map(familyKey).filter((k): k is string => !!k);
  const fb = b.authors.map(familyKey).filter((k): k is string => !!k);
  if (!fa.length || !fb.length) return false;
  if (fa[0] === fb[0]) return true;
  const setB = new Set(fb);
  const shared = fa.filter((k) => setB.has(k)).length;
  return shared >= Math.ceil(Math.min(fa.length, fb.length) / 2);
}

/** Publication years within one year of each other (online vs print, preprint vs version of record); unknown years do not block. */
export function yearsCompatible(a: ScholarlySourceRecord, b: ScholarlySourceRecord): boolean {
  if (a.publicationYear === null || b.publicationYear === null) return true;
  return Math.abs(a.publicationYear - b.publicationYear) <= 1;
}

/** Title, authors and year all agree: the only non-identifier evidence that two records are one work. */
export function sameWorkByMetadata(a: ScholarlySourceRecord, b: ScholarlySourceRecord): boolean {
  return titlesMatch(a.title, b.title) && authorsCompatible(a, b) && yearsCompatible(a, b);
}
