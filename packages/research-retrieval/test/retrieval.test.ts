import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmbeddingError,
  EmbeddingIndexer,
  HybridSearchEngine,
  KeywordIndex,
  parseQuery,
  reciprocalRankFusion,
  SqliteVectorStore,
  sweepIndexes,
  toFtsExpression,
  type PassageFilter,
} from '../src';
import { HashEmbeddingProvider, testDb } from './fixtures/db';

let db: ReturnType<typeof testDb>;
let keyword: KeywordIndex;
const all: PassageFilter = { extractionIds: null, kinds: ['abstract', 'body', 'caption', 'formula'], sectionTypes: [] };

const CORPUS = [
  { text: 'The Lindblad master equation describes open quantum systems with dissipation.', section: '2 Model', sectionType: 'background' as const },
  { text: 'Bosonic codes such as cat codes and GKP codes encode a qubit in an oscillator.', section: '1 Introduction', sectionType: 'introduction' as const },
  { text: 'Majorana zero modes appear at the ends of topological superconducting wires.', section: '3 Results', sectionType: 'results' as const },
  { text: 'Tensor networks approximate ground states of local Hamiltonians efficiently.', section: '4 Methods', sectionType: 'methods' as const },
  { text: 'Hamiltonian simulation on qubit-level hardware needs Trotter steps; the H_2 molecule is a standard test.', section: '4 Methods', sectionType: 'methods' as const },
  { text: 'The decay rate ψ(t) obeys ψ ∝ e^{-κt}.', section: '2 Model', sectionType: 'background' as const, kind: 'formula' as const },
  { text: 'P. W. Shor, Phys. Rev. A 52, R2493 (1995), doi:10.1103/PhysRevA.52.R2493.', section: 'References', sectionType: 'references' as const, kind: 'reference' as const },
];

beforeEach(() => {
  db = testDb();
  keyword = new KeywordIndex(db.sqlite);
});
afterEach(() => db.close());

function seed() {
  const paper = db.addPaper(CORPUS);
  keyword.indexExtraction(paper.extractionId);
  return paper;
}

describe('query parsing', () => {
  it('keeps the original, reads phrases, operators, exclusions and fields', () => {
    const q = parseQuery('"Lindblad master equation" OR decoherence -classical section:methods');
    expect(q.original).toBe('"Lindblad master equation" OR decoherence -classical section:methods');
    expect(q.clauses).toEqual([
      { kind: 'phrase', text: 'lindblad master equation', op: 'AND' },
      { kind: 'term', text: 'decoherence', op: 'OR' },
    ]);
    expect(q.excluded).toEqual(['classical']);
    expect(q.sections).toEqual(['methods']);
    expect(q.semanticText).toBe('Lindblad master equation decoherence');
    expect(toFtsExpression(q)).toBe('("lindblad master equation" OR "decoherence") NOT ("classical")');
  });

  it('recognises DOIs and arXiv identifiers', () => {
    expect(parseQuery('10.1103/PhysRevA.52.R2493').doi).toBe('10.1103/physreva.52.r2493');
    expect(parseQuery('https://doi.org/10.1103/PhysRevA.52.R2493').doi).toBe('10.1103/physreva.52.r2493');
    expect(parseQuery('arXiv:1706.03762v5').arxivId).toBe('1706.03762');
    expect(parseQuery('1706.03762').arxivId).toBe('1706.03762');
    expect(parseQuery('section:nonsense x').notes).toContain('Unknown section "nonsense" was ignored.');
  });

  it('neutralises FTS syntax typed by the user', () => {
    const q = parseQuery('body:NEAR(a b) "x"" OR y" *');
    const expr = toFtsExpression(q)!;
    expect(expr.startsWith('"')).toBe(true);
    expect(() => keyword.search(q, all, 10)).not.toThrow();
  });
});

describe('keyword retrieval', () => {
  it('finds exact phrases, multiple terms and Boolean combinations', () => {
    const { passageIds } = seed();
    const ids = (q: string) => keyword.search(parseQuery(q), all, 10).map((h) => h.passageId);
    expect(ids('"Lindblad master equation"')).toEqual([passageIds[0]]);
    expect(ids('"master Lindblad equation"')).toEqual([]);
    expect(ids('bosonic codes')).toEqual([passageIds[1]]);
    expect(ids('majorana OR tensor').sort()).toEqual([passageIds[2], passageIds[3]].sort());
    expect(ids('hamiltonian -simulation')).toEqual([passageIds[3]]);
    expect(ids('quantum error correction')).toEqual([]);
  });

  it('matches scientific notation: Greek letters, subscripts, hyphenated terms, case', () => {
    const { passageIds } = seed();
    const ids = (q: string) => keyword.search(parseQuery(q), all, 10).map((h) => h.passageId);
    expect(ids('ψ')).toEqual([passageIds[5]]);
    expect(ids('H_2')).toEqual([passageIds[4]]);
    expect(ids('qubit-level')).toEqual([passageIds[4]]);
    expect(ids('"qubit level"')).toEqual([passageIds[4]]);
    expect(ids('GKP')).toEqual([passageIds[1]]);
    // Porter stemming: the plural matches the singular and the other way round.
    expect(ids('Hamiltonians').sort()).toEqual([passageIds[3], passageIds[4]].sort());
    expect(ids('bosonic code')).toEqual([passageIds[1]]);
  });

  it('restricts by section type, paper and kind, and excludes references by default', () => {
    const a = seed();
    const b = db.addPaper([{ text: 'Tensor networks again, in another paper.', section: '1 Intro', sectionType: 'introduction' }]);
    keyword.indexExtraction(b.extractionId);
    expect(keyword.search(parseQuery('tensor'), all, 10)).toHaveLength(2);
    expect(keyword.search(parseQuery('tensor'), { ...all, extractionIds: [b.extractionId] }, 10).map((h) => h.passageId)).toEqual(b.passageIds);
    expect(keyword.search(parseQuery('tensor'), { ...all, sectionTypes: ['methods'] }, 10).map((h) => h.passageId)).toEqual([a.passageIds[3]]);
    expect(keyword.search(parseQuery('shor'), all, 10)).toEqual([]);
    expect(keyword.search(parseQuery('shor'), { ...all, kinds: ['reference'] }, 10).map((h) => h.passageId)).toEqual([a.passageIds[6]]);
    expect(keyword.search(parseQuery('"10.1103 physreva.52.r2493"'), { ...all, kinds: ['reference'] }, 10)).toHaveLength(1);
  });

  it('ignores inactive extractions and forgets deleted ones', () => {
    const p = seed();
    db.sqlite.prepare('UPDATE document_extractions SET is_active = 0 WHERE id = ?').run(p.extractionId);
    expect(keyword.search(parseQuery('tensor'), all, 10)).toEqual([]);
    db.sqlite.prepare('UPDATE document_extractions SET is_active = 1 WHERE id = ?').run(p.extractionId);
    db.sqlite.prepare('DELETE FROM document_extractions WHERE id = ?').run(p.extractionId);
    expect(keyword.count()).toBe(0);
  });

  it('ranks deterministically', () => {
    const a = db.addPaper([{ text: 'qubit qubit' }, { text: 'qubit qubit' }, { text: 'qubit' }]);
    keyword.indexExtraction(a.extractionId);
    const first = keyword.search(parseQuery('qubit'), all, 10);
    expect(first.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(keyword.search(parseQuery('qubit'), all, 10)).toEqual(first);
    expect(first[2]!.passageId).toBe(a.passageIds[2]);
  });
});

describe('vector store and embeddings', () => {
  it('embeds passages in batches, reuses the cache and validates dimensions', async () => {
    const { extractionId } = seed();
    const vectors = new SqliteVectorStore(db.sqlite);
    const provider = new HashEmbeddingProvider(32);
    const space = vectors.ensureSpace(await provider.getModelInfo());
    const indexer = new EmbeddingIndexer(db.sqlite, vectors);
    const progress = await indexer.embedExtractions(space, provider, [extractionId], { batchSize: 2 });
    expect(progress).toMatchObject({ done: 6, total: 6, cached: 0 }); // references are not embedded
    expect(provider.calls.map((c) => c.length)).toEqual([2, 2, 2]);
    expect(vectors.indexedPassages(space.id)).toBe(6);
    // Same texts in a new extraction (a reprocess) come from the cache.
    const again = db.addPaper(CORPUS.slice(0, 2));
    const second = await indexer.embedExtractions(space, provider, [again.extractionId]);
    expect(second.cached).toBe(2);
    expect(provider.calls).toHaveLength(3);
    expect(() => vectors.putVectors(space.id, [{ textHash: 'x', vector: new Float32Array(31) }])).toThrow(EmbeddingError);
    expect(() => vectors.search(space.id, new Float32Array(16), all, 5)).toThrow(/dimensions/);
  });

  it('keeps embedding spaces apart and searches only the one asked for', async () => {
    const { extractionId, passageIds } = seed();
    const vectors = new SqliteVectorStore(db.sqlite);
    const indexer = new EmbeddingIndexer(db.sqlite, vectors);
    const small = new HashEmbeddingProvider(16, 'hash-16');
    const big = new HashEmbeddingProvider(64, 'hash-64');
    const s1 = vectors.ensureSpace(await small.getModelInfo());
    const s2 = vectors.ensureSpace(await big.getModelInfo());
    expect(s1.id).not.toBe(s2.id);
    expect(vectors.ensureSpace(await small.getModelInfo()).id).toBe(s1.id);
    await indexer.embedExtractions(s1, small, [extractionId]);
    expect(vectors.indexedPassages(s2.id)).toBe(0);
    const [q] = await big.embed(['tensor networks']);
    expect(vectors.search(s2.id, Float32Array.from(q!.vector), all, 5)).toEqual([]);
    await indexer.embedExtractions(s2, big, [extractionId]);
    const hits = vectors.search(s2.id, Float32Array.from(q!.vector.map((x) => x / Math.hypot(...q!.vector))), all, 3);
    expect(hits[0]!.passageId).toBe(passageIds[3]);
  });

  it('drops vector links with the extraction and sweeps unused cached vectors', async () => {
    const { extractionId } = seed();
    const vectors = new SqliteVectorStore(db.sqlite);
    const provider = new HashEmbeddingProvider(16);
    const space = vectors.ensureSpace(await provider.getModelInfo());
    await new EmbeddingIndexer(db.sqlite, vectors).embedExtractions(space, provider, [extractionId]);
    db.sqlite.prepare('DELETE FROM document_extractions WHERE id = ?').run(extractionId);
    vectors.invalidate();
    expect(vectors.indexedPassages(space.id)).toBe(0);
    expect(sweepIndexes(db.sqlite, vectors).vectorsRemoved).toBe(6);
  });

  it('stops between batches when cancelled', async () => {
    const { extractionId } = seed();
    const vectors = new SqliteVectorStore(db.sqlite);
    const provider = new HashEmbeddingProvider(16);
    const space = vectors.ensureSpace(await provider.getModelInfo());
    const ac = new AbortController();
    const p = new EmbeddingIndexer(db.sqlite, vectors).embedExtractions(space, provider, [extractionId], {
      batchSize: 1,
      signal: ac.signal,
      onProgress: (x) => x.done === 2 && ac.abort(),
    });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(vectors.indexedPassages(space.id)).toBe(2);
  });
});

describe('reciprocal rank fusion', () => {
  it('computes Σ w/(k+rank), keeps component ranks and breaks ties reproducibly', () => {
    const kw = [
      { passageId: 'a', extractionId: 'x', rank: 1, score: 9 },
      { passageId: 'b', extractionId: 'x', rank: 2, score: 5 },
    ];
    const sem = [
      { passageId: 'b', extractionId: 'x', rank: 1, score: 0.9 },
      { passageId: 'c', extractionId: 'x', rank: 2, score: 0.8 },
    ];
    const fused = reciprocalRankFusion(kw, sem);
    expect(fused.map((f) => f.passageId)).toEqual(['b', 'a', 'c']);
    expect(fused[0]).toMatchObject({ keywordRank: 2, semanticRank: 1, matchedBy: 'hybrid', score: 1 / 62 + 1 / 61 });
    expect(fused[1]).toMatchObject({ keywordRank: 1, semanticRank: null, matchedBy: 'keyword', score: 1 / 61 });
    expect(fused[2]).toMatchObject({ matchedBy: 'semantic', score: 1 / 62 });
    const keywordOnly = reciprocalRankFusion(kw, sem, { k: 60, keywordWeight: 1, semanticWeight: 0 });
    expect(keywordOnly.map((f) => f.passageId)).toEqual(['a', 'b', 'c']);
    expect(reciprocalRankFusion(kw, sem, { k: 1, keywordWeight: 1, semanticWeight: 1 })[0]!.score).toBe(1 / 3 + 1 / 2);
    // Equal scores: better keyword rank wins, then passage ID.
    const tie = reciprocalRankFusion([{ passageId: 'z', extractionId: 'x', rank: 1, score: 1 }], [{ passageId: 'y', extractionId: 'x', rank: 1, score: 1 }]);
    expect(tie.map((t) => t.passageId)).toEqual(['z', 'y']);
  });
});

describe('hybrid search engine', () => {
  async function setup() {
    const p = seed();
    const vectors = new SqliteVectorStore(db.sqlite);
    const provider = new HashEmbeddingProvider(64);
    const space = vectors.ensureSpace(await provider.getModelInfo());
    await new EmbeddingIndexer(db.sqlite, vectors).embedExtractions(space, provider, [p.extractionId]);
    return { p, engine: new HybridSearchEngine(db.sqlite, vectors), semantic: { space, provider } };
  }

  it('runs keyword, semantic and hybrid modes and reports the method per result', async () => {
    const { p, engine, semantic } = await setup();
    const base = { filter: { extractionIds: null }, limit: 5, offset: 0 };
    const kw = await engine.search({ ...base, query: 'tensor networks', mode: 'keyword' }, semantic);
    expect(kw.results.map((r) => [r.passageId, r.matchedBy])).toEqual([[p.passageIds[3], 'keyword']]);
    const sem = await engine.search({ ...base, query: 'tensor networks', mode: 'semantic' }, semantic);
    expect(sem.results[0]).toMatchObject({ passageId: p.passageIds[3], matchedBy: 'semantic', keywordRank: null });
    const hy = await engine.search({ ...base, query: 'tensor networks', mode: 'hybrid' }, semantic);
    expect(hy.results[0]).toMatchObject({ passageId: p.passageIds[3], matchedBy: 'hybrid', keywordRank: 1, semanticRank: 1, position: 1 });
    expect(hy.semantic.used).toBe(true);
  });

  it('reports a missing embedding index instead of silently returning keyword results as hybrid', async () => {
    const { engine } = await setup();
    const r = await engine.search({ query: 'tensor networks', mode: 'hybrid', filter: { extractionIds: null }, limit: 5, offset: 0 }, null);
    expect(r.semantic).toMatchObject({ used: false, reason: expect.stringContaining('No embedding index') });
    expect(r.results.every((x) => x.matchedBy === 'keyword')).toBe(true);
  });

  it('paginates without repeating results and relaxes all-words matching visibly', async () => {
    const { engine, semantic } = await setup();
    const page = (offset: number) => engine.search({ query: 'qubit OR tensor OR majorana OR lindblad OR hamiltonian', mode: 'keyword', filter: { extractionIds: null }, limit: 2, offset }, semantic);
    const [a, b, c] = await Promise.all([page(0), page(2), page(4)]);
    const ids = [...a.results, ...b.results, ...c.results].map((r) => r.passageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.total).toBe(5);
    const relaxed = await engine.search({ query: 'tensor dragon', mode: 'keyword', filter: { extractionIds: null }, limit: 5, offset: 0 }, semantic);
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.results).toHaveLength(1);
  });

  it('refuses query vectors of another size (a changed model) with a reindex hint', async () => {
    const { engine, semantic } = await setup();
    const other = { ...semantic, provider: new HashEmbeddingProvider(32) };
    const r = await engine.search({ query: 'tensor', mode: 'semantic', filter: { extractionIds: null }, limit: 5, offset: 0 }, other);
    expect(r.semantic.reason).toMatch(/reindex/);
    expect(r.results).toEqual([]);
  });

  it('returns nothing for an empty scope', async () => {
    const { engine, semantic } = await setup();
    const r = await engine.search({ query: 'tensor', mode: 'hybrid', filter: { extractionIds: [] }, limit: 5, offset: 0 }, semantic);
    expect(r.results).toEqual([]);
  });
});
