# Claim extraction and anchoring (M5)

Code: `packages/evidence-engine/src/claims` and `packages/claim-anchors`.

## 1. What counts as a claim

A claim is a sentence, or part of one, that states something a reader could
ask a source for. These are not claims and are listed separately as
non-claims with a reason:

| Kind | Example |
| --- | --- |
| `question` | "Can the threshold be raised further?" |
| `instruction` | "Note that the basis is fixed." |
| `heading` | `\section{Results}` |
| `citation-only` | "\cite{a,b}." |
| `equation-reference` | "See Eq. (3)." |
| `transition` | "The rest of this paper is organised as follows." |
| `connective` | "In short." |
| `structural` | "Let $H$ be the Hamiltonian." |

## 2. Claim types

`empirical`, `theoretical`, `mathematical`, `definition`, `methodological`,
`historical`, `comparative`, `interpretive`, `causal`, `quantitative`,
`assumption`, `hypothesis` and `background`. Projects can use custom types.

Definitions, mathematical statements, assumptions and hypotheses do not need
an external source by default (`NO_EVIDENCE_BY_DEFAULT`). The researcher can
change this per claim.

The rule-based type is a first guess. It is right for 15 of the 18 claims in
the benchmark, a set that was also used to tune the rules (see
[EVIDENCE_EVALUATION.md](EVIDENCE_EVALUATION.md)). Model extraction and the
researcher can change it.

## 3. Two extraction methods

**Rules (`heuristic`, no model).** `classifySentence` rejects non-claims,
`splitAtomicClaims` splits compound sentences, `guessClaimType` picks a type
and `extractQuantities` and `extractTerms` record numbers, units, entities and
concepts. This is fast, deterministic and never sends text anywhere.

**Model (`model`).** The sentences are sent, fenced as untrusted content, to
the extraction model with a strict JSON schema. Its answer goes through the
same validator as the rules.
- Each claim must be found in its sentence, or be an atomic part of it.
- A claim that adds words not in the sentence is dropped with a warning.
- The model's claims and the rule-based claims are merged by text, so the
  model cannot remove a sentence from consideration without it being listed
  as a non-claim with a reason.

Extracted claims are stored as `proposed`. The researcher approves, edits,
splits, merges, excludes or archives them. Only approved and proposed claims
take part in coverage. Archived claims keep their evidence history.

## 4. Atomic splitting

A compound sentence such as

> Surface codes are widely investigated because of their locality, and they
> provide a framework for fault-tolerant computation.

becomes two claims. A clause is split off only when both parts read as
clauses: the first part has at least four words and the second has at least
three words with a verb or a subject. Lists of nouns ("qubits, couplers and
resonators") are not split. Each claim keeps the character span of its part
of the sentence, and `atomicity` records `atomic`, `compound` or
`uncertain`.

## 5. Anchors

A claim is anchored to a sentence of a block of a file, not to line numbers.

**Parsing.** `parseLatexFile` skips the preamble and comments and produces
blocks (`heading`, `paragraph`, `display-math`, `environment`, `caption`,
`list-item`). `blockSentences` masks maths, references and citations before
segmenting, so "Eq.~\eqref{x}" and "$p = 0.1$." do not end a sentence early.
`parseManuscript` follows `\input` and `\include` and passes the section path
into included files.

**Identity.** A block or sentence keeps its ID while its normalised text hash
is unchanged. Exact duplicates are matched in order.

**Reconciliation.** After an edit, `reconcile` matches the stored sentences to
the new ones in this order. Exact text first, then similar text, then splits
and merges. Ties are reported as ambiguous instead of being guessed.

`assessChange` then decides whether the change to a claim's sentence is
material. Changes to numbers, negation, quantifiers, modal verbs,
comparatives, causal words, references or maths are material. So is a change
of any content word in strict mode, and any similarity below 0.75. Citations
added to the sentence are ignored, so inserting a citation does not
invalidate the claim it supports.

| Anchor status | Meaning | Evidence |
| --- | --- | --- |
| `current` | Same text | Kept |
| `modified` | Changed, but not materially | Kept |
| `needs_revalidation` | Material change, or split or merged | Kept, marked for revalidation |
| `unmatched` | No confident match (for example a deleted duplicate) | Kept, the researcher chooses |
| `deleted` | The sentence is gone | Kept as history |

Statuses only move towards more caution during automatic syncs. Only an
explicit revalidation or a review brings a claim back to `current`.

In the benchmark, anchor reconciliation agrees with the expected status in 10
of 12 cases. The two misses are both conservative, a minor wording change and
a merge marked as needing revalidation. No material change was let through.
