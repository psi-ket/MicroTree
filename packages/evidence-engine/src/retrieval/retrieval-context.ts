import type { PassageCandidate } from './types';

export interface AssessmentContext {
  before: string[];
  after: string[];
}

/** Surrounding passages for an assessment (empty for abstract-level evidence). */
export async function contextFor(c: PassageCandidate, neighbours?: (passageId: string) => Promise<AssessmentContext>): Promise<AssessmentContext> {
  if (!c.passageId || !neighbours) return { before: [], after: [] };
  const n = await neighbours(c.passageId);
  return { before: n.before.slice(-1), after: n.after.slice(0, 1) };
}
