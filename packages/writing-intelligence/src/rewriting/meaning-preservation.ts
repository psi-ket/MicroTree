import { assessChange, similarity, type Materiality } from '@research-studio/claim-anchors';
import { extractClaimsHeuristic } from '@research-studio/evidence-engine';
import { blockSentences } from '@research-studio/claim-anchors';

export interface PropositionChange {
  before: string;
  after: string | null;
  change: Materiality | null;
}

export interface MeaningCheck {
  /** False when any proposition changed materially, was dropped or was added. */
  preserved: boolean;
  changed: PropositionChange[];
  removed: string[];
  added: string[];
  summary: string;
}

const props = (text: string) =>
  extractClaimsHeuristic(blockSentences(text).map((s, i) => ({ sentenceId: String(i), blockId: 'b', text: s.text, sectionPath: '' }))).claims.map((c) => c.claimText);

/**
 * Compare the propositions of the original and the rewrite (extracted the
 * same way as claims). Each original proposition is paired with the most
 * similar new one and checked for material change (numbers, negation,
 * hedging, quantifiers, comparisons, causation, citations, terms). This is
 * an automatic check with known limits, not a guarantee; it is shown with
 * every rewrite so the author can judge.
 */
export function checkMeaning(original: string, proposed: string): MeaningCheck {
  const a = props(original);
  const b = props(proposed);
  const used = new Set<number>();
  const changed: PropositionChange[] = [];
  const removed: string[] = [];
  for (const p of a) {
    let best = -1;
    let bestSim = 0;
    b.forEach((q, j) => {
      if (used.has(j)) return;
      const s = similarity(p, q);
      if (s > bestSim) {
        bestSim = s;
        best = j;
      }
    });
    if (best === -1 || bestSim < 0.35) {
      removed.push(p);
      continue;
    }
    used.add(best);
    const change = assessChange(p, b[best]!, { strictTerms: false });
    if (change.material) changed.push({ before: p, after: b[best]!, change });
  }
  const added = b.filter((_q, j) => !used.has(j));
  const preserved = !changed.length && !removed.length && !added.length;
  const parts = [changed.length ? `${changed.length} proposition(s) changed in substance` : null, removed.length ? `${removed.length} dropped` : null, added.length ? `${added.length} added` : null].filter(Boolean);
  return { preserved, changed, removed, added, summary: preserved ? 'No change of substance was detected (automatic check).' : `Meaning may have changed: ${parts.join(', ')}.` };
}
