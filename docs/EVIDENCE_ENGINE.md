# Evidence engine (M5)

The evidence engine links the scientific claims in a manuscript to passages in
the papers of the researcher's library. It finds candidate passages, asks a
model how each passage relates to the claim, checks the answer against the
passage text and keeps every result with its provenance. It never decides
whether a claim is true, never resolves a disagreement between sources and
never changes the manuscript without a reviewed proposal.

Related documents:

| Topic | Document |
| --- | --- |
| How claims are found and split | [CLAIM_EXTRACTION.md](CLAIM_EXTRACTION.md) |
| How a passage is judged against a claim | [EVIDENCE_ASSESSMENT.md](EVIDENCE_ASSESSMENT.md) |
| Citation recommendation and insertion | [CITATION_INTELLIGENCE.md](CITATION_INTELLIGENCE.md) |
| The writing assistant | [SCIENTIFIC_WRITING.md](SCIENTIFIC_WRITING.md) |
| Evidence Review Mode and coverage | [MANUSCRIPT_REVIEW.md](MANUSCRIPT_REVIEW.md) |
| Benchmark and results | [EVIDENCE_EVALUATION.md](EVIDENCE_EVALUATION.md) |

## 1. Packages

| Package | Role |
| --- | --- |
| `packages/claim-anchors` | Parses LaTeX into blocks and sentences, gives them stable identities and reconciles claim anchors after edits. No model, no database. |
| `packages/evidence-engine` | Claim extraction, evidence retrieval, assessment, conflict analysis, uncertainty, provenance and freshness. Talks to models through a narrow `ModelTarget` and to search through an `EvidenceSearchPort`. |
| `packages/citation-intelligence` | Citation setup detection, command choice, key resolution, insertion planning, recommendation and grouping. |
| `packages/writing-intelligence` | Style and structure analysis, the 29 writing operations, rewrite validation and coverage. |
| `apps/runtime/src/services/evidence-runtime.ts` | The facade that joins the packages to the database, the library, the M3.3 search index, the M2 proposal service, privacy, jobs and audit. |
| `apps/web/src/features/*` | `evidence-review`, `claim-analysis`, `citation-intelligence`, `scientific-writing` and `manuscript-review`. |

The pure packages hold no state and can be tested without a runtime. The
runtime owns persistence, permissions and model access.

## 2. Flow for one claim

1. **Sync.** The project's `.tex` files are parsed (following `\input` and
   `\include`) into blocks and sentences. A revision row records the file
   hashes. Unchanged text keeps its identity across syncs.
2. **Extract.** Sentences in the requested scope (a selection, a section or
   the manuscript) are classified. Claims are split into atomic claims and
   stored as `proposed`. Nothing is written to the `.tex` files.
3. **Retrieve.** Up to five query variants are built from the claim and run
   through the M3.3 hybrid search over the project's library papers (or a
   chosen collection or set of papers). Stored abstracts of papers without
   full text can be added, and so can M3.1 search results when the researcher
   asks for them. Results are fused with reciprocal rank fusion (k = 60) and
   limited to two passages per paper so that one paper cannot fill the list.
4. **Record.** Each candidate becomes an `evidence_record` linked to an
   `evidence_source`, a snapshot of the passage text with its hash, location,
   extractor version and index version. The relevance ranks are stored on the
   record and kept separate from any support judgement.
5. **Assess.** On request, a model judges each record against the claim with
   a strict schema. The validator checks that quoted excerpts occur in the
   passage. The result is a new `evidence_assessment` row. Earlier rows become
   `superseded`, never deleted.
6. **Review.** The researcher accepts, rejects, reclassifies or excludes. This
   is stored in `evidence_reviews`, separately from the AI rows.
7. **Status.** The claim's status is derived from its current assessments and
   reviews (see [EVIDENCE_ASSESSMENT.md](EVIDENCE_ASSESSMENT.md) §5). It is a
   filter, not a verdict, and the individual assessments are always shown.

## 3. Evidence levels

| Level | Meaning | Shown as |
| --- | --- | --- |
| `full_text` | A passage from an extracted PDF in the library (M3.3) | Section, page and the highlighted passage in the PDF viewer |
| `abstract` | The stored abstract of a library paper without full text | "Abstract only" badge and an explicit limitation |
| `external_abstract` | An abstract from an M3.1 provider, not in the library | "Abstract only, not in your library" |

Abstract-level evidence can never produce `direct_support` with low
uncertainty. The validator raises its uncertainty and adds a limitation (see
[EVIDENCE_ASSESSMENT.md](EVIDENCE_ASSESSMENT.md) §3).

## 4. Provenance

Every evidence source stores:

- the library item, scholarly work and attachment (set to null if those are
  later deleted, so the snapshot survives),
- the extraction, passage, `stable_key` and `text_hash` from M3.3,
- section path, section type, pages and coordinates for highlighting,
- the source file's SHA-256 and the extractor version,
- the exact passage text, and a `snapshot_hash` over all of the above,
- the retrieval method, query variant and index version on the record.

Deleting a library item or a PDF does not delete the evidence that was taken
from it. The source is marked `source_missing` at the next freshness check.

## 5. Freshness

`checkSourceFreshness` compares the snapshot with what the index holds now:

| Result | When | Effect |
| --- | --- | --- |
| `fresh` | Same passage, same text hash | Nothing |
| `moved` | Same text found under another passage ID (re-extraction) | The record follows it; assessments stay current |
| `source_changed` | The passage text changed | Assessments become `stale`; the claim shows "needs revalidation" |
| `source_missing` | The paper, PDF or passage is gone | Record marked `source_missing`; kept for history |

A claim also needs revalidation when its own sentence changes materially (see
[CLAIM_EXTRACTION.md](CLAIM_EXTRACTION.md) §5), or when the prompt or
assessment version changes. `POST /claims/:id/revalidate` plans the work and
runs it as a job. It retrieves again, assesses changed pairs again and keeps
the old rows as history.

## 6. Jobs

Extraction over a section or the whole manuscript, retrieval, assessment of
all records, revalidation, manuscript review and long rewrites run as
persistent jobs (`evidence_jobs`). Jobs report progress through the
`evidence.job` event, can be cancelled and survive a runtime restart. Jobs that
were running at shutdown are marked failed with a reason at the next start.

## 7. Models, privacy and audit

Each model task (`extraction`, `assessment`, `contradiction`, `writing`,
`review`) can use a different provider and model, set per project. The
project's privacy mode decides what may leave the computer:

| Mode | Local models (Ollama on this computer) | Cloud models |
| --- | --- | --- |
| `local-only` (default) | Allowed | Refused with `LOCAL_ONLY` |
| `cloud-allowed` | Allowed | Allowed after confirmation for each operation (`CONSENT_REQUIRED`, with a preview of what is sent) |
| `confidential` | Allowed | Always refused with `CONFIDENTIAL_PROJECT` |

An optional allow-list of providers is enforced with `PROVIDER_NOT_ALLOWED`.
Every cloud use and every refusal is written to the audit log with the task,
the provider, the model and the number of characters sent. See
[security.md](security.md).

## 8. Exclusions

The engine does not write text on its own, accept citations on its own,
determine truth, verify proofs, validate data, resolve conflicts, rewrite a
whole manuscript without review or submit anything.
