import type { Assessment, Uncertainty } from '@research-studio/shared-types';

/** One evidence item for a claim as the recommender sees it. */
export interface EvidenceForCitation {
  recordId: string;
  assessmentId: string | null;
  scholarlyWorkId: string | null;
  libraryItemId: string | null;
  /** AI category, or the researcher's when they reclassified or accepted it. */
  assessment: Assessment;
  /** The researcher accepted this assessment. */
  accepted: boolean;
  /** The researcher rejected it or excluded the source. */
  rejected: boolean;
  stale: boolean;
  excerptVerified: boolean;
  uncertainty: Uncertainty;
  level: 'full_text' | 'abstract' | 'external_abstract';
}

export interface CitationCandidate {
  libraryItemId: string;
  scholarlyWorkId: string | null;
  /** The evidence the recommendation rests on. */
  best: EvidenceForCitation;
  /** Other supporting evidence from the same paper. */
  alsoSupporting: string[];
}

const STRENGTH: Partial<Record<Assessment, number>> = { direct_support: 2, partial_support: 1 };
const UNC: Record<Uncertainty, number> = { low: 0, medium: 1, high: 2 };

/**
 * Papers worth citing for a claim: only where a passage was judged to state
 * or partly state the claim (by the model with a verified excerpt, or by the
 * researcher), in the library, not rejected, not stale. One recommendation
 * per paper. Order: direct before partial, accepted before not yet reviewed,
 * full text before abstracts, lower uncertainty first. Citation counts,
 * venues and dates play no part. Contradicting papers are never recommended
 * as support (they are shown separately).
 */
export function recommendCitations(evidence: readonly EvidenceForCitation[], alreadyCitedItemIds: ReadonlySet<string> = new Set()): { candidates: CitationCandidate[]; alreadyCited: CitationCandidate[] } {
  const usable = evidence.filter((e) => STRENGTH[e.assessment] !== undefined && !e.rejected && !e.stale && e.libraryItemId && (e.accepted || e.excerptVerified) && e.level !== 'external_abstract');
  const byItem = new Map<string, EvidenceForCitation[]>();
  for (const e of usable) byItem.set(e.libraryItemId!, [...(byItem.get(e.libraryItemId!) ?? []), e]);
  const rank = (e: EvidenceForCitation) => [-(STRENGTH[e.assessment] ?? 0), e.accepted ? 0 : 1, e.level === 'full_text' ? 0 : 1, UNC[e.uncertainty]] as const;
  const cmp = (a: EvidenceForCitation, b: EvidenceForCitation) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return a.recordId.localeCompare(b.recordId);
  };
  const all: CitationCandidate[] = [...byItem.entries()].map(([itemId, es]) => {
    const sorted = [...es].sort(cmp);
    return { libraryItemId: itemId, scholarlyWorkId: sorted[0]!.scholarlyWorkId, best: sorted[0]!, alsoSupporting: sorted.slice(1).map((e) => e.recordId) };
  });
  all.sort((a, b) => cmp(a.best, b.best));
  return { candidates: all.filter((c) => !alreadyCitedItemIds.has(c.libraryItemId)), alreadyCited: all.filter((c) => alreadyCitedItemIds.has(c.libraryItemId)) };
}

export interface GroupableClaim {
  claimId: string;
  blockId: string;
  sentenceOrder: number;
  itemIds: readonly string[];
}

export interface CitationGroup {
  claimIds: string[];
  itemIds: string[];
  /** Cite once, after the last claim of the group. */
  placeAfterClaimId: string;
}

/**
 * Suggest one citation for a run of adjacent claims in the same paragraph
 * that rest on the same papers, instead of repeating it after every
 * sentence. Only a suggestion; more references do not mean more support.
 */
export function groupCitations(claims: readonly GroupableClaim[]): CitationGroup[] {
  const sorted = [...claims].sort((a, b) => a.blockId.localeCompare(b.blockId) || a.sentenceOrder - b.sentenceOrder);
  const groups: CitationGroup[] = [];
  const key = (ids: readonly string[]) => [...ids].sort().join(',');
  let run: GroupableClaim[] = [];
  const close = () => {
    if (run.length > 1 && run[0]!.itemIds.length) groups.push({ claimIds: run.map((c) => c.claimId), itemIds: [...run[0]!.itemIds].sort(), placeAfterClaimId: run.at(-1)!.claimId });
    run = [];
  };
  for (const c of sorted) {
    const last = run.at(-1);
    if (last && last.blockId === c.blockId && c.sentenceOrder - last.sentenceOrder <= 1 && key(last.itemIds) === key(c.itemIds)) run.push(c);
    else {
      close();
      run = [c];
    }
  }
  close();
  return groups;
}
