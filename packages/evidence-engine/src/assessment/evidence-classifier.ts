import type { Assessment, ClaimStatus } from '@research-studio/shared-types';

export interface AssessmentView {
  recordId: string;
  /** The AI category (null when not assessed yet). */
  ai: Assessment | null;
  /** The researcher's category when they reclassified it, or accepted (same as ai). */
  human: Assessment | null;
  /** Rejected by the researcher, or the source excluded. */
  excluded: boolean;
  stale: boolean;
}

export type AssessmentCounts = Record<Assessment, number>;

export const effective = (a: AssessmentView): Assessment | null => (a.excluded ? null : (a.human ?? a.ai));

/** Counts per category, so the UI shows support and disagreement side by side. */
export function countAssessments(items: readonly AssessmentView[]): AssessmentCounts {
  const out = { direct_support: 0, partial_support: 0, indirect_support: 0, context_only: 0, contradiction: 0, insufficient: 0, irrelevant: 0, not_assessed: 0 } satisfies AssessmentCounts;
  for (const a of items) {
    const e = effective(a);
    if (e && !a.stale) out[e]++;
  }
  return out;
}

/**
 * The aggregate status used for filters and counts. It never erases a
 * disagreement: any contradiction makes the claim `potentially_contradicted`
 * even when other passages support it (the counts are shown next to it).
 * "Supporting evidence found" means at least one passage was judged to state
 * the claim; it does not mean the claim is proven.
 */
export function claimStatus(input: { items: readonly AssessmentView[]; requiresEvidence: boolean; needsRevalidation: boolean; userReviewed: boolean; analyzing?: boolean }): ClaimStatus {
  if (input.analyzing) return 'analyzing';
  if (input.needsRevalidation) return 'needs_revalidation';
  if (input.userReviewed) return 'user_reviewed';
  if (!input.requiresEvidence) return 'not_assessable';
  const live = input.items.filter((a) => !a.stale);
  if (!live.length) return input.items.length ? 'needs_revalidation' : 'unchecked';
  const c = countAssessments(live);
  if (c.contradiction) return 'potentially_contradicted';
  if (c.direct_support) return 'supporting_evidence_found';
  if (c.partial_support) return 'partially_supported';
  if (c.indirect_support || c.context_only) return 'contextual_evidence_only';
  const assessed = live.some((a) => effective(a) !== null && effective(a) !== 'not_assessed');
  return assessed ? 'insufficient_evidence' : 'unchecked';
}
