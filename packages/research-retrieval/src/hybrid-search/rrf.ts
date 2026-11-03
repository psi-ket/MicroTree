import type { RankedHit } from '../keyword-search/keyword-index';

export interface FusionOptions {
  /** RRF constant; 60 is the value from Cormack et al. (2009). */
  k: number;
  keywordWeight: number;
  semanticWeight: number;
}

export const DEFAULT_FUSION: FusionOptions = { k: 60, keywordWeight: 1, semanticWeight: 1 };

export interface FusedHit {
  passageId: string;
  extractionId: string;
  /** Rank-fusion score: Σ wᵢ / (k + rankᵢ). Not a probability of relevance or correctness. */
  score: number;
  keywordRank: number | null;
  semanticRank: number | null;
  keywordScore: number | null;
  semanticScore: number | null;
  matchedBy: 'keyword' | 'semantic' | 'hybrid';
}

/**
 * Reciprocal Rank Fusion of a keyword and a semantic list. Component ranks
 * and scores are kept. Ties: better keyword rank, then better semantic rank,
 * then passage ID, so the order is reproducible.
 */
export function reciprocalRankFusion(keyword: readonly RankedHit[], semantic: readonly RankedHit[], options: FusionOptions = DEFAULT_FUSION): FusedHit[] {
  const byId = new Map<string, FusedHit>();
  const add = (h: RankedHit, which: 'keyword' | 'semantic') => {
    const cur =
      byId.get(h.passageId) ??
      ({ passageId: h.passageId, extractionId: h.extractionId, score: 0, keywordRank: null, semanticRank: null, keywordScore: null, semanticScore: null, matchedBy: which } as FusedHit);
    const weight = which === 'keyword' ? options.keywordWeight : options.semanticWeight;
    cur.score += weight / (options.k + h.rank);
    if (which === 'keyword') {
      cur.keywordRank = h.rank;
      cur.keywordScore = h.score;
    } else {
      cur.semanticRank = h.rank;
      cur.semanticScore = h.score;
    }
    cur.matchedBy = cur.keywordRank !== null && cur.semanticRank !== null ? 'hybrid' : which;
    byId.set(h.passageId, cur);
  };
  for (const h of keyword) add(h, 'keyword');
  for (const h of semantic) add(h, 'semantic');
  const inf = Number.POSITIVE_INFINITY;
  return [...byId.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.keywordRank ?? inf) - (b.keywordRank ?? inf) ||
      (a.semanticRank ?? inf) - (b.semanticRank ?? inf) ||
      (a.passageId < b.passageId ? -1 : a.passageId > b.passageId ? 1 : 0),
  );
}

/** A single list in the same result shape (keyword-only or semantic-only mode). */
export function singleList(hits: readonly RankedHit[], which: 'keyword' | 'semantic'): FusedHit[] {
  return hits.map((h) => ({
    passageId: h.passageId,
    extractionId: h.extractionId,
    score: h.score,
    keywordRank: which === 'keyword' ? h.rank : null,
    semanticRank: which === 'semantic' ? h.rank : null,
    keywordScore: which === 'keyword' ? h.score : null,
    semanticScore: which === 'semantic' ? h.score : null,
    matchedBy: which,
  }));
}
