import type { FusedHit } from '../hybrid-search/rrf';
import type { ParsedQuery } from '../query/query-parser';

/**
 * Optional second-stage ordering. M3.3 ships no learned reranker: the
 * default is the fused order. The interface exists so a local cross-encoder
 * can be added without changing callers; any reranker must keep the
 * component ranks it receives.
 */
export interface Reranker {
  id: string;
  rerank(query: ParsedQuery, hits: FusedHit[]): FusedHit[];
}

export const identityReranker: Reranker = { id: 'none', rerank: (_q, hits) => hits };
