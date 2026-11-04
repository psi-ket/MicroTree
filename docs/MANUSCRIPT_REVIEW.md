# Evidence panel, Evidence Review Mode and coverage (M5)

Code: `apps/web/src/features/claim-analysis`, `evidence-review` and
`manuscript-review`.

## 1. Evidence panel

The Evidence toggle in the top bar opens a panel beside the editor. The
editor's context menu has "Check evidence for the selection".

- **With a selection.** The panel shows the selected text and finds its
  claims (with the rules, or with the model when one is chosen). Each claim
  is a card with its type, status, evidence, conflicts and citation
  recommendations.
- **Without a selection.** The claims of the open file are listed.
- **Evidence items** show the paper, the location (section and page), the
  exact passage with verified excerpts highlighted, the evidence level, the
  assessment, uncertainty and limitations. "Open in PDF" opens the M3.2 PDF
  viewer at the page with the passage highlighted.
- **Writing tab.** The writing tools for the selection (see
  [SCIENTIFIC_WRITING.md](SCIENTIFIC_WRITING.md)).

The editor gutter marks sentences that have claims. Colour and an icon show
the status, and the hover text names it, so colour is not the only signal.

## 2. Evidence Review Mode

`#/review?from=<projectId>` opens a full-screen review of the manuscript,
a section or chosen claims. It is started from the top bar.

- Claims are grouped by section and can be filtered by status, type and
  review state.
- Each claim shows its sentence in context, the evidence side by side and the
  conflict analysis, if any.
- Decisions (accept, reject, reclassify, exclude source, mark reviewed, note)
  are recorded per evidence record and shown with who made them and when.
- Section summaries list unsupported claims, claims needing citations, and
  claims with potential contradictions.
- With a review model chosen, the introduction is checked for whether it
  introduces the problem, establishes background, covers foundational and
  current work and separates what is known from what is open. The
  conclusion is checked for whether its findings are supported in the
  manuscript, whether it goes beyond the results shown, whether it states
  limitations and whether it matches the objectives. Each item comes with
  the sentences it refers to.

A review run is stored in `manuscript_reviews` so that the latest one can be
reopened (`GET /projects/:id/review`).

## 3. Coverage without an aggregate score

There is no single "evidence score". `computeCoverage` reports counts, and
two ratios that each carry their numerator, denominator and definition.

Counts:
- total claims (archived claims are not counted),
- excluded claims,
- claims that need no external source (definitions, mathematical
  statements, assumptions and hypotheses unless changed). These are listed
  separately and never treated as missing citations,
- assessable claims, assessed claims and claims not yet assessed,
- claims per status (supporting evidence found, partially supported,
  potentially contradicted, insufficient evidence, contextual only, needs
  revalidation, user reviewed),
- claims with support the researcher accepted.

| Ratio | Numerator | Denominator |
| --- | --- | --- |
| Accepted support coverage | Assessed claims with at least one supporting assessment the researcher accepted | Assessable claims that have been assessed |
| Assessed share | Assessable claims that have been assessed | All assessable claims |

A ratio with a zero denominator is shown as "not available", not as 0 or 100%.
Section summaries give the same counts per section, plus the claims that
need evidence and cite nothing.

## 4. Accessibility

The panel and the review screen are checked with axe in the end-to-end test
(`e2e/evidence.spec.ts`). Status is given in text as well as colour, the tabs
and filters are keyboard reachable and the consent dialog traps focus and
names what will be sent.
