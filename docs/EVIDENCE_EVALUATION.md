# Evidence evaluation (M5)

## 1. Data

`packages/evidence-engine/test/benchmark/dataset.ts` is a synthetic set
written for this milestone and reviewed by hand. Every paper title starts
with "Synthetic" and every passage was written for the set. Nothing in it is
presented as real literature, and none of its sentences should be cited.

| Part | Size |
| --- | --- |
| Papers | 8 (surface codes, biased noise, Majorana modes, open systems, tensor networks, variational algorithms, cat qubits, history of codes) |
| Passages | 16 |
| Sentences | 25, of which 18 hold claims (covering 11 claim types) and 7 are non-claims (question, instruction, heading, citation only, equation reference, transition, connective) |
| Expected atomic claims | Given for each claim sentence, including compound sentences |
| Claim and passage pairs | 24. Each claim lists its relevant passages with the expected assessment (10 direct, 5 partial, 1 contradiction, 8 context), an explanation and limitations |
| Anchor cases | 12 edits of one paragraph (unchanged, minor wording, unrelated edit, number, negation, scope, hedge, citation added, paragraph split, reorder, deletion, merge) |

**Limits of the set.** It is small. It was written by the same team as the
rules it measures, and part of it was used to tune the claim type rules.
The rule-based numbers below are therefore in-sample and optimistic. A
held-out set written by someone else is needed before any of them are
quoted as general performance (see the M5 report, recommendations).

## 2. How to run

```bash
pnpm --filter @research-studio/evidence-engine bench
```

The deterministic parts run in every test run as part of the package's
tests and must stay above the recorded baselines. Results are written to
`packages/evidence-engine/test/benchmark/latest-results.json`.

Model assessment runs only when a model is configured.

```bash
RS_EVIDENCE_LIVE=1 RS_EVIDENCE_KIND=ollama RS_EVIDENCE_MODEL=llama3.1 pnpm --filter @research-studio/evidence-engine bench
```

`RS_EVIDENCE_BASE_URL` and `RS_EVIDENCE_API_KEY` select another provider.
These variables are only read by the benchmark, not by the app.

## 3. Results (2026-11-04)

### Claim extraction (rules, no model)

| Metric | Value |
| --- | --- |
| Claim detection precision | 1.000 (18 true positives, 0 false positives) |
| Claim detection recall | 1.000 (0 false negatives, 7 true negatives) |
| Atomic segmentation, exact match | 1.000 (18 claim sentences) |
| Claim type, first guess | 0.833 (15 of 18). It was 0.389 (7 of 18) before the rules were broadened with this set |

Detection and segmentation by category (all detected and segmented
correctly). Type guess per category: quantitative 3/3, comparative 2/2,
theoretical 2/4, empirical 1/2, and 1/1 for mathematical, methodological,
causal, historical, interpretive, definition and background. The misses are
"theoretical" sentences that the rules read as causal or background, and an
empirical result without an experiment word.

### Retrieval (M3.3 index through the evidence retriever)

17 claims with labelled passages, five query variants per claim, at most
two passages per paper.

| Mode | Recall@5 | Recall@10 | Supporting passages Recall@5 | Independent papers in top 5 |
| --- | --- | --- | --- | --- |
| Keyword | 1.000 | 1.000 | 1.000 | 2.71 |
| Hybrid, lexical test embedder* | 1.000 | 1.000 | 1.000 | 3.94 |

Recall is 1.000 in every category. With 16 passages this mostly shows that
the query variants and the per-paper limit do not lose the relevant
passages. It says little about ranking in a large library. The M3.3
retrieval evaluation ([RETRIEVAL_EVALUATION.md](RETRIEVAL_EVALUATION.md))
remains the measure of the index itself.

\* The test embedder hashes words and character trigrams. It is a stand-in
for tests, not a semantic model. The hybrid row shows the fused ranking
working, not semantic quality.

### Citation recommendation (given correct assessments)

| Metric | Value |
| --- | --- |
| Precision | 1.000 (14 recommendations) |
| Recall of supporting papers | 1.000 |

This measures the recommender's rules alone, fed with the expected
assessments. End-to-end citation precision depends on the model's
assessments (below).

### Anchor reconciliation

| Metric | Value |
| --- | --- |
| Agreement with the expected status | 0.833 (10 of 12) |
| Unsafe errors (a material change kept as current) | none |
| Conservative errors (marked for revalidation unnecessarily) | a2 minor wording ("local" to "nearby"), a12 two sentences merged |

`current` and `modified` count as agreeing, since both keep the evidence.
Both misses ask the researcher to revalidate when it was not strictly
needed. A wording change of a content word is treated as material on
purpose.

### Quotation validation

| Metric | Value |
| --- | --- |
| Genuine quotations accepted | 1.000 (16) |
| Altered quotations refused | 1.000 (16) |

The altered quotations change one word form or one quantifier. They are a
simple test of the check that turns invented support into `not_assessed`.

### Evidence assessment and conflicts (needs a model)

**Not measured.** No model was available in the build environment. The
harness (`evaluateAssessments`) reports precision and recall for direct
support, partial support, contradiction and context, and the full confusion
matrix, over the 24 labelled pairs (10 direct support, 5 partial support,
1 contradiction, 8 context). Conflict classification has no labelled
set yet.

## 4. Automated tests behind these numbers

| Area | Tests |
| --- | --- |
| Claim classifier, splitter, validator, extractor | `packages/evidence-engine/test/claims.test.ts` |
| Retrieval, assessment validation, status, conflicts, freshness | `packages/evidence-engine/test/evidence.test.ts` |
| Parsing, identities, reconciliation, materiality | `packages/claim-anchors/test` |
| Citation setup, keys, placement, recommendation | `packages/citation-intelligence/test` |
| Writing analysis, preservation, coverage | `packages/writing-intelligence/test` |
| Runtime API over real PDFs, privacy, jobs, proposals | `apps/runtime/test/evidence.test.ts` |
| Panel, review screen, consent | `apps/web/test/evidence.test.tsx`, `e2e/evidence.spec.ts` |
