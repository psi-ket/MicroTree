# Citation intelligence (M5)

Code: `packages/citation-intelligence`, runtime in
`apps/runtime/src/services/evidence-runtime.ts`, UI in
`apps/web/src/features/citation-intelligence`.

## 1. Recommendation

A citation is recommended only from evidence, never from similarity alone.

- The evidence must be `direct_support` or `partial_support`, judged by the
  model with a verified excerpt or accepted by the researcher.
- The paper must be in the library. Abstracts from outside the library
  (`external_abstract`) are never recommended.
- Rejected, excluded and stale evidence is left out. Contradicting papers
  are never recommended as support and are shown separately.
- There is one recommendation per paper. The strongest evidence is its
  reason, and other supporting passages from the same paper are listed.
- Order is direct before partial, accepted before not yet reviewed, full
  text before abstract and lower uncertainty first. Citation counts, venues
  and dates play no part.
- Papers the sentence already cites are listed apart as already cited.

Given correct assessments, the recommender has precision 1.0 and recall 1.0
over 14 recommendations in the benchmark. This measures the recommender only
(see [EVIDENCE_EVALUATION.md](EVIDENCE_EVALUATION.md)).

Recommendations are `proposed` until the researcher accepts, rejects or
inserts them. Nothing is inserted automatically.

## 2. Citation setup and commands

`detectCitationSetup` reads the preamble (comments removed).

| Setup | Detected by | Commands that compile | Default after a claim |
| --- | --- | --- | --- |
| biblatex | `\usepackage{biblatex}` | `\cite`, `\parencite`, `\textcite`, `\autocite` (and `\citep`, `\citet` with `natbib=true`) | `\autocite` |
| natbib | `\usepackage{natbib}` | `\cite`, `\citep`, `\citet` | `\citep` |
| plain | neither | `\cite` | `\cite` |

`chooseCommand` uses the command set in the project's library settings when
the preamble supports it. Otherwise it falls back to the setup's default and
says why. Textual commands (`\citet`, `\textcite`) print author names, so at
the end of a claim the parenthetical command is used instead, with a warning.

## 3. Keys and the bibliography

`resolveCitationKey` uses the M3.2 bibliography preview of the project's
`.bib` file.

- If the `.bib` already has an entry for the work (matched by DOI or key),
  its key is used and the `.bib` is not touched.
- If not, the library's key is used and the preview's `add-entry` change is
  planned.
- If the library's key is already taken by a different work in the `.bib`,
  that is a collision. It is reported and the insertion is refused. Keys are
  never renamed and existing entries are never rewritten.

`validateInsertion` checks the paper is in the library, the key is valid, it
is not a collision and the sentence does not already cite it. Problems fail
the request with `CITATION_INVALID` and the list of reasons.

## 4. Insertion

`planCitationEdit` places `~\cmd{keys}` before the sentence's final
punctuation, or merges the keys into a citation that is already there. Keys
already cited are skipped. If all of them are, the request fails with
`ALREADY_CITED`.

Insertion is always a reviewed diff.

1. The papers are linked to the project (needed for the `.bib` preview).
2. The runtime builds a proposal through the M2 proposal service, with the
   `.tex` change and the `.bib` additions shown as diffs (`lineDiff`,
   `bibChangesFor`).
3. The researcher reviews both in the proposal dialog and accepts or rejects.
4. On acceptance, the `.bib` change is applied first, then the `.tex` change,
   with the proposal service's compare-and-swap. A file changed in between
   fails with `STALE_PROPOSAL` and nothing is written.

If the claim's sentence can no longer be found, the request fails with
`ANCHOR_LOST`. Adding the citation does not make the claim's anchor need
revalidation (citations are ignored in the materiality check).

## 5. Grouping

`groupCitations` looks for runs of adjacent claims in the same paragraph that
rest on the same papers. It suggests citing them once, after the last claim
of the run, instead of after every sentence. This is only a suggestion shown
in review. More references do not mean more support.
