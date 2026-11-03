import { familyKey } from '@research-studio/literature-engine';
import type { MatchCandidate, MatchConfidence, MetadataMatch, ScholarlyWork } from '@research-studio/shared-types';
import { LibraryCancelledError } from '../errors/library-errors';
import type { ImportedReference, ScholarlyLookup } from '../library/library-types';
import { identifiersFromPdf, type FoundIdentifier } from './identifier-extractor';
import { isExact, overallConfidence, rankCandidates, scoreCandidate, type MatchEvidence } from './metadata-matcher';
import type { PdfMetadata } from './pdf-metadata';

export interface ResolveOutcome {
  confidence: MatchConfidence;
  candidates: MatchCandidate[];
  extracted: MetadataMatch['extracted'];
  /** The candidate to apply without asking: only for an exact identifier match. */
  automatic: MatchCandidate | null;
  /** Provider problems met on the way (the outcome may be weaker because of them). */
  problems: string[];
}

const MAX_DOIS = 3;
const MAX_ARXIV = 2;
const SEARCH_LIMIT = 5;

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new LibraryCancelledError();
}

function problem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function viaIdentifiers(
  evidence: MatchEvidence,
  dois: FoundIdentifier[],
  arxivIds: FoundIdentifier[],
  lookup: ScholarlyLookup,
  problems: string[],
  signal?: AbortSignal,
): Promise<MatchCandidate[]> {
  const out: MatchCandidate[] = [];
  const tryOne = async (kind: 'doi' | 'arxiv', id: FoundIdentifier) => {
    checkAbort(signal);
    try {
      const res = kind === 'doi' ? await lookup.resolveDoi(id.value, signal) : await lookup.resolveArxiv(id.value, signal);
      // The first work is the one the identifier names; the others were found through it.
      const work = res.works[0];
      if (work) out.push(scoreCandidate(work, evidence, { kind, identifier: id }));
    } catch (err) {
      checkAbort(signal);
      if ((err as { code?: string }).code !== 'NOT_FOUND') problems.push(problem(err));
    }
  };
  for (const d of dois.slice(0, MAX_DOIS)) {
    await tryOne('doi', d);
    if (out.some((c) => isExact(c.confidence))) return out;
  }
  for (const a of arxivIds.slice(0, MAX_ARXIV)) {
    await tryOne('arxiv', a);
    if (out.some((c) => isExact(c.confidence))) return out;
  }
  return out;
}

async function viaTitle(evidence: MatchEvidence, lookup: ScholarlyLookup, problems: string[], signal?: AbortSignal): Promise<MatchCandidate[]> {
  if (!evidence.title) return [];
  checkAbort(signal);
  try {
    const firstAuthor = evidence.authors[0];
    const family = firstAuthor ? familyKey({ name: firstAuthor, familyName: null }) : null;
    const res = await lookup.search(evidence.title, { mode: 'title', limit: SEARCH_LIMIT, ...(family ? { author: family } : {}) }, signal);
    return res.works.map((w: ScholarlyWork) => scoreCandidate(w, evidence, { kind: 'search' }));
  } catch (err) {
    checkAbort(signal);
    problems.push(problem(err));
    return [];
  }
}

function finish(candidates: MatchCandidate[], extracted: MetadataMatch['extracted'], problems: string[]): ResolveOutcome {
  const ranked = rankCandidates(candidates);
  const confidence = overallConfidence(ranked);
  return { confidence, candidates: ranked, extracted, automatic: isExact(confidence) ? ranked[0]! : null, problems };
}

/** Identify a PDF: identifiers in its metadata and text first, then a title search. */
export async function resolvePdf(meta: PdfMetadata, fileName: string, lookup: ScholarlyLookup, signal?: AbortSignal): Promise<ResolveOutcome> {
  const ids = identifiersFromPdf(meta);
  const title = ids.metadataTitle ?? ids.textTitle;
  const evidence: MatchEvidence = { title, authors: ids.authors, year: null, text: meta.text };
  const problems: string[] = [];
  const candidates = await viaIdentifiers(evidence, ids.dois, ids.arxivIds, lookup, problems, signal);
  if (!candidates.some((c) => isExact(c.confidence))) candidates.push(...(await viaTitle(evidence, lookup, problems, signal)));
  return finish(
    candidates,
    {
      dois: ids.dois.map((d) => d.value),
      arxivIds: ids.arxivIds.map((a) => a.value),
      title,
      authors: ids.authors,
      titleSource: ids.metadataTitle ? 'pdf-metadata' : ids.textTitle ? 'pdf-text' : fileName ? 'file-name' : null,
    },
    problems,
  );
}

/** Identify an imported record (BibTeX, RIS, Zotero) through its DOI or arXiv ID, or its title when `searchTitle` is set. */
export async function resolveReference(
  ref: ImportedReference,
  lookup: ScholarlyLookup,
  options: { searchTitle: boolean },
  signal?: AbortSignal,
): Promise<ResolveOutcome> {
  const authors = ref.authors.map((a) => a.familyName ?? a.name ?? '').filter(Boolean);
  const evidence: MatchEvidence = { title: ref.title, authors, year: ref.publicationYear, text: null };
  const problems: string[] = [];
  const dois = ref.doi ? [{ value: ref.doi, source: 'record' as const, position: 0 }] : [];
  const arxivIds = ref.arxivId ? [{ value: ref.arxivId, source: 'record' as const, position: 0 }] : [];
  const candidates = await viaIdentifiers(evidence, dois, arxivIds, lookup, problems, signal);
  if (options.searchTitle && !candidates.some((c) => isExact(c.confidence))) candidates.push(...(await viaTitle(evidence, lookup, problems, signal)));
  return finish(candidates, { dois: dois.map((d) => d.value), arxivIds: arxivIds.map((a) => a.value), title: ref.title, authors, titleSource: ref.origin }, problems);
}

/** Resolve a DOI or arXiv ID typed by the user. */
export async function resolveIdentifier(kind: 'doi' | 'arxiv', value: string, lookup: ScholarlyLookup, signal?: AbortSignal): Promise<ResolveOutcome> {
  const problems: string[] = [];
  const id = { value, source: 'record' as const, position: 0 };
  const candidates = await viaIdentifiers({ title: null, authors: [], year: null, text: null }, kind === 'doi' ? [id] : [], kind === 'arxiv' ? [id] : [], lookup, problems, signal);
  return finish(candidates, { dois: kind === 'doi' ? [value] : [], arxivIds: kind === 'arxiv' ? [value] : [], title: null, authors: [], titleSource: null }, problems);
}
