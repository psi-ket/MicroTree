import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import type { EvidenceLevel, RetrievalMethod } from '@research-studio/shared-types';

/** A source text found for a claim, with everything needed to cite and re-check it. */
export interface PassageCandidate {
  level: EvidenceLevel;
  /** M3.3 passage ID (null for abstract-level evidence). */
  passageId: string | null;
  extractionId: string | null;
  attachmentId: string | null;
  libraryItemId: string | null;
  scholarlyWorkId: string | null;
  /** M3.1 canonical ID for works outside the library. */
  externalId: string | null;
  text: string;
  textHash: string | null;
  stableKey: string | null;
  sectionPath: string | null;
  sectionType: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
  sourceSha256: string | null;
  extractorVersion: string | null;
  paper: { title: string; authors: string[]; year: number | null; venue: string | null; doi: string | null; arxivId: string | null; publicationType: string | null; url: string | null };
  /** Ranks from the search that returned it (relevance, not support). */
  method: RetrievalMethod;
  keywordRank: number | null;
  semanticRank: number | null;
  score: number | null;
}

export interface SearchQuery {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  limit: number;
}

/**
 * What retrieval needs from the runtime. The runtime applies the scope
 * (library, collections, papers) and implements it over the M3.3 hybrid
 * search, the library's abstracts and, optionally, M3.1 literature search.
 */
export interface EvidenceSearchPort {
  search(q: SearchQuery, signal?: AbortSignal): Promise<{ candidates: PassageCandidate[]; semanticUsed: boolean; warnings: string[] }>;
  /** Library works without full text whose stored abstract mentions the terms. */
  abstracts?(terms: readonly string[], limit: number): Promise<PassageCandidate[]>;
  /** External scholarly search (abstract level, outside the library). */
  external?(query: string, limit: number, signal?: AbortSignal): Promise<PassageCandidate[]>;
  /** Neighbouring passages, for assessment context. */
  neighbours?(passageId: string): Promise<{ before: string[]; after: string[] }>;
  /** Identifies the index state (embedding space, extraction set) the results came from. */
  indexVersion(): string;
}
