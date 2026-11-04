# M5: Evidence-linked scientific writing and citation intelligence

Part 1 is the assessment and plan, written after inspecting the repository
and before any M5 code. Part 2 is the engineering report.

## Part 1: Assessment and plan (2026-11-04)

### 1. Existing architecture assessment

| Area | What exists (verified in code) | Use in M5 |
| --- | --- | --- |
| Model access | `ai-core` `ModelProvider` with `stream` and `generateStructured`; adapters for Anthropic, OpenAI, Gemini, Ollama (and OpenAI-compatible without structured output); `AiProviderService.instantiate` resolves keys in the runtime. M4 added per-model vision and the local/cloud routing with per-task consent (`visual-engine/providers`). | All M5 model calls use `generateStructured` with Zod-derived JSON Schemas. Routing and consent reuse the M4 rule (only Ollama on loopback is local) through a shared helper, extended with project privacy settings. No new provider abstraction. |
| Assistant | `AssistantService` (chat with streamed answers), `ai-core` context builder (`buildContext`, `neutralize` for untrusted text), writing actions, edit protocol. | The writing assistant runs as structured tasks (not chat) but reuses `neutralize`, the context builder's selection resolution and the proposal pipeline. |
| Edit review | `ProposalService`: proposals made against a file hash, diff review in the web `ReviewDialog`, accept only while the file is unchanged (compare-and-swap), reject, revert, automatic staleness on `files.changed`. | Every M5 manuscript change (rewrites, citation insertion) becomes an `EditProposal`. No second diff or apply system. |
| Bibliography | **There is no `packages/bibliography`.** `document-engine` has `parseBibtex` (lossless positions) and `extractCitations`; `research-library` has citation keys (`generateCitationKey`, `uniqueCitationKey`, `validateCitationKey`) and `ProjectLibraryService` (project references, reviewed `.bib` preview and apply that never rewrites existing entries, cite commands `cite`, `citep`, `citet`, `parencite`, `textcite`, `autocite`). | Citation intelligence calls `ProjectLibraryService` for `.bib` changes and key resolution. |
| LaTeX structure | **No LaTeX AST parser.** `document-engine/latex-analysis.ts` is line based: comments, labels, citations, outline, `\input`/`\include` references, root detection. | A block parser for manuscripts is added in `claim-anchors`, built on those functions and following `\input`/`\include` file by file (never flattened). |
| Library | `scholarly_works` (identifiers, metadata JSON with abstract, user edits), `library_items`, collections, attachments with SHA-256. | Evidence records point to works and items; abstracts provide abstract-level evidence for papers without full text. |
| Full text | M3.3 `document_extractions` (one active per attachment, PDF hash, versions, config hash), sections, blocks, passages (`text_hash`, `stable_key` stable across reprocessing), sentences, references, FTS5, embedding spaces. `DocumentRuntime.search` scopes by library, collections or papers and hydrates paper and provenance; `passageDetail` gives neighbours and sentences; `passageLocation` gives page and boxes. | Evidence retrieval calls `DocumentRuntime.search` and `passageDetail` through a port. Freshness compares `stable_key`, `text_hash`, extraction ID and PDF hash. |
| Literature search | M3.1 `LiteratureService` (OpenAlex, Semantic Scholar, arXiv, Crossref). | Optional external candidates (abstract level only, marked as not in the library). |
| PDF navigation | `PdfViewer` and `PdfDocumentView` with highlight boxes, the M3.3 source view. | Evidence detail opens the paper at the page with the passage highlighted. |
| Jobs and events | M3.3 persistent document jobs; M4 in-memory queue persisted in `visual_tasks`. | M5 adds a persistent `evidence_jobs` table and queue; running jobs are failed with a reason at restart. |

M3.1 to M4 were spot-checked in code rather than trusted from the docs:
the passage `stable_key`, sentence rows, hybrid search scoping, proposal
compare-and-swap, `.bib` preview and apply, and per-task consent all exist
as documented. Known gaps carried forward: no real GROBID, embedding or
vision model was ever run in CI (mocks), and the PyMuPDF fallback has no
sentence coordinates.

### 2. Existing document identity assessment

- **Source papers** have stable identity at three levels: attachment
  (content SHA-256), extraction (`dex_…`, versions and config hash) and
  passage (`<extraction>_p<n>` per extraction, plus `stable_key` and
  `text_hash` that survive reprocessing when the text is unchanged).
  Evidence must store a snapshot of the passage (text, hashes, pages,
  section, coordinates, extraction and PDF hash) because passage rows are
  deleted when a newer extraction replaces the old one.
- **Manuscripts** have no identity below the file: projects, file paths
  and file hashes only. M5 must create block and sentence identity for
  `.tex` files; offsets alone cannot be the identity.

### 3. Claim data model proposal

`ScientificClaim` as in the assignment, stored in `scientific_claims`:
project, manuscript document (the project's root file), block, sentence,
original sentence text, the claim text and its span in the sentence (or
`null` when the claim is a paraphrase of part of the sentence), normalised
text, type (extensible string; 13 built-in types), atomicity, entities,
concepts, quantities, assumptions, revision, text hash, status, review state
(`proposed`, `approved`, `excluded` with reason), `requiresEvidence`
(false for definitions, mathematical identities and structural statements
unless the user says otherwise), extraction provenance (model, prompt
version) and timestamps. Claims are archived, never deleted, when their text
disappears. Manual edit, merge and split are versioned operations on claims;
the manuscript is never changed by extraction.

Statuses (aggregate, for filtering only): `unchecked`, `analyzing`,
`supporting_evidence_found`, `partially_supported`,
`potentially_contradicted`, `insufficient_evidence`,
`contextual_evidence_only`, `not_assessable`, `needs_revalidation`,
`user_reviewed`. The aggregate is computed from the individual assessments
and never replaces them: the UI and API always list every assessment, and a
claim with both support and a contradiction is `potentially_contradicted`
with its supporting count shown next to it.

### 4. Evidence data model proposal

- `evidence_sources`: one row per distinct source snapshot (passage text
  hash + extraction + work), with the full provenance (work, item,
  attachment, extraction, passage ID, `stable_key`, pages, section path,
  coordinates, PDF hash, extractor version, DOI, arXiv ID, URL, the exact
  text, and `level`: `full_text`, `abstract`, `external_abstract`).
  Shared by every claim that retrieves it (no duplicated provenance).
- `evidence_records` (the claim to evidence relation, the
  `ClaimEvidenceRelations` of the assignment): claim, source, retrieval
  method, query variant, ranks and scores, retrieval index version,
  retrieved time, status (`active`, `excluded`, `stale`, `source_changed`).
- `evidence_assessments`: append-only AI assessments (assessment,
  explanation, supported and unsupported subclaims, contradictory
  statements, limitations, verified excerpt, uncertainty, provider, model,
  prompt version, assessment version, claim text hash and source hash it was
  made against, `superseded_at`).
- `evidence_reviews`: human decisions, separate from AI assessments
  (accept, reject, reclassify with a new category, exclude source, note),
  append-only with actor and time.
- `conflict_analyses`: pairs of evidence records for one claim, with the
  category and the scope, regime, assumption and definition differences.

Relevance (ranks, scores, method) lives on `evidence_records`; support
lives on assessments. They are never combined into one number.

### 5. Source provenance strategy

Every evidence source stores what is needed to find and verify it later
without the live index: exact text, `text_hash`, `stable_key`, extraction
ID and versions, PDF SHA-256, attachment and item IDs, work identifiers,
pages and coordinates exactly as extracted (null when the extractor did not
report them; never estimated), section path, and the retrieval index
version (embedding space ID and FTS index generation). Abstract-level
evidence has no page and says so. External candidates from M3.1 carry the
provider and canonical ID and are labelled as not in the library. Snapshots
are kept when the library item or extraction is later deleted
(`ON DELETE SET NULL` on the links).

### 6. Retrieval architecture

`evidence-engine/retrieval` builds query variants from a claim: the claim
text, a key-term query (technical terms, entities, quantities, without
hedges and stop words), quoted multi-word terms for exact matching, and
entity-only queries. Each variant runs through the runtime's existing
`DocumentRuntime.search` (keyword, semantic or hybrid, with scope: library,
collections or papers, and filters). Results are fused by reciprocal rank
over variants, then diversified: at most two passages per paper in the top
results, so independent papers are preferred, with remaining passages from
the same paper grouped under it. Neighbouring passages come from
`passageDetail`. Library works with no active extraction are matched on
their stored abstracts (keyword overlap) and returned as abstract-level
evidence. Optional M3.1 external search adds abstract-level candidates. No
model is involved in retrieval and no source text is generated.

### 7. Evidence assessment methodology

One structured call per (claim, passage) pair with the claim, its type, the
passage, the neighbouring passages, the paper's title, authors, year, venue,
publication type, section heading and location. Untrusted text is wrapped
and neutralised as in M2 and declared data in the system prompt. The schema
follows the assignment (`direct_support`, `partial_support`,
`indirect_support`, `context_only`, `contradiction`, `insufficient`,
`irrelevant`) with subclaims, contradictions, limitations, an excerpt and
uncertainty. Validation after the model: the excerpt must occur verbatim
(after whitespace and hyphenation normalisation) in the passage or its
neighbours, otherwise the assessment is stored with
`quotation_not_found` and downgraded to `not_assessed`; support categories
without an excerpt are downgraded; unknown subclaims are dropped. Metadata
such as citation counts or venue are not sent as evidence. Contradictions
are analysed by a dedicated second call that compares scope, definitions,
regime, conditions, assumptions, approximations, systems, boundary
conditions, methods, time and parameter ranges, and returns one of eight
conflict categories with the differences found. Nothing is resolved
automatically and no majority is computed.

### 8. Citation management strategy

Recommendations come only from evidence with an AI assessment of
`direct_support` or `partial_support` that the user has not rejected (or a
human review that accepts it). Each recommendation shows the work, key,
passage, page, assessment and reason. Key resolution: the key already in the
project's `.bib` for the same work (DOI, arXiv or title match, as
`ProjectLibraryService` does), else the library's key, else a generated
unique key. Validation checks the item exists, the key is valid, collisions
with a different work, an equivalent citation already in the sentence, and
the `.bib` entry. The cite command is the project's configured one,
checked against the preamble (natbib commands need natbib, biblatex
commands need biblatex; plain `\cite` always works). Insertion creates an
`EditProposal` for the `.tex` change and a `.bib` preview from
`ProjectLibraryService` when the entry is missing; both are reviewed as
diffs and applied with compare-and-swap. Grouping: one citation at the end
of a run of adjacent claims supported by the same sources instead of one per
sentence.

### 9. Document anchoring strategy

`claim-anchors` parses each `.tex` file of the project into blocks
(paragraphs, display environments, list items, captions, headings) with the
section path from the outline, and follows `\input`/`\include` by file
(each block knows its file). Sentences come from the M3.3 segmenter applied
to a prose view in which commands are kept but comments are removed, with a
map back to source offsets. Each anchor stores project, file path, block ID,
section ID, parent paragraph ID, sentence ID, text snapshot, normalised text
hash, 64-character prefix and suffix context, revision, optional offsets
and the block's structural path (environment nesting). Block and sentence
IDs are assigned once and carried forward by reconciliation:

1. exact normalised-hash match, unique in the new version: `current`;
2. hash match with several candidates: disambiguate by context and order;
   still tied: `unmatched` (ambiguous), never merged;
3. no hash match: best candidate by token similarity in the same file and
   section, with context and position as tie-breakers; above the high
   threshold and no material change: `modified` (minor); otherwise above the
   low threshold: `needs_revalidation`; below: `deleted` or `unmatched`;
4. a claim span found inside a new, larger sentence (merge) or a sentence
   found split in two (split) maps to the containing sentence.

Materiality looks at numbers and units, negations, quantifiers, modal and
hedging words, comparatives, causal connectives, named entities and
citation keys; any change there is material. A material change sets the
claim to `needs_revalidation` and marks its assessments stale; support is
never carried over. Revisions are recorded per file hash.

### 10. Writing assistant architecture

`writing-intelligence` provides deterministic analysis (overgeneralisation
markers, unhedged causal language, undefined acronyms, inconsistent
terminology, sentence length, redundancy, observation versus interpretation
cues, claims without citations) and model operations for the 27 requested
operations grouped as style, precision, technical writing and critical
review. A rewrite returns a structured proposal; it is checked before it is
offered: citation keys, `\ref`/`\eqref`/`\label`, math segments and
numbers are preserved unless the operation says otherwise; claims are
extracted from both versions and compared for material changes; a warning is
attached when meaning may have changed. The result becomes an
`EditProposal` (diff, manual edit, accept, reject, revert), and affected
claims are marked for revalidation when it is applied. Nothing is inserted
automatically.

### 11. Security and privacy review

- Papers, passages, metadata and manuscript text are untrusted: wrapped,
  neutralised, labelled as data; structured outputs only; no tools are
  offered to models in M5; agents are not used.
- Model output is validated against schemas; excerpts are verified against
  the source; IDs in model output are checked against the request.
- Project privacy settings (`local-only`, cloud allowed for listed
  providers, confidential projects that can never use cloud) are enforced
  by the runtime; every cloud operation needs consent for that operation,
  shown with what leaves the machine (claim count, characters of manuscript
  text, number of passages and characters of source text, provider, model).
- External usage (provider, model, tokens, characters sent) is recorded per
  job; audit events for extraction, assessments, reviews, citation
  insertions and rewrites (no texts).
- Retrieval scope is limited to the user's library (single-user runtime);
  claims, evidence and jobs are checked against the project in the URL.
- Deleting analysis results for a project removes M5 rows only.

### 12. UI and workflow design

- **Editor**: selecting text and choosing **Check evidence** (or the
  Evidence panel toggle) opens the Evidence panel beside the editor:
  selected text, extracted claims (approve, edit, split, merge, exclude),
  per-claim evidence grouped into supporting, partial, contextual and
  conflicting, each with title, authors, year, DOI, exact passage, page and
  section, assessment, explanation, limitations and **Open in PDF**; citation
  recommendations with key, command, placement preview and **Insert**
  (diff review); writing suggestions.
- **Indicators**: a thin gutter mark on lines with claims whose status
  needs attention, no permanent badges in the text.
- **Evidence Review Mode**: a page per project with the coverage dashboard
  (counts with explicit denominators), claims by section with filters, side
  by side conflicts, section, introduction and conclusion reviews.
- **Settings**: per-project privacy mode and model per task.

### 13. Testing and evaluation plan

Unit tests per module (anchors: unchanged, minor, material, split,
merge, reorder, rename, included files, duplicates, deletion; extraction
pre-filter and splitting; retrieval query building, fusion and diversity;
assessment validation including fabricated quotations and malformed output;
conflict categories; freshness; citation resolution, collisions, command
compatibility, grouping, preservation after rewriting; writing analysis and
meaning preservation). Runtime integration tests through the HTTP API with a
scripted model and the real M3.3 index built from synthetic papers.
Security tests for injected instructions in passages, cross-project access,
consent, invalid model output, unauthorised citation changes and stale
proposals. Web component tests with axe and a Playwright run. A small
benchmark, clearly marked as **synthetic** (constructed passages, not
presented as real literature), measures the deterministic parts (claim
pre-filter and splitting, retrieval Recall@5/10, anchor reconciliation,
citation recommendation precision given assessments) by claim category;
model-dependent metrics (assessment and contradiction precision and recall)
have a harness that runs with a real model when configured and are reported
as not measured otherwise.

## Part 2: Engineering report (2026-11-04)

Status labels used below: **[tested]** implemented and covered by automated
tests; **[not live]** implemented but not verified against a real external
service or model; **[partial]** partly implemented; **[not done]** not
implemented.

### 1. Architecture changes

- Four new pure packages (`claim-anchors`, `evidence-engine`,
  `citation-intelligence`, `writing-intelligence`) and one runtime facade
  (`EvidenceRuntime`) with its routes, contracts, events and jobs. No new
  provider or search abstraction. Models are reached through
  `ModelProvider.generateStructured` (M2) and evidence through the M3.3
  `DocumentRuntime.search`. **[tested]**
- Manuscript changes go through the M2 `ProposalService`, and `.bib` changes
  through the M3.2 project references preview and apply. **[tested]**
- `ai-core`: `privacyModeOf` moved here from `visual-engine` and is shared.
  **[tested]**
- `DocumentRuntime`: `retrievalIndexVersion()` made public. **[tested]**
- Database migration `0005_evidence` with a down script. **[tested]**
- Web: five feature modules, an evidence panel in the workspace layout, a
  `#/review` route, gutter marks and a context-menu action. **[tested]**

### 2. New packages and files

| Area | Files |
| --- | --- |
| `packages/claim-anchors` | `hashing/text-hash`, `mapping/materiality`, `parser/latex-blocks`, `parser/sentences`, `parser/manuscript`, `identity/identity`, `reconciliation/matcher`, `reconciliation/reconcile`, `revision/revision` |
| `packages/evidence-engine` | `claims/` (normalizer, classifier, atomic splitter, validator, extractor), `retrieval/` (types, query builder, source ranking, retriever, context), `assessment/` (validator, support assessor, evidence classifier, contradiction detector, uncertainty), `provenance/`, `freshness/`, `schemas/`, `model/structured`, `prompts`, `errors`; `test/benchmark/` (dataset, harness, test, results) |
| `packages/citation-intelligence` | validation (setup, command), key resolver, placement, recommender and grouping, diff, bibliography updater |
| `packages/writing-intelligence` | `analysis/` (academic style, sentence, terminology, logical flow, paragraph), `rewriting/` (citation and meaning preservation, operations, schemas, validation, service), `review/` (coverage, sections, introduction and conclusion), `suggestions/` |
| `packages/api-contracts` | `src/evidence.ts`; `client.ts` and `events.ts` extended |
| `packages/shared-types` | `src/evidence.ts` (replaces the M0 placeholder) |
| `packages/database` | `schema.ts` (14 tables), `migrations/0005_evidence.sql`, `migrations/down/0005_evidence.sql`, `test/evidence-schema.test.ts` |
| `apps/runtime` | `services/evidence-runtime.ts`, `services/evidence/` (manuscript sync, privacy, jobs, search port), `routes-evidence.ts`, `test/evidence.test.ts` |
| `apps/web` | `features/evidence-review`, `claim-analysis`, `citation-intelligence`, `scientific-writing`, `manuscript-review`; `test/evidence.test.tsx` |
| `e2e` | `evidence.spec.ts`; the mock Ollama server answers evidence requests |

### 3. Claim extraction

Rules classify each sentence as a claim or one of eight non-claim kinds with
a reason, split compound sentences into atomic claims with spans, guess one
of 13 types and record quantities, entities and concepts. Model extraction
uses a strict schema with fenced input and is validated against the
sentence (invented content refused). Both merge by text, and claims are
stored as `proposed` for the researcher to approve, edit, split, merge,
exclude or archive. The manuscript is never changed. **[tested]** for rules
and for the model path with a scripted model; **[not live]** with a real
model. Benchmark: detection precision and recall 1.000, segmentation 1.000,
type guess 0.833 (in-sample, see §16).

### 4. Anchoring

LaTeX is parsed into blocks and sentences (preamble and comments skipped,
maths and references masked, includes followed). Identities are stable while
the normalised text is unchanged. Reconciliation matches exact, similar,
split and merged text, and reports ties as ambiguous. `assessChange` decides
materiality (numbers, negation, quantifiers, modals, comparatives, causal
words, references, maths, content words, similarity below 0.75). Added
citations are ignored. Automatic syncs only move statuses towards caution.
**[tested]** (13 package tests, runtime test on edits). Benchmark: 10 of 12
anchor cases agree, no unsafe errors, two conservative ones.

### 5. Retrieval methodology

Up to five query variants per claim (the claim in hybrid mode, key terms,
technical phrases and entities as keyword queries, hedges and citations
removed, numbers kept) run through the M3.3 index over the library, chosen
collections or chosen papers. Stored abstracts and, on request, M3.1 results
are added at abstract level. Reciprocal rank fusion (k = 60) with at most two
passages per paper, full text before abstracts. Every candidate is an actual
passage with full provenance, and its ranks are stored apart from support.
**[tested]** over the real M3.3 keyword index and PyMuPDF extraction;
semantic search only with the lexical test embedder, **[not live]** with a
real embedding model. Benchmark Recall@5 and Recall@10 1.000 on 17 claims
(a small corpus, see §16).

### 6. Assessment methodology

Each record is judged on its own by the assessment model with a strict
schema, seeing the claim, its sentence and section, and the passage with its
neighbours, all fenced. Eight categories, uncertainty, one verified excerpt,
supported and unsupported subclaims, contradictory statements and
limitations. Support or contradiction without a quotation that occurs in the
text becomes `not_assessed`. Abstract evidence gets a limitation and a
higher uncertainty floor. New rows supersede old ones, and changes make them
stale. Human decisions are separate rows that take precedence when the
claim status is derived. **[tested]** with scripted models; **[not live]**
with a real model, so assessment precision is not measured.

### 7. Contradiction classification

Supporting and opposing records are paired and classified by the
contradiction model into eight categories (direct contradiction,
conditional, methodological, different assumptions, regimes, definitions,
apparent disagreement, insufficient information), with both sides and the
conditions under which each holds. A contradiction always shows as
`potentially_contradicted` and is never cancelled by support, resolved or
used to edit text. **[tested]** with scripted models; **[not live]**;
**[partial]** for evaluation (no labelled conflict set).

### 8. Citation recommendation

Only `direct_support` or `partial_support` evidence counts, judged by the
model with a verified excerpt or accepted by the researcher, for papers in
the library. Rejected, stale and external-abstract evidence is left out,
contradicting papers are never recommended, one recommendation per paper,
ordered by strength, review, level and uncertainty. Citation counts and
venues play no part. Papers already cited are listed apart. Grouping
suggests one citation for adjacent claims resting on the same papers.
**[tested]**. Benchmark precision and recall 1.000 given correct
assessments (end to end it depends on §6).

### 9. Bibliography integration

The citation setup (natbib, biblatex, plain) is read from the preamble, and
the configured command is used only when it compiles, otherwise the setup's
parenthetical command with a warning. Keys come from the `.bib` when the
work is there, otherwise from the library with an `add-entry` change from
the M3.2 preview. Collisions and missing keys are refused, never resolved.
The cited items are linked to the project first. The `.tex` edit is an M2
proposal, the `.bib` change is shown as a diff, and both are applied only
when the researcher accepts. Changed files fail with `STALE_PROPOSAL`.
**[tested]** (package, runtime and web tests, E2E).

### 10. Writing assistant

29 operations in four groups, 9 of them report only. Rule analysis needs no
model. Rewrites use the writing model with a strict schema and are checked
for citations, references and maths (`checkPreservation`) and meaning
(`assessChange` in non-strict mode). A rewrite that drops or adds a citation
or reference is not offered, and meaning changes are warned about with the
affected claims. Valid rewrites become M2 proposals. No section is written
and no manuscript is rewritten as a whole. **[tested]** with scripted
models; **[not live]**.

### 11. Manuscript review UI

Evidence panel beside the editor (selection or open file), claim cards with
evidence, conflicts and recommendations, PDF viewer at the passage, consent
dialog, model picker, project evidence settings, citation review dialog with
both diffs, writing tools, gutter marks with text status. Evidence Review
Mode at `#/review` with filters, decisions, section summaries, introduction
and conclusion checks and coverage with denominators and no score.
**[tested]** (6 web tests with axe, E2E in Chromium with axe).

### 12. Migrations

`0005_evidence` adds 14 tables (manuscript revisions, blocks, sentences,
scientific claims, claim anchors, evidence sources, records, assessments,
reviews, conflict analyses, citation recommendations, writing suggestions,
manuscript reviews, evidence jobs). Sources are shared snapshots, unique by
hash, whose paper links are set null on deletion and which records
reference without cascade. Down script tested up → down → up. Earlier schema
tests updated for the new table list and rollback order. **[tested]**

### 13. API endpoints

30 routes under `/api/v1` (claims 8, evidence 6, citations 3, writing and
review 7, settings, jobs and deletion 6), with Zod contracts, a typed client
and two events. Listed in `docs/API_SPECIFICATION.md`. **[tested]** (runtime
integration tests through HTTP).

### 14. Security and privacy

Per-project privacy (`local-only` default, `cloud-allowed` with consent per
operation and a preview of what is sent, `confidential`), an optional
provider allow-list, per-task model routing and an audit entry for every
cloud use and refusal. Untrusted text is fenced and fence markers defused,
answers are schema-checked and may only refer to `C1` and `P1`, and
quotations are verified. No model output writes files. Every change is a
reviewed proposal with compare-and-swap. Provenance is never cascaded away.
Threats T59 to T64 in `docs/security.md`. **[tested]** (including injected
instructions, consent, cross-project requests, invalid output and stale
proposals).

### 15. Benchmark methodology

A synthetic set, written for M5 and reviewed by hand. It has 8 papers with
"Synthetic" titles and 16 passages, 25 sentences (18 claims across 11 types,
7 non-claims) with expected atomic claims, 24 claim and passage pairs with
expected assessments and 12 anchor edits. Nothing is presented as real
literature. Deterministic parts run in every test run against baselines,
and model-dependent parts run only with `RS_EVIDENCE_LIVE=1`. Details in
`docs/EVIDENCE_EVALUATION.md`.

### 16. Benchmark results

| Metric | Result |
| --- | --- |
| Claim detection precision / recall | 1.000 / 1.000 |
| Atomic segmentation exact match | 1.000 (18) |
| Claim type first guess | 0.833 (0.389 before tuning on this set) |
| Retrieval Recall@5 / Recall@10, keyword | 1.000 / 1.000 (17 claims) |
| Retrieval Recall@5 / Recall@10, hybrid with test embedder | 1.000 / 1.000 |
| Citation precision / recall given correct assessments | 1.000 / 1.000 (14) |
| Anchor reconciliation agreement | 0.833 (10 of 12), no unsafe errors |
| Quotation validation, genuine accepted / altered refused | 1.000 / 1.000 (16 each) |
| Assessment and contradiction precision | not measured (no model) |

These numbers are optimistic. The set is small, the corpus has 16 passages,
and the set was written by the same team as the rules and partly used to
tune the type rules. They show the parts work as designed, not how well
they generalise.

### 17. Automated test results

TEST_RESULTS_PLACEHOLDER

### 18. Build and lint results

BUILD_RESULTS_PLACEHOLDER

### 19. Limitations

- No real language model was available, so assessment, conflict analysis,
  model extraction, rewrites and reviews were verified only with scripted
  models and a mock Ollama server. **[not live]**
- Assessment and contradiction precision are not measured. There is no
  labelled conflict set. **[partial]**
- The benchmark is small, synthetic and in-sample for the rules.
- Semantic retrieval was exercised only with the lexical test embedder.
- Rule-based claim types are a first guess (three misses in 18).
- Papers outside the library can be shown as abstract-level evidence but
  must be added to the library before they can be cited.
- Anchors are conservative. Some harmless edits ask for revalidation.
- Rewrites work on a selection only, by design. Whole-manuscript rewriting
  is excluded.

### 20. Recommendations for M6

1. Run the live harness with a local model (and, with consent, a hosted
   one) and record assessment and conflict precision per category.
2. Build a held-out evaluation set written by someone other than the rule
   authors, with real open-access papers whose licences allow it, and a
   labelled conflict set.
3. Measure retrieval with a real embedding model on a library of realistic
   size, and tune query variants and the per-paper limit there.
4. Let the researcher teach the claim type rules (corrections become
   examples) instead of tuning them by hand.
5. Make anchor materiality configurable per project, to reduce unnecessary
   revalidation.
6. Add the claim graph across sections (the same claim stated in the
   introduction and the results) so evidence can be shared, still reviewed.
