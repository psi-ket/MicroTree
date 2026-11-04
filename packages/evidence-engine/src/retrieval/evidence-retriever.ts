import { buildClaimQueries, type QueryVariant } from './claim-query-builder';
import { fuseAndDiversify, type RankedCandidate } from './source-ranking';
import type { EvidenceSearchPort, PassageCandidate } from './types';

export interface RetrievalOptions {
  limit?: number;
  perPaper?: number;
  /** Also match stored abstracts of library papers without full text. */
  abstracts?: boolean;
  /** Also search connected scholarly sources (M3.1); results are abstract level and outside the library. */
  external?: boolean;
  signal?: AbortSignal;
}

export interface RetrievalResult {
  candidates: RankedCandidate[];
  variants: QueryVariant[];
  semanticUsed: boolean;
  indexVersion: string;
  warnings: string[];
}

/**
 * Retrieve candidate evidence for one claim from indexed papers. Every
 * candidate is an actual passage (or a stored abstract), returned with its
 * provenance and its relevance ranks; nothing is generated. Support is
 * decided later, separately.
 */
export async function retrieveEvidence(claim: { claimText: string; entities?: readonly string[]; concepts?: readonly string[] }, port: EvidenceSearchPort, opts: RetrievalOptions = {}): Promise<RetrievalResult> {
  const limit = opts.limit ?? 10;
  const variants = buildClaimQueries(claim, Math.max(20, limit * 2));
  const lists: { variant: string; results: PassageCandidate[] }[] = [];
  const warnings: string[] = [];
  let semanticUsed = false;
  for (const v of variants) {
    if (opts.signal?.aborted) break;
    const r = await port.search(v, opts.signal);
    semanticUsed ||= r.semanticUsed;
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    lists.push({ variant: v.variant, results: r.candidates });
  }
  if (opts.abstracts !== false && port.abstracts) {
    const terms = [...new Set([...(claim.concepts ?? []), ...(claim.entities ?? [])])];
    const abstracts = await port.abstracts(terms.length ? terms : [claim.claimText], 10);
    if (abstracts.length) lists.push({ variant: 'abstract', results: abstracts });
  }
  if (opts.external && port.external) {
    try {
      const ext = await port.external(variants[0]?.query ?? claim.claimText, 10, opts.signal);
      if (ext.length) lists.push({ variant: 'external', results: ext });
    } catch (err) {
      warnings.push(`External search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const candidates = fuseAndDiversify(lists, { limit, perPaper: opts.perPaper ?? 2 });
  if (!candidates.length) warnings.push('No passage in the searched papers matched this claim.');
  if (candidates.length && candidates.every((c) => c.level !== 'full_text')) warnings.push('Only abstract-level matches were found; full text is not available for these papers.');
  return { candidates, variants, semanticUsed, indexVersion: port.indexVersion(), warnings };
}
