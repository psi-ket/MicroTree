import type { Assessment, ClaimStatus, ConflictCategory } from '@research-studio/shared-types';

export const ASSESSMENT_LABEL: Record<Assessment, string> = {
  direct_support: 'States the claim',
  partial_support: 'Supports part',
  indirect_support: 'Indirect support',
  context_only: 'Context only',
  contradiction: 'May contradict',
  insufficient: 'Not enough to decide',
  irrelevant: 'Unrelated',
  not_assessed: 'Not assessed',
};

export const ASSESSMENT_TONE: Record<Assessment, 'success' | 'warning' | 'danger' | 'neutral'> = {
  direct_support: 'success',
  partial_support: 'warning',
  indirect_support: 'neutral',
  context_only: 'neutral',
  contradiction: 'danger',
  insufficient: 'neutral',
  irrelevant: 'neutral',
  not_assessed: 'neutral',
};

/** Status wording that never claims proof. */
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  unchecked: 'Not checked',
  analyzing: 'Being analysed',
  supporting_evidence_found: 'Supporting evidence found',
  partially_supported: 'Partly supported',
  potentially_contradicted: 'Possible disagreement',
  insufficient_evidence: 'Evidence insufficient',
  contextual_evidence_only: 'Context only',
  not_assessable: 'Needs no source',
  needs_revalidation: 'Check again (text changed)',
  user_reviewed: 'Reviewed by you',
};

export const STATUS_TONE: Record<ClaimStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  unchecked: 'neutral',
  analyzing: 'neutral',
  supporting_evidence_found: 'success',
  partially_supported: 'warning',
  potentially_contradicted: 'danger',
  insufficient_evidence: 'warning',
  contextual_evidence_only: 'neutral',
  not_assessable: 'neutral',
  needs_revalidation: 'warning',
  user_reviewed: 'success',
};

export const CONFLICT_LABEL: Record<ConflictCategory, string> = {
  direct_contradiction: 'Direct contradiction',
  conditional_disagreement: 'Conditional disagreement',
  methodological_disagreement: 'Different methods',
  different_assumptions: 'Different assumptions',
  different_regimes: 'Different regimes',
  different_definitions: 'Different definitions',
  apparent_disagreement: 'Apparent disagreement only',
  insufficient_information: 'Not enough information',
};
