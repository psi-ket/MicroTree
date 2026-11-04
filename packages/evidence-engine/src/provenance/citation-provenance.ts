import type { Assessment, EvidenceLevel } from '@research-studio/shared-types';
import { locationText } from './source-provenance';

const LABEL: Record<Assessment, string> = {
  direct_support: 'states the claim',
  partial_support: 'supports part of the claim',
  indirect_support: 'supports the claim indirectly',
  context_only: 'gives context only',
  contradiction: 'appears to contradict the claim',
  insufficient: 'does not say enough to decide',
  irrelevant: 'is unrelated',
  not_assessed: 'has not been assessed',
};

/** Why a citation is recommended, in words that point to the passage and the judgement. */
export function citationReason(input: { assessment: Assessment; reviewed: boolean; level: EvidenceLevel; pageStart: number | null; pageEnd: number | null; sectionPath: string | null; explanation: string }): string {
  const who = input.reviewed ? 'You accepted that' : 'The assessment found that';
  return `${who} the passage (${locationText(input)}) ${LABEL[input.assessment]}. ${input.explanation}`.trim();
}

export const assessmentLabel = (a: Assessment) => LABEL[a];
