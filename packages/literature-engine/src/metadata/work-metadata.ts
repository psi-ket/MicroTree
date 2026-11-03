import type { LiteratureProviderId, ScholarlyWork, WorkIdentifiers } from '@research-studio/shared-types';
import { normalizeDoi, normalizeOpenAlexId, normalizeSemanticScholarId, parseArxivId } from '../normalization/identifier-normalizer';

/**
 * Source precedence per field group, highest first. The reasons:
 * - Bibliographic data (title, venue, volume, pages, dates of the version of
 *   record) is deposited by publishers in Crossref; OpenAlex and Semantic
 *   Scholar derive theirs; arXiv describes the preprint.
 * - Abstracts: arXiv has the authors' own text; Semantic Scholar's is usually
 *   complete; OpenAlex rebuilds it from an inverted index; Crossref often has none.
 * - Open access: OpenAlex checks every location (incl. repositories).
 * - Citation counts differ by provider and are never merged; the displayed
 *   one is chosen by this order and always attributed.
 */
export const PRECEDENCE = {
  title: ['crossref', 'openalex', 'semantic-scholar', 'arxiv'],
  bibliographic: ['crossref', 'openalex', 'semantic-scholar', 'arxiv'],
  abstract: ['arxiv', 'semantic-scholar', 'openalex', 'crossref'],
  authors: ['crossref', 'openalex', 'arxiv', 'semantic-scholar'],
  publicationType: ['crossref', 'openalex', 'semantic-scholar', 'arxiv'],
  openAccess: ['openalex', 'semantic-scholar', 'arxiv', 'crossref'],
  pdf: ['openalex', 'arxiv', 'semantic-scholar', 'crossref'],
  citedBy: ['openalex', 'semantic-scholar', 'crossref'],
  references: ['openalex', 'crossref', 'semantic-scholar'],
} as const satisfies Record<string, readonly LiteratureProviderId[]>;

export type CanonicalScheme = 'doi' | 'arxiv' | 'openalex' | 'semantic-scholar';

/** Canonical work ID: the most stable identifier available. */
export function canonicalWorkId(ids: WorkIdentifiers, fallback: { provider: LiteratureProviderId; providerId: string }): string {
  if (ids.doi && !parseArxivId(ids.doi)) return `doi:${ids.doi}`;
  if (ids.arxivId) return `arxiv:${ids.arxivId}`;
  if (ids.openAlexId) return `openalex:${ids.openAlexId}`;
  if (ids.semanticScholarId) return `semantic-scholar:${ids.semanticScholarId}`;
  return `${fallback.provider}:${fallback.providerId}`;
}

/** Parse a canonical work ID (also accepts bare DOIs and arXiv IDs). */
export function parseWorkId(id: string): { scheme: CanonicalScheme; value: string } | null {
  const m = /^(doi|arxiv|openalex|semantic-scholar):(.+)$/i.exec(id.trim());
  if (m) {
    const scheme = m[1]!.toLowerCase() as CanonicalScheme;
    const raw = m[2]!;
    const value =
      scheme === 'doi'
        ? normalizeDoi(raw)
        : scheme === 'arxiv'
          ? (parseArxivId(raw)?.id ?? null)
          : scheme === 'openalex'
            ? normalizeOpenAlexId(raw)
            : normalizeSemanticScholarId(raw);
    if (!value) return null;
    // An arXiv DOI is the arXiv identifier in disguise.
    if (scheme === 'doi') {
      const arxiv = parseArxivId(value);
      if (arxiv) return { scheme: 'arxiv', value: arxiv.id };
    }
    return { scheme, value };
  }
  const arxiv = parseArxivId(id);
  if (arxiv) return { scheme: 'arxiv', value: arxiv.id };
  const doi = normalizeDoi(id);
  if (doi) return { scheme: 'doi', value: doi };
  return null;
}

/** All canonical keys a work can be found by. */
export function workKeys(work: ScholarlyWork): string[] {
  const keys = [work.id];
  const { doi, arxivId, openAlexId, semanticScholarId } = work.identifiers;
  if (doi && !parseArxivId(doi)) keys.push(`doi:${doi}`);
  if (arxivId) keys.push(`arxiv:${arxivId}`);
  if (openAlexId) keys.push(`openalex:${openAlexId}`);
  if (semanticScholarId) keys.push(`semantic-scholar:${semanticScholarId}`);
  return [...new Set(keys)];
}
