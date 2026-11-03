import type { InterpretedQuery } from '@research-studio/shared-types';
import { normalizeDoi, normalizeOpenAlexId, normalizeSemanticScholarId, parseArxivId } from '../normalization/identifier-normalizer';
import { contentTokens } from '../normalization/work-normalizer';

/**
 * Decide whether a query is an identifier (resolved exactly) or text
 * (searched). Only a query that is nothing but an identifier, possibly as a
 * URL or with a `doi:` / `arXiv:` prefix, counts as one.
 */
export function interpretQuery(raw: string): InterpretedQuery {
  const text = raw.trim();
  if (text && !/\s/.test(text)) {
    const arxiv = parseArxivId(text);
    if (arxiv) return { kind: 'arxiv', text, identifier: `${arxiv.id}${arxiv.version ?? ''}` };
    const doi = normalizeDoi(text);
    if (doi) return { kind: 'doi', text, identifier: doi };
    const openalex = /^(?:openalex:|https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?W\d{4,12}$/i.test(text) ? normalizeOpenAlexId(text) : null;
    if (openalex) return { kind: 'openalex', text, identifier: openalex };
    const s2 = normalizeSemanticScholarId(text);
    if (s2) return { kind: 'semantic-scholar', text, identifier: s2 };
  }
  return { kind: 'text', text, identifier: null };
}

/** Signals of what the user is after, read from the query text only. */
export interface QueryIntent {
  terms: string[];
  /** The whole query as one phrase (normalised). */
  phrase: string;
  /** Years written in the query (`… 2019`). */
  years: number[];
  wantsRecent: boolean;
  wantsReview: boolean;
}

const RECENT = new Set(['recent', 'latest', 'new', 'newest', 'current', 'advances', 'progress']);
const REVIEW = new Set(['review', 'survey', 'overview', 'tutorial', 'introduction', 'primer']);

export function queryIntent(text: string): QueryIntent {
  const terms = contentTokens(text);
  const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  return {
    terms: terms.filter((t) => !/^(19|20)\d{2}$/.test(t)),
    phrase: terms.join(' '),
    years,
    wantsRecent: terms.some((t) => RECENT.has(t)),
    wantsReview: terms.some((t) => REVIEW.has(t)),
  };
}
