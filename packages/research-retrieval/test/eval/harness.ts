import { HybridSearchEngine, EmbeddingIndexer, SqliteVectorStore, evaluate, type EmbeddingProvider, type EvalSummary, type SearchMode } from '../../src';
import { testDb } from '../fixtures/db';
import { EVAL_PASSAGES, EVAL_QUERIES } from './dataset';

/** Build the evaluation corpus (one extraction per fictional paper) and run every query in the given modes. */
export async function runEvaluation(provider: EmbeddingProvider | null, modes: SearchMode[]): Promise<Record<string, EvalSummary>> {
  const db = testDb();
  try {
    const keyOf = new Map<string, string>();
    const extractions: string[] = [];
    for (const paper of [...new Set(EVAL_PASSAGES.map((p) => p.paper))]) {
      const passages = EVAL_PASSAGES.filter((p) => p.paper === paper);
      const { extractionId, passageIds } = db.addPaper(passages.map((p) => ({ text: p.text, section: p.section, sectionType: p.sectionType, kind: p.sectionType === 'abstract' ? 'abstract' : 'body' })));
      passageIds.forEach((id, i) => keyOf.set(id, passages[i]!.key));
      extractions.push(extractionId);
    }
    const vectors = new SqliteVectorStore(db.sqlite);
    const engine = new HybridSearchEngine(db.sqlite, vectors);
    for (const x of extractions) engine.keyword.indexExtraction(x);
    let semantic = null;
    if (provider) {
      const space = vectors.ensureSpace(await provider.getModelInfo());
      await new EmbeddingIndexer(db.sqlite, vectors).embedExtractions(space, provider, extractions);
      semantic = { space, provider };
    }
    const out: Record<string, EvalSummary> = {};
    for (const mode of modes) {
      out[mode] = await evaluate(EVAL_QUERIES, async (query) => {
        const r = await engine.search({ query, mode, filter: { extractionIds: null }, limit: 10, offset: 0 }, semantic);
        return r.results.map((x) => keyOf.get(x.passageId)!);
      });
    }
    return out;
  } finally {
    db.close();
  }
}
