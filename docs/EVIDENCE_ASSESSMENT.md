# Evidence assessment and conflicts (M5)

Code: `packages/evidence-engine/src/assessment`, prompts in
`packages/evidence-engine/src/prompts.ts` (prompt version `2026-11-04.1`,
assessment version `1`).

## 1. Relevance is not support

Retrieval decides which passages are worth reading and stores keyword,
semantic and fused ranks on the evidence record. Assessment decides how a
passage relates to the claim. The two are stored separately, and a high rank
never counts as support.

## 2. Categories

| Assessment | Meaning |
| --- | --- |
| `direct_support` | The passage states the claim, with the same scope and conditions |
| `partial_support` | It supports part of the claim, or under narrower conditions |
| `indirect_support` | It supports something the claim depends on |
| `context_only` | It is about the topic but does not bear on the claim |
| `contradiction` | It states something incompatible with the claim, under comparable conditions |
| `insufficient` | It is relevant but cannot settle the question |
| `irrelevant` | It is not about the claim |
| `not_assessed` | No valid assessment exists (yet, or the model's answer failed validation) |

Each assessment also carries an uncertainty (`low`, `medium`, `high`), a
relevant excerpt (an exact quotation from the passage), the supported and
unsupported subclaims, contradictory statements, limitations and a short
explanation.

## 3. Structured output and validation

The model receives the claim, its sentence and section, and the passage with
up to two neighbouring passages, each fenced as untrusted content. It must
answer with JSON matching `EvidenceAssessmentSchema` (`z.toJSONSchema`, strict
mode where the provider supports it). The answer refers to the claim as `C1`
and the passage as `P1`, so it cannot name anything else.

`validateAssessment` then applies these rules.

- The excerpt must occur in the passage or the neighbouring passages shown,
  after normalising whitespace, quotes and hyphenation. The benchmark shows
  all 16 genuine quotations accepted and all 16 altered ones refused.
- A `direct_support`, `partial_support`, `indirect_support` or
  `contradiction` answer without an excerpt, or with one that does not occur
  in the text, becomes `not_assessed`. The model's original answer and the
  reason are kept with the row.
- Partial support that does not name the unsupported parts gets a note.
- Abstract-level evidence gets a limitation. Its uncertainty is at least
  `medium` (library abstract) or `high` (external abstract). An unverified
  excerpt sets it to `high`.

The raw answer, the model, provider, prompt version, token use and the
privacy mode used are stored with the row.

## 4. History

A new assessment never overwrites an old one. The previous row becomes
`superseded`. When the source or the claim changes materially, rows become
`stale`. The UI shows the current row and lets the researcher open the
history.

Human decisions (`accept`, `reject`, `reclassify`, `exclude_source`,
`mark_reviewed`, `note`) are stored in `evidence_reviews`. They take
precedence over the AI rows when the status is derived, but they do not
change them.

## 5. Claim status

`claimStatus` derives a status for filtering. Each record counts with the researcher's
category where they set one (by accepting or reclassifying), otherwise with
the current AI category. Records whose source was excluded do not count. The first rule that applies wins.

| Order | Status | When |
| --- | --- | --- |
| 1 | `analyzing` | A job is running for the claim |
| 2 | `needs_revalidation` | The claim or a source changed materially, or all assessments are stale |
| 3 | `user_reviewed` | The researcher marked the claim reviewed |
| 4 | `not_assessable` | The claim type needs no external source |
| 5 | `potentially_contradicted` | Any contradiction (support does not cancel it) |
| 6 | `supporting_evidence_found` | At least one direct support |
| 7 | `partially_supported` | At least one partial support |
| 8 | `contextual_evidence_only` | Only indirect support or context |
| 9 | `insufficient_evidence` | Assessed, but nothing above applies |
| 10 | `unchecked` | Nothing assessed yet |

The status is a filter. The individual assessments are always shown next to
it.

## 6. Conflicts

When a claim has both supporting and contradicting evidence, or two sources
disagree with each other, `conflictPairs` pairs them and `analyseConflict`
asks the contradiction model to classify the disagreement.

`direct_contradiction`, `conditional_disagreement`,
`methodological_disagreement`, `different_assumptions`, `different_regimes`,
`different_definitions`, `apparent_disagreement` and
`insufficient_information`.

The analysis lists what each side says (with verified excerpts), the
conditions under which each holds and what would be needed to decide. It is
shown side by side. It never picks a winner, never changes the claim status
on its own and never edits the manuscript.

## 7. Measured quality

Assessment and conflict precision need a real model. The opt-in harness
(`RS_EVIDENCE_LIVE=1`, see [EVIDENCE_EVALUATION.md](EVIDENCE_EVALUATION.md))
reports precision and recall per category. No model was available while
this milestone was built, so these numbers are not yet measured.
