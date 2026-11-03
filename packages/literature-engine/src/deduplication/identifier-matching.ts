import type { ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeDoi, parseArxivId } from '../normalization/identifier-normalizer';

/**
 * Strong identifiers of a record, as comparable keys. arXiv DOIs
 * (10.48550/arXiv.…) count as arXiv identifiers, not as DOIs, so a preprint's
 * DataCite DOI never conflicts with its journal DOI.
 */
export function identifierKeys(record: ScholarlySourceRecord): string[] {
  const keys: string[] = [];
  const doi = journalDoi(record);
  if (doi) keys.push(`doi:${doi}`);
  const arxiv = arxivIdOf(record);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  if (record.identifiers.openAlexId) keys.push(`openalex:${record.identifiers.openAlexId}`);
  if (record.identifiers.semanticScholarId) keys.push(`semantic-scholar:${record.identifiers.semanticScholarId}`);
  if (record.identifiers.pmid) keys.push(`pmid:${record.identifiers.pmid}`);
  return keys;
}

/** The record's DOI unless it is an arXiv DOI. */
export function journalDoi(record: ScholarlySourceRecord): string | null {
  const doi = normalizeDoi(record.identifiers.doi);
  if (!doi) return null;
  return parseArxivId(doi) ? null : doi;
}

/** arXiv identifier (no version), from the field or an arXiv DOI. */
export function arxivIdOf(record: ScholarlySourceRecord): string | null {
  if (record.identifiers.arxivId) return parseArxivId(record.identifiers.arxivId)?.id ?? null;
  const doi = normalizeDoi(record.identifiers.doi);
  return doi ? (parseArxivId(doi)?.id ?? null) : null;
}

/** Identifier sets of a group of records, used to refuse merges that would mix two works. */
export interface IdentitySet {
  dois: Set<string>;
  arxivIds: Set<string>;
}

export function identityOf(records: ScholarlySourceRecord[]): IdentitySet {
  const dois = new Set<string>();
  const arxivIds = new Set<string>();
  for (const r of records) {
    const doi = journalDoi(r);
    if (doi) dois.add(doi);
    const arxiv = arxivIdOf(r);
    if (arxiv) arxivIds.add(arxiv);
  }
  return { dois, arxivIds };
}

/**
 * Two groups may merge only if together they name at most one journal DOI and
 * at most one arXiv identifier. Two different DOIs mean two different works
 * (e.g. an article and its erratum, or two parts of a series).
 */
export function identitiesCompatible(a: IdentitySet, b: IdentitySet): boolean {
  const dois = new Set([...a.dois, ...b.dois]);
  const arxiv = new Set([...a.arxivIds, ...b.arxivIds]);
  return dois.size <= 1 && arxiv.size <= 1;
}
