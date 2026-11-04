import type { TokenUsage } from '@research-studio/shared-types';
import { EvidenceError } from '../errors';
import { ask, fence, type ModelTarget } from '../model/structured';
import { ASSESSMENT_SYSTEM } from '../prompts';
import type { AssessmentContext } from '../retrieval/retrieval-context';
import type { PassageCandidate } from '../retrieval/types';
import { ASSESSMENT_SPEC } from '../schemas/assessment.schema';
import { validateAssessment, type ValidatedAssessment } from './assessment-validator';

export interface ClaimForAssessment {
  claimText: string;
  claimType: string;
  originalText: string;
  sectionPath: string;
}

/** The prompt for one (claim, passage) pair. Untrusted texts are fenced; metadata is labelled as metadata. */
export function assessmentPrompt(claim: ClaimForAssessment, c: PassageCandidate, ctx: AssessmentContext): string {
  const where = [c.sectionPath ? `section "${c.sectionPath}"` : null, c.pageStart ? `page ${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ''}` : null].filter(Boolean).join(', ');
  const meta = [
    `Title: ${c.paper.title}`,
    `Authors: ${c.paper.authors.slice(0, 6).join(', ') || 'unknown'}`,
    `Year: ${c.paper.year ?? 'unknown'}; venue: ${c.paper.venue ?? 'unknown'}; type: ${c.paper.publicationType ?? 'unknown'}`,
    `Evidence level: ${c.level === 'full_text' ? 'full-text passage' : 'abstract only'}${where ? `; location: ${where}` : ''}`,
  ].join('\n');
  return [
    `Claim C1 (type: ${claim.claimType}; manuscript section: ${claim.sectionPath || 'unknown'}):`,
    fence('manuscript-claim', claim.claimText),
    `The manuscript sentence it comes from:`,
    fence('manuscript-sentence', claim.originalText),
    `Paper metadata (for orientation only; not evidence):`,
    fence('paper-metadata', meta),
    ctx.before.length ? `Text before the passage:\n${fence('paper-text', ctx.before.join('\n'))}` : '',
    `Passage P1:`,
    fence('paper-passage', c.text),
    ctx.after.length ? `Text after the passage:\n${fence('paper-text', ctx.after.join('\n'))}` : '',
    `Assess how passage P1 relates to claim C1. Use claimId "C1" and passageId "P1".`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface AssessmentOutcome {
  result: ValidatedAssessment;
  usage: TokenUsage | null;
  /** Characters of manuscript and source text sent. */
  sent: { manuscriptChars: number; sourceChars: number };
}

/** Assess one claim against one passage, then validate the answer against the passage. */
export async function assessSupport(target: ModelTarget, claim: ClaimForAssessment, c: PassageCandidate, ctx: AssessmentContext): Promise<AssessmentOutcome> {
  const r = await ask(target, ASSESSMENT_SYSTEM, assessmentPrompt(claim, c, ctx), ASSESSMENT_SPEC);
  if (r.value.claimId !== 'C1' || r.value.passageId !== 'P1') throw new EvidenceError('invalid-output', 'The assessment refers to a claim or passage that was not sent');
  return {
    result: validateAssessment(r.value, { passage: c.text, context: [...ctx.before, ...ctx.after], level: c.level }),
    usage: r.usage,
    sent: { manuscriptChars: claim.claimText.length + claim.originalText.length, sourceChars: c.text.length + ctx.before.join('').length + ctx.after.join('').length },
  };
}
