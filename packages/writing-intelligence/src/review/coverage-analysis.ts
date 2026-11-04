import type { ClaimReviewState, ClaimStatus } from '@research-studio/shared-types';

export interface ClaimForCoverage {
  id: string;
  sectionPath: string;
  status: ClaimStatus;
  reviewState: ClaimReviewState;
  requiresEvidence: boolean;
  /** At least one current assessment other than `not_assessed`. */
  assessed: boolean;
  /** At least one direct or partial support accepted by the researcher. */
  acceptedSupport: boolean;
  /** At least one direct support judged by the model with a verified excerpt (not yet reviewed). */
  modelSupport: boolean;
  /** Supporting works (for source diversity). */
  supportingWorkIds: readonly string[];
}

export interface Ratio {
  numerator: number;
  denominator: number;
  /** null when the denominator is zero. */
  value: number | null;
  definition: string;
}

export interface Coverage {
  totalClaims: number;
  excluded: number;
  noEvidenceNeeded: number;
  assessable: number;
  assessed: number;
  notYetAssessed: number;
  withSupportingEvidence: number;
  withAcceptedSupport: number;
  partiallySupported: number;
  potentiallyContradicted: number;
  insufficientEvidence: number;
  contextualOnly: number;
  needsRevalidation: number;
  userReviewed: number;
  ratios: { acceptedSupportCoverage: Ratio; assessedShare: Ratio };
}

const ratio = (n: number, d: number, definition: string): Ratio => ({ numerator: n, denominator: d, value: d ? Math.round((n / d) * 1000) / 1000 : null, definition });

/**
 * Evidence coverage with explicit denominators. Archived claims are not
 * counted; excluded claims and claims that need no external source
 * (definitions, identities, structural statements) are counted separately
 * and are never treated as missing citations. There is no overall score.
 */
export function computeCoverage(claims: readonly ClaimForCoverage[]): Coverage {
  const live = claims.filter((c) => c.reviewState !== 'archived');
  const excluded = live.filter((c) => c.reviewState === 'excluded');
  const counted = live.filter((c) => c.reviewState !== 'excluded');
  const noNeed = counted.filter((c) => !c.requiresEvidence);
  const assessable = counted.filter((c) => c.requiresEvidence);
  const assessed = assessable.filter((c) => c.assessed);
  const is = (s: ClaimStatus) => assessable.filter((c) => c.status === s).length;
  const accepted = assessed.filter((c) => c.acceptedSupport).length;
  return {
    totalClaims: live.length,
    excluded: excluded.length,
    noEvidenceNeeded: noNeed.length,
    assessable: assessable.length,
    assessed: assessed.length,
    notYetAssessed: assessable.length - assessed.length,
    withSupportingEvidence: is('supporting_evidence_found'),
    withAcceptedSupport: accepted,
    partiallySupported: is('partially_supported'),
    potentiallyContradicted: is('potentially_contradicted'),
    insufficientEvidence: is('insufficient_evidence'),
    contextualOnly: is('contextual_evidence_only'),
    needsRevalidation: is('needs_revalidation'),
    userReviewed: is('user_reviewed'),
    ratios: {
      acceptedSupportCoverage: ratio(accepted, assessed.length, 'Claims with at least one supporting assessment you accepted, divided by assessable claims that have been assessed.'),
      assessedShare: ratio(assessed.length, assessable.length, 'Assessable claims that have been assessed, divided by all assessable claims.'),
    },
  };
}
