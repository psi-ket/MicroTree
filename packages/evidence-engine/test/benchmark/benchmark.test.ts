import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelProviderKind } from '@research-studio/shared-types';
import { evaluateAnchors, evaluateAssessments, evaluateCitations, evaluateExtraction, evaluateQuoteValidation, evaluateRetrieval } from './harness';

/**
 * The M5 benchmark on the synthetic evaluation set. Deterministic parts run
 * in every test run and must stay above the recorded baselines; results are
 * written to latest-results.json (quoted in docs/EVIDENCE_EVALUATION.md).
 * Model assessment runs only with RS_EVIDENCE_LIVE=1 and a configured model.
 */
const results: Record<string, unknown> = { dataset: 'synthetic M5 set (see dataset.ts)', date: new Date().toISOString().slice(0, 10) };

describe('M5 benchmark (synthetic set)', () => {
  it('claim extraction and atomic segmentation (rules)', () => {
    const r = evaluateExtraction();
    results.extraction = r;
    expect(r.claimDetection.precision).toBeGreaterThanOrEqual(0.9);
    expect(r.claimDetection.recall).toBeGreaterThanOrEqual(0.9);
    expect(r.atomicSegmentation.exactMatch).toBeGreaterThanOrEqual(0.8);
  });

  it('passage retrieval Recall@5 and Recall@10', async () => {
    const keyword = await evaluateRetrieval(false);
    const hybrid = await evaluateRetrieval(true);
    results.retrieval = { keyword, hybrid };
    expect(keyword.recallAt10).toBeGreaterThanOrEqual(0.7);
  });

  it('citation recommendation given correct assessments', () => {
    const r = evaluateCitations();
    results.citations = r;
    expect(r.precision).toBe(1);
  });

  it('anchor reconciliation', () => {
    const r = evaluateAnchors();
    results.anchors = r;
    expect(r.unsafeErrors).toEqual([]);
    expect(r.accuracy).toBeGreaterThanOrEqual(0.8);
  });

  it('quotation validation', () => {
    const r = evaluateQuoteValidation();
    results.quotes = r;
    expect(r.genuineAccepted).toBe(1);
    expect(r.alteredRefused).toBeGreaterThanOrEqual(0.9);
  });

  it.runIf(process.env.RS_EVIDENCE_LIVE === '1')('evidence assessment with a real model (opt-in)', async () => {
    const { createModelProvider } = await import('@research-studio/model-adapters');
    const kind = (process.env.RS_EVIDENCE_KIND ?? 'ollama') as ModelProviderKind;
    const provider = createModelProvider(kind, { apiKey: process.env.RS_EVIDENCE_API_KEY ?? null, baseUrl: process.env.RS_EVIDENCE_BASE_URL ?? (kind === 'ollama' ? 'http://127.0.0.1:11434' : null), timeoutMs: 180_000, maxRetries: 1 });
    results.assessment = { model: process.env.RS_EVIDENCE_MODEL, ...(await evaluateAssessments({ provider, model: process.env.RS_EVIDENCE_MODEL ?? 'llama3.1' })) };
  }, 1_800_000);

  it('records the results', () => {
    results.assessment ??= { measured: false, reason: 'No model was configured (set RS_EVIDENCE_LIVE=1 and RS_EVIDENCE_MODEL).' };
    writeFileSync(fileURLToPath(new URL('./latest-results.json', import.meta.url)), `${JSON.stringify(results, null, 2)}\n`);
  });
});
