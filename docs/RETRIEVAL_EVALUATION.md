# Retrieval evaluation (M3.3)

## 1. Data

`packages/research-retrieval/test/eval/dataset.ts` holds 20 passages in 5
fictional papers (bosonic codes, open systems, Hamiltonian simulation,
topological phases, tensor networks) and 14 queries with graded relevance
(2 = answers the query, 1 = related). Every passage was written for this set;
no published text is included. Queries cover the brief's terms (quantum error
correction, bosonic codes, Lindblad master equation, Hamiltonian simulation,
topological phases, tensor networks, Majorana zero modes), an exact phrase,
an abbreviation (`GKP`), notation (`H_2`) and paraphrases that share few
words with the relevant passage.

## 2. Metrics

Recall@5 and Recall@10 (share of labelled passages in the first k), MRR
(reciprocal rank of the first relevant passage) and nDCG@10 (graded gain
2^rel − 1, log2 discount), in `research-retrieval/src/metrics`.

## 3. Results (2026-11-03)

| Method | Recall@5 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| Keyword (FTS5, Porter) | 0.679 | 0.679 | 1.000 | 0.839 |
| Keyword without stemming | 0.661 | 0.661 | 1.000 | 0.841 |
| Semantic, lexical test embedder* | 0.833 | 0.887 | 1.000 | 0.905 |
| Hybrid (RRF), lexical test embedder* | 0.833 | 0.887 | 1.000 | 0.932 |

\* The test embedder hashes words and character trigrams into 256
dimensions. It is lexical, not semantic: it shows that fusion works and
adds recall over strict all-words matching, not how a real embedding model
performs. **No real embedding model was evaluated here** (no Ollama in the
test environment). Run the evaluation with one:

```bash
RS_EVAL_OLLAMA_URL=http://127.0.0.1:11434 RS_EVAL_MODEL=nomic-embed-text pnpm --filter @research-studio/research-retrieval eval
```

The keyword baseline is enforced by a test (Recall@10 ≥ 0.65, MRR ≥ 0.95) so
regressions in parsing, normalisation or ranking are caught.

## 4. Limitations

- 20 passages and 14 queries are far too few to estimate quality on a real
  library; numbers this high reflect a small, clean, hand-written set.
- The relevance labels were written by the same author as the passages.
- Keyword recall is limited by all-words matching; paraphrased queries are
  exactly where semantic retrieval should help, and they are few here.
- The set has no PDFs: extraction quality (missing text, reading order,
  page mapping, box alignment) is tested separately with generated PDFs and
  in the browser, not measured here.
- **Retrieval metrics say nothing about scientific accuracy.** A highly
  ranked passage is a good match for the query, not a verified claim.

## 5. Extraction checks

Tested on generated PDFs rather than measured on a corpus: single page,
two columns with a full-width title, running heads and page numbers across
four pages, captions and references, rotated and cropped pages, A4 and
Letter, image-only (scan), empty, malformed, too many pages. GROBID output is
tested through a synthetic TEI document (sections and subsections, sentences
with boxes, display and inline formulas, figures, tables, references,
footnotes, acknowledgements, an appendix, a repeated paragraph). No real
paper and no real GROBID run were part of the verification (see the review,
`docs/reviews/m3.3-documents.md`).
