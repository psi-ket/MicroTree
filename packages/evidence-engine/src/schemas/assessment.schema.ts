import { z } from 'zod';
import { CONFLICT_CATEGORIES } from '@research-studio/shared-types';
import { outputSpec } from '../model/structured';

/** The support categories a model may return (`not_assessed` is set by validation, never by the model). */
export const MODEL_ASSESSMENTS = ['direct_support', 'partial_support', 'indirect_support', 'context_only', 'contradiction', 'insufficient', 'irrelevant'] as const;

export const EvidenceAssessmentSchema = z.object({
  claimId: z.string().max(80),
  passageId: z.string().max(200),
  assessment: z.enum(MODEL_ASSESSMENTS),
  explanation: z.string().max(2000),
  supportedSubclaims: z.array(z.string().max(500)).max(10),
  unsupportedSubclaims: z.array(z.string().max(500)).max(10),
  contradictoryStatements: z.array(z.string().max(500)).max(10),
  limitations: z.array(z.string().max(500)).max(10).describe('Differences in scope, population, method, regime, assumptions or definitions'),
  relevantExcerpt: z.string().max(2000).describe('Exact words copied from the passage; empty when nothing in it is relevant'),
  uncertainty: z.enum(['low', 'medium', 'high']),
});
export type EvidenceAssessmentResult = z.infer<typeof EvidenceAssessmentSchema>;
export const ASSESSMENT_SPEC = outputSpec('evidence_assessment', EvidenceAssessmentSchema);

export const ConflictAnalysisSchema = z.object({
  category: z.enum(CONFLICT_CATEGORIES),
  explanation: z.string().max(2000),
  differences: z
    .array(
      z.object({
        aspect: z.enum(['scope', 'definitions', 'physical-regime', 'experimental-conditions', 'assumptions', 'approximations', 'model-system', 'boundary-conditions', 'measurement-method', 'time-period', 'parameter-range', 'other']),
        supporting: z.string().max(500),
        opposing: z.string().max(500),
      }),
    )
    .max(12),
  uncertainty: z.enum(['low', 'medium', 'high']),
});
export type ConflictAnalysis = z.infer<typeof ConflictAnalysisSchema>;
export const CONFLICT_SPEC = outputSpec('conflict_analysis', ConflictAnalysisSchema);
