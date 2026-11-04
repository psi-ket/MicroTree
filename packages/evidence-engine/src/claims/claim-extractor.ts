import type { TokenUsage } from '@research-studio/shared-types';
import { NO_EVIDENCE_BY_DEFAULT, type Atomicity, type BuiltInClaimType, type ClaimQuantity, type NonClaimKind } from '@research-studio/shared-types';
import { ask, fence, type ModelTarget } from '../model/structured';
import { EXTRACTION_SYSTEM } from '../prompts';
import { CLAIM_EXTRACTION_SPEC } from '../schemas/claim.schema';
import { splitAtomicClaims } from './atomic-claim-splitter';
import { classifySentence, guessClaimType } from './claim-classifier';
import { extractQuantities, extractTerms, normalizeClaimText } from './claim-normalizer';
import { validateClaimText } from './claim-validator';

/** One sentence offered for extraction, with its identity. */
export interface SentenceInput {
  sentenceId: string | null;
  blockId: string;
  text: string;
  sectionPath: string;
}

export interface CandidateClaim {
  /** Index into the input sentences. */
  sentenceIndex: number;
  sentenceId: string | null;
  blockId: string;
  originalText: string;
  claimText: string;
  span: { start: number; end: number } | null;
  normalizedText: string;
  claimType: string;
  atomicity: Atomicity;
  entities: string[];
  concepts: string[];
  quantities: ClaimQuantity[];
  assumptions: string[];
  requiresEvidence: boolean;
  extractedBy: 'heuristic' | 'model';
  notes: string[];
}

export interface NonClaim {
  sentenceIndex: number;
  kind: NonClaimKind;
  reason: string;
}

export interface ExtractionResult {
  claims: CandidateClaim[];
  nonClaims: NonClaim[];
  /** Model claims that were refused (not grounded in their sentence, unknown sentence). */
  rejected: { sentenceIndex: number; claimText: string; problem: string }[];
  usage: TokenUsage | null;
}

function base(s: SentenceInput, i: number, claimText: string, span: { start: number; end: number } | null, atomicity: Atomicity) {
  const terms = extractTerms(claimText);
  return {
    sentenceIndex: i,
    sentenceId: s.sentenceId,
    blockId: s.blockId,
    originalText: s.text,
    claimText,
    span,
    normalizedText: normalizeClaimText(claimText),
    atomicity,
    entities: terms.entities,
    concepts: terms.concepts,
    quantities: extractQuantities(claimText),
  };
}

/**
 * Deterministic extraction: non-claims are recognised and skipped, compound
 * sentences are split at clause joints, and each part gets a first type
 * guess. No model is involved; the manuscript is not changed.
 */
export function extractClaimsHeuristic(sentences: readonly SentenceInput[]): ExtractionResult {
  const claims: CandidateClaim[] = [];
  const nonClaims: NonClaim[] = [];
  sentences.forEach((s, i) => {
    const kind = classifySentence(s.text);
    if (!kind.claim) {
      nonClaims.push({ sentenceIndex: i, kind: kind.kind, reason: kind.reason });
      return;
    }
    const parts = splitAtomicClaims(s.text);
    for (const p of parts) {
      const type = guessClaimType(p.text);
      claims.push({
        ...base(s, i, p.text, { start: p.start, end: p.end }, 'atomic'),
        claimType: type,
        assumptions: [],
        requiresEvidence: !(NO_EVIDENCE_BY_DEFAULT as readonly string[]).includes(type),
        extractedBy: 'heuristic',
        notes: parts.length > 1 ? [`one of ${parts.length} propositions in the sentence`] : [],
      });
    }
  });
  return { claims, nonClaims, rejected: [], usage: null };
}

/**
 * Model extraction over numbered sentences. Every claim is checked against
 * its sentence: verbatim claims get their span, paraphrases must reuse most
 * of the sentence's words, anything else is rejected and reported.
 */
export async function extractClaimsWithModel(target: ModelTarget, sentences: readonly SentenceInput[]): Promise<ExtractionResult> {
  const numbered = sentences.map((s, i) => `${i + 1}. [section: ${s.sectionPath || 'none'}] ${s.text}`).join('\n');
  const user = `Sentences from the manuscript, numbered:\n${fence('manuscript', numbered)}\n\nExtract the claims and list the non-claims.`;
  const r = await ask(target, EXTRACTION_SYSTEM, user, CLAIM_EXTRACTION_SPEC);
  const claims: CandidateClaim[] = [];
  const rejected: ExtractionResult['rejected'] = [];
  const perSentence = new Map<number, number>();
  for (const c of r.value.claims) perSentence.set(c.sentence, (perSentence.get(c.sentence) ?? 0) + 1);
  for (const c of r.value.claims) {
    const i = c.sentence - 1;
    const s = sentences[i];
    if (!s) {
      rejected.push({ sentenceIndex: i, claimText: c.claimText, problem: 'refers to a sentence that was not sent' });
      continue;
    }
    if ((perSentence.get(c.sentence) ?? 0) > 6) {
      rejected.push({ sentenceIndex: i, claimText: c.claimText, problem: 'more than six claims for one sentence' });
      continue;
    }
    const v = validateClaimText(s.text, c);
    if (!v.span && v.problem && !v.problem.startsWith('marked as verbatim')) {
      rejected.push({ sentenceIndex: i, claimText: c.claimText, problem: v.problem });
      continue;
    }
    const compound = (perSentence.get(c.sentence) ?? 0) > 1;
    claims.push({
      ...base(s, i, c.claimText.trim(), v.span, c.atomicity === 'uncertain' ? 'uncertain' : c.atomicity === 'compound' && !compound ? 'compound' : 'atomic'),
      claimType: c.claimType,
      entities: c.entities.length ? c.entities : extractTerms(c.claimText).entities,
      concepts: c.concepts.length ? c.concepts : extractTerms(c.claimText).concepts,
      quantities: c.quantities.map((q) => ({ value: q.value, ...(q.unit ? { unit: q.unit } : {}), ...(q.context ? { context: q.context } : {}) })),
      assumptions: c.assumptions,
      requiresEvidence: c.requiresEvidence,
      extractedBy: 'model',
      notes: [...(v.problem ? [v.problem] : []), ...(compound ? [`one of ${perSentence.get(c.sentence)} propositions in the sentence`] : [])],
    });
  }
  const nonClaims: NonClaim[] = r.value.nonClaims.filter((n) => sentences[n.sentence - 1] && !claims.some((c) => c.sentenceIndex === n.sentence - 1)).map((n) => ({ sentenceIndex: n.sentence - 1, kind: n.kind, reason: 'identified by the model' }));
  return { claims, nonClaims, rejected, usage: r.usage };
}

/** Merge claims (by hand): one claim covering their combined text, keeping where it came from. */
export function mergeClaimTexts(texts: readonly string[]): string {
  return texts
    .map((t) => t.trim().replace(/[.;]\s*$/, ''))
    .join('; ')
    .concat('.');
}

export type { BuiltInClaimType };
