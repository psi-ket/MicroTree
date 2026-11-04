import type { WritingOperation } from '@research-studio/shared-types';
import { checkPreservation, type PreservationCheck } from './citation-preservation';
import { checkMeaning, type MeaningCheck } from './meaning-preservation';

export interface RewriteValidation {
  /** False when the rewrite must not be offered (it dropped citations or references). */
  offerable: boolean;
  preservation: PreservationCheck;
  meaning: MeaningCheck;
  warnings: string[];
}

const MATH_OPS: readonly WritingOperation[] = ['math-explanation', 'equation-transitions'];

/**
 * Checks every rewrite before it is shown. Citations and cross-references
 * must be kept (a rewrite that drops one is refused); added citations,
 * changed mathematics, and propositions whose substance changed are warned
 * about; the model's own report of a meaning change is shown too.
 */
export function validateRewrite(op: WritingOperation, original: string, proposed: string, modelSaysChanged: boolean): RewriteValidation {
  const preservation = checkPreservation(original, proposed);
  const meaning = checkMeaning(original, proposed);
  const warnings: string[] = [];
  if (preservation.missingCitations.length) warnings.push(`The rewrite removes citations: ${preservation.missingCitations.join(', ')}.`);
  if (preservation.missingRefs.length) warnings.push(`The rewrite removes references or labels: ${preservation.missingRefs.join(', ')}.`);
  if (preservation.addedCitations.length) warnings.push(`The rewrite adds citations that you did not choose: ${preservation.addedCitations.join(', ')}.`);
  if (preservation.mathChanged) warnings.push(MATH_OPS.includes(op) ? 'A formula changed although this operation should only change the prose.' : 'The mathematics changed.');
  if (!meaning.preserved) warnings.push(meaning.summary);
  if (modelSaysChanged) warnings.push('The model reports that the technical meaning changed.');
  const offerable = !preservation.missingCitations.length && !preservation.missingRefs.length && !preservation.addedCitations.length;
  return { offerable, preservation, meaning, warnings };
}
