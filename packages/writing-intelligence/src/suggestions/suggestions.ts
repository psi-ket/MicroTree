import type { ClaimStatus } from '@research-studio/shared-types';
import type { WritingFinding } from '../analysis/finding';

/** Suggestions for claims whose evidence is missing or weak: cite, qualify, or check. */
export function missingEvidenceSuggestions(claims: readonly { id: string; claimText: string; status: ClaimStatus; requiresEvidence: boolean; cited: boolean }[]): { claimId: string; message: string }[] {
  const out: { claimId: string; message: string }[] = [];
  for (const c of claims) {
    if (!c.requiresEvidence) continue;
    if (c.status === 'unchecked' && !c.cited) out.push({ claimId: c.id, message: 'No citation and no evidence checked yet; search the library for support.' });
    else if (c.status === 'insufficient_evidence') out.push({ claimId: c.id, message: 'The sources found do not say enough; cite a source that states it, or qualify the claim.' });
    else if (c.status === 'partially_supported') out.push({ claimId: c.id, message: 'Only part of the claim is supported; narrow it to what the sources state, or add a source for the rest.' });
    else if (c.status === 'contextual_evidence_only') out.push({ claimId: c.id, message: 'The sources give context but do not state the claim.' });
    else if (c.status === 'potentially_contradicted') out.push({ claimId: c.id, message: 'Some sources may disagree; compare them side by side before citing.' });
  }
  return out;
}

/** Wording suggestions from rule findings, most important first. */
export function wordingSuggestions(findings: readonly WritingFinding[]): WritingFinding[] {
  const order = { warning: 0, suggestion: 1, info: 2 } as const;
  return [...findings].sort((a, b) => order[a.severity] - order[b.severity] || (a.sentence ?? -1) - (b.sentence ?? -1));
}
