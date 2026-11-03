/**
 * Ranking metrics for the retrieval evaluation set. They measure whether the
 * labelled passages were retrieved and where; they say nothing about whether
 * a passage is scientifically correct.
 */

/** Share of relevant items found in the first k results. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (!relevant.size) return 0;
  let found = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) found++;
  return found / relevant.size;
}

/** 1 / rank of the first relevant result (0 when none is found). */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const i = ranked.findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** nDCG@k with graded relevance (gain 2^rel − 1, log2 discount). */
export function ndcgAtK(ranked: readonly string[], gains: ReadonlyMap<string, number>, k: number): number {
  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + (2 ** (gains.get(id) ?? 0) - 1) / Math.log2(i + 2), 0);
  const ideal = [...gains.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export interface EvalQuery {
  id: string;
  query: string;
  /** Relevant passage keys with graded relevance (1 = relevant, 2 = highly relevant). */
  relevant: Record<string, number>;
}

export interface EvalSummary {
  queries: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  perQuery: { id: string; recallAt5: number; recallAt10: number; rr: number; ndcgAt10: number }[];
}

export async function evaluate(queries: readonly EvalQuery[], search: (q: string) => Promise<string[]>): Promise<EvalSummary> {
  const perQuery: EvalSummary['perQuery'] = [];
  for (const q of queries) {
    const ranked = await search(q.query);
    const gains = new Map(Object.entries(q.relevant));
    const rel = new Set(gains.keys());
    perQuery.push({ id: q.id, recallAt5: recallAtK(ranked, rel, 5), recallAt10: recallAtK(ranked, rel, 10), rr: reciprocalRank(ranked, rel), ndcgAt10: ndcgAtK(ranked, gains, 10) });
  }
  const mean = (f: (x: EvalSummary['perQuery'][number]) => number) => (perQuery.length ? perQuery.reduce((s, x) => s + f(x), 0) / perQuery.length : 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    queries: perQuery.length,
    recallAt5: round(mean((x) => x.recallAt5)),
    recallAt10: round(mean((x) => x.recallAt10)),
    mrr: round(mean((x) => x.rr)),
    ndcgAt10: round(mean((x) => x.ndcgAt10)),
    perQuery,
  };
}
