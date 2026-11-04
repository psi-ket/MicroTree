import type { EvidenceLevel, Uncertainty } from '@research-studio/shared-types';

const ORDER: Uncertainty[] = ['low', 'medium', 'high'];
export const maxUncertainty = (...xs: Uncertainty[]): Uncertainty => ORDER[Math.max(...xs.map((x) => ORDER.indexOf(x)))]!;

/** The uncertainty shown: the model's own, raised when the evidence is weaker than a verified full-text passage. */
export function effectiveUncertainty(model: Uncertainty, opts: { level: EvidenceLevel; excerptVerified: boolean }): Uncertainty {
  const floor: Uncertainty = opts.level === 'external_abstract' ? 'high' : opts.level === 'abstract' ? 'medium' : 'low';
  return maxUncertainty(model, floor, opts.excerptVerified ? 'low' : 'high');
}
