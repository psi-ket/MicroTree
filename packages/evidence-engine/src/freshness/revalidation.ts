import { assessChange, identityHash, type Materiality } from '@research-studio/claim-anchors';

export interface RevalidationPlan {
  material: boolean;
  change: Materiality;
  /** Assessments made against a different claim text that must be checked again. */
  staleAssessmentIds: string[];
}

/**
 * What a change to a claim's text means for its assessments. Only a material
 * change makes them stale; their rows are kept as history either way. A
 * supported status is never transferred to materially changed text.
 */
export function planRevalidation(oldText: string, newText: string, assessments: readonly { id: string; claimTextHash: string }[]): RevalidationPlan {
  const change = assessChange(oldText, newText);
  const newHash = identityHash(newText);
  const stale = change.material ? assessments.filter((a) => a.claimTextHash !== newHash).map((a) => a.id) : [];
  return { material: change.material, change, staleAssessmentIds: stale };
}
