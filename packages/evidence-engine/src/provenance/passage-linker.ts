import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import type { PassageCandidate } from '../retrieval/types';

/** The M3.3 search result fields retrieval uses (structurally typed, so this package does not depend on the API). */
export interface HybridResultLike {
  passageId: string;
  keywordRank: number | null;
  semanticRank: number | null;
  score: number;
  matchedBy: 'keyword' | 'semantic' | 'hybrid';
  documentId: string;
  attachmentId: string;
  kind: string;
  sectionPath: string;
  sectionType: string;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  paper: { libraryItemId: string; title: string; authors: string[]; year: number | null; venue: string | null; doi: string | null; arxivId: string | null; publicationType: string | null };
  provenance: { sourceSha256: string; extractionId: string; extractorVersion: string | null; attachmentSourceUrl: string | null };
}

/** A full-text candidate from an M3.3 search hit, with the identifiers needed to verify it later. */
export function candidateFromHit(hit: HybridResultLike, extra: { scholarlyWorkId: string | null; textHash: string | null; stableKey: string | null; coordinates: DocumentCoordinate[] }): PassageCandidate {
  const url = hit.paper.doi ? `https://doi.org/${hit.paper.doi}` : hit.paper.arxivId ? `https://arxiv.org/abs/${hit.paper.arxivId}` : hit.provenance.attachmentSourceUrl;
  return {
    level: hit.kind === 'abstract' ? 'abstract' : 'full_text',
    passageId: hit.passageId,
    extractionId: hit.provenance.extractionId,
    attachmentId: hit.attachmentId,
    libraryItemId: hit.paper.libraryItemId,
    scholarlyWorkId: extra.scholarlyWorkId,
    externalId: null,
    text: hit.text,
    textHash: extra.textHash,
    stableKey: extra.stableKey,
    sectionPath: hit.sectionPath || null,
    sectionType: hit.sectionType,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
    coordinates: extra.coordinates,
    sourceSha256: hit.provenance.sourceSha256,
    extractorVersion: hit.provenance.extractorVersion,
    paper: { title: hit.paper.title, authors: hit.paper.authors, year: hit.paper.year, venue: hit.paper.venue, doi: hit.paper.doi, arxivId: hit.paper.arxivId, publicationType: hit.paper.publicationType, url: url ?? null },
    method: hit.matchedBy,
    keywordRank: hit.keywordRank,
    semanticRank: hit.semanticRank,
    score: hit.score,
  };
}
