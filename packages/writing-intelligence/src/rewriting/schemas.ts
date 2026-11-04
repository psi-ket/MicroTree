import { z } from 'zod';
import { outputSpec } from '@research-studio/evidence-engine';

export const RewriteSchema = z.object({
  proposedText: z.string().max(20000).describe('The rewritten LaTeX passage'),
  explanation: z.string().max(2000),
  changes: z.array(z.object({ before: z.string().max(1000), after: z.string().max(1000), reason: z.string().max(400) })).max(40),
  meaningChanged: z.boolean().describe('True if the technical meaning changed in any way'),
  warnings: z.array(z.string().max(400)).max(20),
});
export type RewriteAnswer = z.infer<typeof RewriteSchema>;
export const REWRITE_SPEC = outputSpec('rewrite', RewriteSchema);

export const ReviewFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        sentence: z.number().int().min(1).max(500).nullable(),
        excerpt: z.string().max(400).describe('Words copied from the passage'),
        problem: z.string().max(600),
        suggestion: z.string().max(600).nullable(),
        severity: z.enum(['info', 'suggestion', 'warning']),
      }),
    )
    .max(60),
});
export const REVIEW_FINDINGS_SPEC = outputSpec('writing_findings', ReviewFindingsSchema);
