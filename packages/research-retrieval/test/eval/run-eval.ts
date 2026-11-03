/**
 * Retrieval evaluation: `pnpm --filter @research-studio/research-retrieval eval`.
 *
 * Without settings it runs keyword search only. With a local Ollama model it
 * also runs semantic and hybrid search:
 *
 *   RS_EVAL_OLLAMA_URL=http://127.0.0.1:11434 RS_EVAL_MODEL=nomic-embed-text pnpm --filter @research-studio/research-retrieval eval
 */
import { OllamaEmbeddingProvider } from '../../src';
import { runEvaluation } from './harness';

const url = process.env.RS_EVAL_OLLAMA_URL;
const model = process.env.RS_EVAL_MODEL;
const provider = url && model ? new OllamaEmbeddingProvider({ baseUrl: url, model }) : null;
const results = await runEvaluation(provider, provider ? ['keyword', 'semantic', 'hybrid'] : ['keyword']);
for (const [mode, s] of Object.entries(results)) {
  console.info(`${mode.padEnd(9)} Recall@5 ${s.recallAt5.toFixed(3)}  Recall@10 ${s.recallAt10.toFixed(3)}  MRR ${s.mrr.toFixed(3)}  nDCG@10 ${s.ndcgAt10.toFixed(3)}  (${s.queries} queries)`);
}
