import type { PassageCandidate } from './types';

export interface RankedCandidate extends PassageCandidate {
  /** Rank after fusion over query variants (1 is first). Relevance, not support. */
  rank: number;
  fusedScore: number;
  /** Variants that returned it. */
  variants: string[];
  /** Grouped under an earlier passage of the same paper (not counted as an independent source). */
  samePaperAs: string | null;
}

/** Identity of a paper across levels: work, then item, then DOI, then title. */
export function paperKey(c: PassageCandidate): string {
  return c.scholarlyWorkId ?? c.libraryItemId ?? (c.paper.doi ? `doi:${c.paper.doi.toLowerCase()}` : null) ?? c.externalId ?? `title:${c.paper.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
}

export function candidateKey(c: PassageCandidate): string {
  return c.passageId ?? `${c.level}:${paperKey(c)}:${c.textHash ?? c.text.slice(0, 80)}`;
}

/**
 * Reciprocal rank fusion over the result lists of the query variants, then
 * diversity: at most `perPaper` passages of one paper among the results that
 * are shown as separate sources; further passages of that paper are kept but
 * grouped under its first one, so one paper never counts as several
 * independent sources. Abstract-level candidates follow full-text ones.
 */
export function fuseAndDiversify(lists: readonly { variant: string; results: readonly PassageCandidate[] }[], opts: { limit: number; perPaper: number; k?: number }): RankedCandidate[] {
  const k = opts.k ?? 60;
  const byKey = new Map<string, { c: PassageCandidate; score: number; variants: Set<string> }>();
  for (const list of lists) {
    list.results.forEach((c, i) => {
      const key = candidateKey(c);
      const entry = byKey.get(key) ?? { c, score: 0, variants: new Set<string>() };
      entry.score += 1 / (k + i + 1);
      entry.variants.add(list.variant);
      // Keep the best component ranks seen.
      entry.c = {
        ...entry.c,
        keywordRank: minRank(entry.c.keywordRank, c.keywordRank),
        semanticRank: minRank(entry.c.semanticRank, c.semanticRank),
        method: entry.c.method === c.method ? c.method : 'hybrid',
      };
      byKey.set(key, entry);
    });
  }
  const levelOrder = { full_text: 0, abstract: 1, external_abstract: 2 } as const;
  const sorted = [...byKey.values()].sort((a, b) => levelOrder[a.c.level] - levelOrder[b.c.level] || b.score - a.score || candidateKey(a.c).localeCompare(candidateKey(b.c)));
  const perPaper = new Map<string, { count: number; first: string }>();
  const shown: RankedCandidate[] = [];
  const grouped: RankedCandidate[] = [];
  for (const e of sorted) {
    const pk = paperKey(e.c);
    const seen = perPaper.get(pk);
    const item: RankedCandidate = { ...e.c, rank: 0, fusedScore: Math.round(e.score * 1e6) / 1e6, variants: [...e.variants].sort(), samePaperAs: seen ? seen.first : null };
    if (!seen) perPaper.set(pk, { count: 1, first: candidateKey(e.c) });
    else seen.count++;
    if (!seen || seen.count <= opts.perPaper) shown.push(item);
    else grouped.push(item);
  }
  return [...shown, ...grouped].slice(0, opts.limit).map((c, i) => ({ ...c, rank: i + 1 }));
}

function minRank(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
