import type { Assessment, EvidenceLevel, Uncertainty } from '@research-studio/shared-types';
import type { EvidenceAssessmentResult } from '../schemas/assessment.schema';
import { effectiveUncertainty } from './uncertainty-manager';

export interface ValidatedAssessment {
  assessment: Assessment;
  explanation: string;
  supportingText: string | null;
  excerptVerified: boolean;
  supportedSubclaims: string[];
  unsupportedSubclaims: string[];
  contradictoryStatements: string[];
  limitations: string[];
  uncertainty: Uncertainty;
  /** What validation changed or noticed, shown with the assessment. */
  validationNotes: string[];
}

/** Text for verbatim comparison: quotes, dashes, hyphenation at line ends and spacing normalised. */
export function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/(\w)-\s+(\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function excerptOccurs(excerpt: string, sources: readonly string[]): boolean {
  const e = comparable(excerpt).replace(/^["'.…\s]+|["'.…\s]+$/g, '');
  if (e.length < 8) return false;
  // An ellipsis joins pieces that must each occur.
  const pieces = e.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length >= 4);
  const hay = sources.map(comparable).join(' \u0000 ');
  return pieces.length > 0 && pieces.every((p) => hay.includes(p));
}

const SUPPORT: readonly Assessment[] = ['direct_support', 'partial_support', 'indirect_support', 'contradiction'];

/**
 * Check a model assessment against the passage before it is stored. A
 * support or contradiction category needs an excerpt that actually occurs in
 * the passage or its shown surroundings; otherwise the assessment is kept
 * for the record but becomes `not_assessed`. Abstract-level evidence carries
 * a limitation and higher uncertainty.
 */
export function validateAssessment(r: EvidenceAssessmentResult, ctx: { passage: string; context: readonly string[]; level: EvidenceLevel }): ValidatedAssessment {
  const notes: string[] = [];
  let assessment: Assessment = r.assessment;
  const excerpt = r.relevantExcerpt.trim();
  const verified = excerpt ? excerptOccurs(excerpt, [ctx.passage, ...ctx.context]) : false;
  if (SUPPORT.includes(assessment)) {
    if (!excerpt) {
      notes.push(`The model chose "${assessment}" without quoting the passage; not counted until reviewed.`);
      assessment = 'not_assessed';
    } else if (!verified) {
      notes.push('The quoted excerpt does not occur in the passage (possibly invented or paraphrased); not counted until reviewed.');
      assessment = 'not_assessed';
    }
  } else if (excerpt && !verified) {
    notes.push('The quoted excerpt does not occur in the passage.');
  }
  if (r.assessment === 'partial_support' && !r.unsupportedSubclaims.length) notes.push('Partial support without the unsupported parts named.');
  const limitations = [...r.limitations];
  if (ctx.level !== 'full_text') limitations.unshift(ctx.level === 'abstract' ? 'Judged from the abstract only; the full text was not available.' : 'Judged from an abstract of a paper that is not in the library.');
  return {
    assessment,
    explanation: r.explanation,
    supportingText: verified ? excerpt : null,
    excerptVerified: verified,
    supportedSubclaims: r.supportedSubclaims,
    unsupportedSubclaims: r.unsupportedSubclaims,
    contradictoryStatements: r.contradictoryStatements,
    limitations,
    uncertainty: effectiveUncertainty(r.uncertainty, { level: ctx.level, excerptVerified: verified || !SUPPORT.includes(r.assessment) }),
    validationNotes: notes,
  };
}
