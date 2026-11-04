import { extractTerms, normalizeClaimText } from '../claims/claim-normalizer';
import type { SearchQuery } from './types';

export interface QueryVariant extends SearchQuery {
  variant: 'claim' | 'terms' | 'phrase' | 'entities';
}

const HEDGES = /\b(widely|generally|often|usually|typically|commonly|may|might|can|could|is believed|it is known that|has been shown|well known|approximately|roughly|about)\b/gi;

/**
 * Query variants for one claim: the claim itself (hybrid: keyword and
 * semantic), its key terms (keyword), its technical phrases as exact phrases
 * (keyword), and its named entities (keyword). Hedges and citations are
 * removed; numbers stay, because they are often what a passage must match.
 */
export function buildClaimQueries(claim: { claimText: string; entities?: readonly string[]; concepts?: readonly string[] }, limit = 20): QueryVariant[] {
  const text = normalizeClaimText(claim.claimText).replace(/\$([^$]*)\$/g, ' $1 ').replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}^_]/g, ' ');
  const terms = extractTerms(claim.claimText);
  const entities = [...new Set([...(claim.entities ?? []), ...terms.entities])].slice(0, 6);
  const concepts = [...new Set([...(claim.concepts ?? []), ...terms.concepts])].slice(0, 8);
  const out: QueryVariant[] = [];
  const add = (v: QueryVariant) => {
    const q = v.query.replace(/\s+/g, ' ').trim().slice(0, 900);
    if (q && !out.some((o) => o.query === q && o.mode === v.mode)) out.push({ ...v, query: q });
  };
  add({ variant: 'claim', query: text.replace(HEDGES, ' '), mode: 'hybrid', limit });
  const keyTerms = [...new Set([...concepts.flatMap((c) => c.split(' ')), ...entities])].filter((w) => w.length > 2);
  if (keyTerms.length >= 2) add({ variant: 'terms', query: keyTerms.slice(0, 10).join(' '), mode: 'keyword', limit });
  for (const phrase of concepts.filter((c) => c.includes(' ') || c.includes('-')).slice(0, 2)) add({ variant: 'phrase', query: `"${phrase.replace(/"/g, '')}"`, mode: 'keyword', limit });
  if (entities.length) add({ variant: 'entities', query: entities.map((e) => (e.includes(' ') ? `"${e}"` : e)).join(' '), mode: 'keyword', limit });
  return out.slice(0, 5);
}
