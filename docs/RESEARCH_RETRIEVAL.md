# Research retrieval (M3.3)

Search across the full text of every processed paper, without any AI chat
model. Code: `packages/research-retrieval` (segmentation, embeddings, keyword
and vector search, fusion, query parsing, metrics) and the runtime's
`DocumentRuntime.search`. The package does not depend on extractors, the
library or literature providers; the runtime turns library filters into a
list of extraction IDs.

## 1. Passages

Segmentation is structure-aware (`segmentDocument`):

- paragraphs, lists, acknowledgements and footnotes accumulate in reading
  order **within one section** until the next would pass the target size;
  sections are never merged, and every passage keeps its section path, type,
  parent block and all its blocks;
- a block over the maximum is split at sentence boundaries, repeating whole
  sentences up to the overlap budget; such pieces use their sentences' boxes
  when every sentence has them, otherwise the block's boxes;
- display formulas and figure/table captions are passages of their own
  (`formula`, `caption`), the abstract is `abstract`, each bibliography
  entry is `reference` and is left out of body search unless asked for;
- titles and headings are not passages (headings are indexed as context).

| Setting | Default |
| --- | --- |
| target | 550 tokens (estimated) |
| maximum | 700 tokens |
| overlap | 75 tokens, whole sentences |

These are starting values, recorded in each extraction's configuration so a
change is visible as "out of date". Each passage stores its original text,
its normalised search text, a SHA-256 of the text and a **stable key**
(PDF hash, section path, text hash, occurrence), which stays the same across
reprocessing for unchanged passages. Sentence-to-passage links are kept for
the evidence work in M5.

## 2. Keyword search

SQLite FTS5 in the studio database (`passage_fts`), tokenizer
`porter unicode61 remove_diacritics 2 tokenchars '_'`:

- Porter stemming lets `codes` match `code` and `Hamiltonians` match
  `Hamiltonian` (measured on the evaluation set: Recall@10 0.679 with
  stemming, 0.661 without; nDCG@10 0.839 and 0.841);
- underscores stay inside tokens (`H_2`), hyphens split (`qubit-level`
  matches `"qubit level"`), Greek letters are tokens (`ψ`);
- operators and symbols such as `=` or `∝` are not tokens: they cannot be
  searched by keyword (semantic search may still find the passage);
- ranking is BM25 with the body weighted 1.0 and the section heading 0.4,
  ties broken by passage ID; only active extractions are searched.

Query syntax (nothing is rewritten silently; the original query is kept and
what was understood is shown):

| Input | Meaning |
| --- | --- |
| `bosonic codes` | all words |
| `"Lindblad master equation"` | exact phrase |
| `majorana OR tensor` | either |
| `-classical`, `NOT classical` | exclude |
| `section:methods` | restrict section type (also `results`, `introduction`, …, `references` searches bibliography entries) |
| `10.1103/…`, `doi:…`, `arXiv:1706.03762` | the paper with that identifier in your library |

Every word and phrase is quoted before it reaches FTS5, so FTS syntax typed
by the user has no effect. When no passage contains all words in keyword
mode, the search falls back to any word and **says so**.

## 3. Semantic search

When embeddings are turned on, passages of kinds `abstract`, `body`,
`caption` and `formula` are embedded with their section path as context.
Queries are embedded with the same model and compared by cosine similarity
with an exact scan over the active embedding space (vectors are unit length,
so a dot product is the cosine). See
[`EMBEDDING_PROVIDERS.md`](EMBEDDING_PROVIDERS.md).

**Vector storage.** Vectors are float32 BLOBs in SQLite
(`embedding_vectors`, keyed by space and input hash, which is also the
embedding cache), linked to passages in `passage_embeddings`. A space's
vectors are loaded into memory on the first query and dropped when the space
changes. Measured on this machine (Node 22): 20 000 passages of 768
dimensions take about 310 ms for the first query (loading) and 26 ms per
query afterwards (`RS_BENCH=1` in `research-retrieval/test/evaluation.test.ts`).
`sqlite-vec` was not chosen because it needs a native extension per platform
and is pre-1.0; `VectorStore` is an interface so an approximate index can
replace the scan later.

## 4. Hybrid ranking

Reciprocal Rank Fusion of the two lists (each cut at 100 candidates, or more
for deep pages):

```
score(p) = wk / (k + rank_keyword(p)) + ws / (k + rank_semantic(p)),  k = 60, wk = ws = 1
```

A passage found by one list gets only that term. Each result keeps its
keyword rank and score, its semantic rank and score, and `matchedBy`
(`keyword`, `semantic`, `hybrid`). Ties are broken by keyword rank, then
semantic rank, then passage ID, so the same index and query give the same
order. **The score orders results; it is not a probability that a passage is
relevant or correct**, and the interface says so. No reranker runs in M3.3;
`Reranker` is an extension point.

When no embedding index is active (or the configured model differs from the
index), hybrid mode returns keyword results and reports that semantic search
was not used.

## 5. Filters and scope

Scope: the whole library (archived papers excluded), selected collections,
or selected papers. Filters: author (matches any author name), year range,
venue, publication type, section types, and whether bibliography entries are
included. Author, year, venue and type use the corrected library record, not
the extracted header. Results come in pages (`limit` ≤ 50, `offset` ≤ 450).

## 6. Results and provenance

Each result is the exact passage text as extracted, with the paper (title,
authors, year, venue, identifiers), section path and type, pages, whether
boxes exist, and provenance: attachment, PDF SHA-256, extraction ID,
extractor and version, parser version, configuration hash, extraction time,
the attachment's source (upload, open access, Zotero) and URL, and the
license when the record lists one. Nothing is summarised. Retrieved text is
data, not instructions.

`GET /research/passages/:id` adds the neighbouring passages and the
sentences; `GET /research/passages/:id/location` gives the page, the boxes
and the page geometry for the viewer. `POST /research/search/passage` finds
passages similar to a passage in the active embedding space.

## 7. Index maintenance

Replacing or deleting an extraction deletes its passages; a trigger removes
their keyword rows and a foreign key their vector links. An hourly sweep
removes cached vectors no passage uses. The dashboard shows passages
indexed, the semantic index progress and the last indexing time.

## 8. Tests and evaluation

Unit and integration tests in `packages/research-retrieval/test` (chunking
rules, query parsing, FTS phrases, Boolean and notation, filters, deletion,
vector store isolation and validation, embedding cache and cancellation,
RRF arithmetic and ties, engine modes, pagination, model mismatch, Ollama
provider) and the evaluation in [`RETRIEVAL_EVALUATION.md`](RETRIEVAL_EVALUATION.md).

## 9. Use by the evidence engine (M5)

The evidence engine retrieves candidate evidence for a claim through this
search (`DocumentRuntime.search`), wrapped in a `LibrarySearchPort`.

- Up to five query variants per claim. The claim itself runs in hybrid mode,
  and its key terms, technical phrases and named entities run as keyword
  queries. Hedges and citations are removed, and numbers are kept.
- The lists are fused with reciprocal rank fusion (k = 60) and limited to two
  passages per paper by default.
- The keyword, semantic and fused ranks are stored on the evidence record,
  apart from any support judgement.
- `retrievalIndexVersion()` is now public. It is stored with every evidence
  record, so later index changes can be detected.
- Passage `stable_key` and `text_hash` are used by the freshness check. A
  passage found again with the same text after reprocessing is "moved" and
  keeps its assessments. Changed text makes them stale.

Details: [EVIDENCE_ENGINE.md](EVIDENCE_ENGINE.md) §2 and §5.
