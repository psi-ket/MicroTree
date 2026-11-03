import { describe, expect, it } from 'vitest';
import { ndcgAtK, recallAtK, reciprocalRank, SqliteVectorStore } from '../src';
import { runEvaluation } from './eval/harness';
import { HashEmbeddingProvider, testDb } from './fixtures/db';

describe('retrieval metrics', () => {
  it('computes Recall@k, reciprocal rank and nDCG@k', () => {
    const ranked = ['x', 'a', 'y', 'b'];
    const rel = new Set(['a', 'b', 'c']);
    expect(recallAtK(ranked, rel, 2)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, rel, 10)).toBeCloseTo(2 / 3);
    expect(reciprocalRank(ranked, rel)).toBe(0.5);
    expect(reciprocalRank(['x'], rel)).toBe(0);
    const gains = new Map([
      ['a', 2],
      ['b', 1],
    ]);
    // DCG = 3/log2(3) + 1/log2(5); IDCG = 3/1 + 1/log2(3)
    expect(ndcgAtK(ranked, gains, 10)).toBeCloseTo((3 / Math.log2(3) + 1 / Math.log2(5)) / (3 + 1 / Math.log2(3)), 9);
    expect(ndcgAtK(['a', 'b'], gains, 10)).toBe(1);
    expect(ndcgAtK([], new Map(), 10)).toBe(0);
  });
});

describe('labelled evaluation set', () => {
  it('keyword search stays above the recorded baseline', async () => {
    const { keyword } = await runEvaluation(null, ['keyword']);
    // Baseline recorded on 2026-11-03 (docs/RETRIEVAL_EVALUATION.md). A drop means a regression in parsing, normalisation or ranking.
    expect(keyword!.recallAt10).toBeGreaterThanOrEqual(0.65);
    expect(keyword!.mrr).toBeGreaterThanOrEqual(0.95);
  });

  it('hybrid fusion is at least as good as keyword search with the lexical test embedder', async () => {
    const r = await runEvaluation(new HashEmbeddingProvider(256), ['keyword', 'semantic', 'hybrid']);
    expect(r.hybrid!.recallAt10).toBeGreaterThanOrEqual(r.keyword!.recallAt10);
    console.info(
      Object.entries(r)
        .map(([m, s]) => `${m}: R@5 ${s.recallAt5} R@10 ${s.recallAt10} MRR ${s.mrr} nDCG@10 ${s.ndcgAt10}`)
        .join('\n'),
    );
  });
});

describe.skipIf(!process.env.RS_BENCH)('vector scan benchmark (RS_BENCH=1)', () => {
  it('searches 20 000 passages of 768 dimensions', async () => {
    const db = testDb();
    const n = 20_000;
    const d = 768;
    const { extractionId, passageIds } = db.addPaper(Array.from({ length: n }, (_, i) => ({ text: `passage ${i}` })));
    const store = new SqliteVectorStore(db.sqlite);
    const space = store.ensureSpace({ provider: 'bench', model: 'random', dimensions: d });
    const rand = () => {
      const v = new Float32Array(d);
      for (let i = 0; i < d; i++) v[i] = Math.random() - 0.5;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    };
    store.putVectors(space.id, passageIds.map((id) => ({ textHash: id, vector: rand() })));
    store.link(space.id, passageIds.map((id) => ({ passageId: id, extractionId, textHash: id })));
    const filter = { extractionIds: null, kinds: ['body' as const], sectionTypes: [] };
    let t = performance.now();
    store.search(space.id, rand(), filter, 50);
    const cold = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 10; i++) store.search(space.id, rand(), filter, 50);
    const warm = (performance.now() - t) / 10;
    console.info(`vector scan: ${n} × ${d}: first query ${cold.toFixed(0)} ms (loads vectors), then ${warm.toFixed(1)} ms per query`);
    expect(warm).toBeLessThan(1000);
    db.close();
  }, 120_000);
});
