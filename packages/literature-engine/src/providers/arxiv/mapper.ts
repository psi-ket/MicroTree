import type { ScholarlyAuthor, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeAuthor } from '../../normalization/author-normalizer';
import { normalizeDate, yearOf } from '../../normalization/date-normalizer';
import { normalizeDoi, parseArxivId } from '../../normalization/identifier-normalizer';
import { baseRecord, cleanText, safeUrl } from '../../normalization/work-normalizer';
import type { ArxivEntry } from './schemas';

/**
 * An arXiv entry is a preprint record. Its `arxiv:doi` is the DOI the authors
 * gave for the published version; it is kept as the record's DOI (that is
 * what links preprint and publication) and marked as author-provided.
 * `journal_ref` is kept verbatim and never parsed into venue fields.
 */
export function mapArxivEntry(e: ArxivEntry, retrievedAt: string, requestUrl: string | null): ScholarlySourceRecord | null {
  const parsed = parseArxivId(e.id);
  const title = cleanText(e.title);
  if (!parsed || !title) return null;
  const versioned = `${parsed.id}${parsed.version ?? ''}`;
  const r = baseRecord('arxiv', versioned, title, retrievedAt, requestUrl);
  r.version = parsed.version;
  r.recordUrl = `https://arxiv.org/abs/${versioned}`;
  r.abstract = cleanText(e.summary);
  r.authors = e.authors
    .map((a) => normalizeAuthor({ name: a.name, affiliations: a.affiliations }))
    .filter((a): a is ScholarlyAuthor => a !== null);

  const submitted = normalizeDate(e.published);
  r.dates.submitted = submitted;
  r.dates.updated = normalizeDate(e.updated);
  // The preprint became public when it was first submitted.
  r.dates.published = submitted;
  r.publicationYear = yearOf(submitted);
  r.publicationType = 'preprint';
  r.rawType = 'arXiv e-print';

  const doi = normalizeDoi(e.doi);
  r.identifiers.arxivId = parsed.id;
  r.identifiers.doi = doi;

  const pdf = e.links.find((l) => l.title === 'pdf' || l.type === 'application/pdf');
  r.urls.abstract = safeUrl(e.links.find((l) => l.rel === 'alternate')?.href) ?? r.recordUrl;
  r.urls.landingPage = r.urls.abstract;
  r.urls.pdf = safeUrl(pdf?.href);
  // arXiv e-prints are free to read; the API does not report the licence.
  r.openAccess = { isOpenAccess: true, status: null, license: null, pdfUrl: r.urls.pdf };

  const cats = [...new Set([e.primaryCategory, ...e.categories].filter((c): c is string => !!c))];
  r.categories = cats.map((value) => ({ scheme: 'arxiv', value }));

  const extra: Record<string, unknown> = {};
  if (e.primaryCategory) extra.primaryCategory = e.primaryCategory;
  if (cleanText(e.comment)) extra.comment = cleanText(e.comment);
  if (cleanText(e.journalRef)) extra.journalRef = cleanText(e.journalRef);
  if (doi) extra.doiSource = 'author-provided DOI of the published version';
  r.extra = extra;
  return r;
}
