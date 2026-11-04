import { containment } from '@research-studio/claim-anchors';
import type { ExtractedClaim } from '../schemas/claim.schema';

export interface ValidatedSpan {
  span: { start: number; end: number } | null;
  verbatim: boolean;
  problem: string | null;
}

/** Find `needle` in `haystack` ignoring differences in spacing; returns offsets in `haystack`. */
export function locate(haystack: string, needle: string): { start: number; end: number } | null {
  const pattern = needle
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s~]+');
  if (!pattern) return null;
  const m = new RegExp(pattern, 'i').exec(haystack);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * A claim must come from its sentence: verbatim text is located in it; a
 * paraphrase must reuse most of the sentence's words (otherwise it may add
 * content the author did not write) and is kept without a span.
 */
export function validateClaimText(sentence: string, claim: Pick<ExtractedClaim, 'claimText' | 'verbatim'>): ValidatedSpan {
  const text = claim.claimText.trim();
  const at = locate(sentence, text.replace(/[.;,]\s*$/, ''));
  if (at) return { span: at, verbatim: true, problem: null };
  const grounded = containment(text, sentence);
  if (grounded >= 0.6) return { span: null, verbatim: false, problem: claim.verbatim ? 'marked as verbatim but not found word for word; kept as a paraphrase' : null };
  return { span: null, verbatim: false, problem: `only ${Math.round(grounded * 100)}% of its words occur in the sentence; it may add content the sentence does not state` };
}
