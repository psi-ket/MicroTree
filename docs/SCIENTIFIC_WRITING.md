# Scientific writing assistant (M5)

Code: `packages/writing-intelligence`, UI in
`apps/web/src/features/scientific-writing`.

The assistant works on a selection the researcher chose. Every change it
suggests is a diff to review. It does not write sections, does not rewrite a
whole manuscript and does not apply anything on its own.

## 1. Operations

29 operations in four groups. Nine of them only report findings. The others
propose rewritten text.

| Group | Operations |
| --- | --- |
| Academic style | `academic-tone`, `concise`, `formal`, `readability`, `remove-redundancy`, `transitions`, `reduce-ambiguity` |
| Scientific precision | `overgeneralization`\*, `qualify-claims`, `terminology`, `observation-vs-interpretation`, `prediction-vs-result`, `undefined-concepts`\*, `causal-language`, `terminology-consistency`\* |
| Technical writing | `logical-flow`, `paragraph-structure`, `math-explanation`, `clarify-assumptions`, `equation-transitions`, `figure-descriptions`, `captions`, `definitions` |
| Critical review | `unsupported-statements`\*, `needs-citations`\*, `incomplete-explanations`\*, `internal-contradictions`\*, `duplicated-explanations`\*, `unclear-reasoning`\* |

\* Report only.

## 2. Analysis without a model

`POST /writing/analyze` runs deterministic checks that need no model.

- Style: informal words, contractions, filler phrases, long sentences.
- Precision: universal statements without a citation or qualification,
  unhedged causal language, observation and interpretation in one sentence,
  prediction and result mentioned together.
- Terminology: the same concept named in different ways.
- Flow and paragraphs: missing transitions, paragraphs without a clear
  topic sentence, claims that need evidence but cite nothing.

Each finding names the operation, the sentence, the excerpt, a message and a
suggestion. A model can add findings for the report-only operations. These
checks are used by manuscript review as well.

## 3. Rewrites

`POST /writing/rewrite` sends the selection (fenced as untrusted text) and the
operation's instructions to the writing model with a strict schema. The
answer is checked before it is offered.

- **Citations.** `checkPreservation` compares the cited keys, the references
  (`\ref`, `\eqref`, `\label` and similar) and the maths of the original
  and the rewrite. A rewrite that drops or adds a citation or a reference is
  not offered, and the researcher sees why. Changed maths is a warning.
- **Meaning.** `assessChange` (non-strict mode) compares the original and the
  rewrite. A change in numbers, negation, quantifiers, modal strength,
  comparatives or causal wording produces a warning naming the change. A
  rewrite that makes a claim stronger (for example removing "may") is marked
  as a meaning change.
- **Claims.** If the selection holds claims with evidence, the warning lists
  them, since their anchors will need revalidation if the change is material.

A valid rewrite becomes an M2 proposal. The diff is reviewed, and accepting
it uses the proposal service's compare-and-swap. If the file changed since
the selection was made, the request fails with `STALE_PROPOSAL`.

Every suggestion is stored in `writing_suggestions` with the operation, model,
prompt version (`WRITING_PROMPT_VERSION`), warnings and its status
(`proposed`, `accepted`, `rejected`, `stale`).
