import { z } from 'zod';
import { NON_CLAIM_KINDS } from '@research-studio/shared-types';
import { outputSpec } from '../model/structured';

/**
 * What the model returns when it extracts claims from numbered sentences.
 * Claims refer to sentences by number; their text must come from that
 * sentence (checked after the call). Types are an open set of short names;
 * the built-in ones are suggested in the prompt.
 */
export const ExtractedClaimSchema = z.object({
  sentence: z.number().int().min(1).max(500).describe('Number of the sentence the claim comes from'),
  claimText: z.string().min(3).max(1500).describe('The proposition, copied from the sentence where possible'),
  verbatim: z.boolean().describe('True when claimText is copied exactly from the sentence'),
  claimType: z.string().regex(/^[a-z][a-z-]{1,40}$/),
  atomicity: z.enum(['atomic', 'compound', 'uncertain']),
  entities: z.array(z.string().max(200)).max(20),
  concepts: z.array(z.string().max(200)).max(20),
  quantities: z.array(z.object({ value: z.string().max(60), unit: z.string().max(40).nullable(), context: z.string().max(200).nullable() })).max(20),
  assumptions: z.array(z.string().max(300)).max(10),
  requiresEvidence: z.boolean().describe('False for definitions, mathematical identities and statements about this manuscript itself'),
  reason: z.string().max(400),
});

export const ClaimExtractionSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(200),
  nonClaims: z.array(z.object({ sentence: z.number().int().min(1).max(500), kind: z.enum(NON_CLAIM_KINDS) })).max(500),
});
export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;
export const CLAIM_EXTRACTION_SPEC = outputSpec('claim_extraction', ClaimExtractionSchema);
