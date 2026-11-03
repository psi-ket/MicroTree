import type { PublicationType, ScholarlyAuthor, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeAuthor } from '../../normalization/author-normalizer';
import { normalizeDate, normalizeYear } from '../../normalization/date-normalizer';
import { normalizeDoi, normalizeIssn, normalizePmid, normalizeSemanticScholarId, parseArxivId } from '../../normalization/identifier-normalizer';
import { baseRecord, cleanText, nonNegativeInt, safeUrl } from '../../normalization/work-normalizer';
import type { S2Paper } from './schemas';

/**
 * Semantic Scholar lists several types per paper. Review wins over article
 * (a review is published as a journal article); arXiv-only papers usually
 * have no type, which stays null rather than being guessed as a preprint.
 */
export function s2Type(types: string[] | null | undefined): PublicationType | null {
  if (!types?.length) return null;
  const has = (t: string) => types.includes(t);
  if (has('Review') || has('MetaAnalysis')) return 'review';
  if (has('JournalArticle')) return 'journal-article';
  if (has('Conference')) return 'conference-paper';
  if (has('BookSection')) return 'book-chapter';
  if (has('Book')) return 'book';
  if (has('Dataset')) return 'dataset';
  if (has('Editorial')) return 'editorial';
  if (has('LettersAndComments')) return 'letter';
  return 'other';
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

export function mapS2Paper(p: S2Paper, retrievedAt: string, requestUrl: string | null): ScholarlySourceRecord | null {
  const paperId = normalizeSemanticScholarId(p.paperId);
  const title = cleanText(p.title);
  if (!paperId || !title) return null;
  const r = baseRecord('semantic-scholar', paperId, title, retrievedAt, requestUrl);
  r.recordUrl = safeUrl(p.url) ?? `https://www.semanticscholar.org/paper/${paperId}`;
  r.abstract = cleanText(p.abstract);

  r.authors = (p.authors ?? [])
    .map((a) => normalizeAuthor({ name: a.name, provider: 'semantic-scholar', providerId: a.authorId ?? null }))
    .filter((a): a is ScholarlyAuthor => a !== null);

  r.dates.published = normalizeDate(p.publicationDate);
  r.publicationYear = normalizeYear(p.year);
  r.venue = cleanText(p.publicationVenue?.name) ?? cleanText(p.venue) ?? cleanText(p.journal?.name);
  r.rawType = p.publicationTypes?.length ? p.publicationTypes.join(', ') : null;
  r.publicationType = s2Type(p.publicationTypes);

  const ext = p.externalIds ?? {};
  const doi = normalizeDoi(str(ext.DOI));
  const arxiv = parseArxivId(str(ext.ArXiv))?.id ?? (doi ? parseArxivId(doi)?.id : null) ?? null;
  r.identifiers = { doi, arxivId: arxiv, openAlexId: null, semanticScholarId: paperId, pmid: normalizePmid(str(ext.PubMed)) };

  r.urls.landingPage = doi ? `https://doi.org/${doi}` : r.recordUrl;
  r.urls.pdf = safeUrl(p.openAccessPdf?.url);
  if (arxiv) r.urls.abstract = `https://arxiv.org/abs/${arxiv}`;
  r.openAccess = {
    isOpenAccess: p.isOpenAccess ?? null,
    status: cleanText(p.openAccessPdf?.status)?.toLowerCase() ?? null,
    license: cleanText(p.openAccessPdf?.license),
    pdfUrl: safeUrl(p.openAccessPdf?.url),
  };

  r.citedByCount = nonNegativeInt(p.citationCount);
  r.referenceCount = nonNegativeInt(p.referenceCount);

  // `journal.volume` sometimes holds "volume issue" ("52 4"): only a single token is taken as the volume.
  const volume = cleanText(p.journal?.volume);
  const issn = normalizeIssn(p.publicationVenue?.issn);
  r.bibliographic = {
    volume: volume && !/\s/.test(volume) ? volume : null,
    issue: null,
    pages: cleanText(p.journal?.pages)?.replace(/\s*-\s*/, '-') ?? null,
    issn: issn ? [issn] : [],
  };

  r.categories = (p.fieldsOfStudy ?? []).map((value) => ({ scheme: 's2-field', value }));
  const extra: Record<string, unknown> = {};
  if (volume && /\s/.test(volume)) extra.journalVolume = volume;
  if (str(ext.CorpusId)) extra.corpusId = str(ext.CorpusId);
  if (str(ext.MAG)) extra.magId = str(ext.MAG);
  if (p.publicationVenue?.type) extra.venueType = p.publicationVenue.type;
  r.extra = extra;
  return r;
}
