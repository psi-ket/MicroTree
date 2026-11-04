import type { TokenUsage } from '@research-studio/shared-types';
import type { Assessment, ConflictCategory } from '@research-studio/shared-types';
import { ask, fence, type ModelTarget } from '../model/structured';
import { CONFLICT_SYSTEM } from '../prompts';
import type { PassageCandidate } from '../retrieval/types';
import { CONFLICT_SPEC, type ConflictAnalysis } from '../schemas/assessment.schema';

export interface ConflictPair<T> {
  supporting: T;
  opposing: T;
}

/** Pairs to analyse for one claim: each supporting or partly supporting passage against each contradicting one. */
export function conflictPairs<T extends { assessment: Assessment | null }>(items: readonly T[], max = 6): ConflictPair<T>[] {
  const sup = items.filter((i) => i.assessment === 'direct_support' || i.assessment === 'partial_support');
  const opp = items.filter((i) => i.assessment === 'contradiction');
  const out: ConflictPair<T>[] = [];
  for (const o of opp) for (const s of sup) if (out.length < max) out.push({ supporting: s, opposing: o });
  return out;
}

const CONDITIONAL: ReadonlySet<string> = new Set(['physical-regime', 'assumptions', 'definitions', 'parameter-range', 'experimental-conditions', 'model-system', 'boundary-conditions', 'approximations']);

export interface ConflictOutcome {
  analysis: ConflictAnalysis;
  notes: string[];
  usage: TokenUsage | null;
}

const describe = (c: PassageCandidate) => `${c.paper.title} (${c.paper.year ?? 'n.d.'})${c.sectionPath ? `, section "${c.sectionPath}"` : ''}${c.pageStart ? `, page ${c.pageStart}` : ''}`;

/**
 * Compare a supporting and an opposing passage for one claim. The category
 * is the model's, never resolved automatically; when it says "direct
 * contradiction" while listing differences of regime, assumptions or
 * definitions, a note asks the researcher to check whether the
 * disagreement is only conditional.
 */
export async function analyseConflict(target: ModelTarget, claim: string, pair: ConflictPair<PassageCandidate>): Promise<ConflictOutcome> {
  const user = [
    'Claim:',
    fence('manuscript-claim', claim),
    `Passage A (judged to support the claim), from ${describe(pair.supporting)}:`,
    fence('paper-passage', pair.supporting.text),
    `Passage B (judged to contradict the claim), from ${describe(pair.opposing)}:`,
    fence('paper-passage', pair.opposing.text),
    'In "differences", "supporting" refers to passage A and "opposing" to passage B.',
  ].join('\n\n');
  const r = await ask(target, CONFLICT_SYSTEM, user, CONFLICT_SPEC);
  const notes: string[] = [];
  const conditional = r.value.differences.filter((d) => CONDITIONAL.has(d.aspect));
  if (r.value.category === 'direct_contradiction' && conditional.length) notes.push(`Labelled a direct contradiction although the passages differ in ${[...new Set(conditional.map((d) => d.aspect))].join(', ')}; check whether the disagreement is only conditional.`);
  return { analysis: r.value, notes, usage: r.usage };
}

export type { ConflictCategory };
