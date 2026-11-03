import type { PublicationType, ScholarlyAuthor, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeAuthor } from '../../normalization/author-normalizer';
import { fromDateParts, yearOf } from '../../normalization/date-normalizer';
import { normalizeDoi, normalizeIssn, parseArxivId } from '../../normalization/identifier-normalizer';
import { baseRecord, cleanText, nonNegativeInt, safeUrl, stripMarkup } from '../../normalization/work-normalizer';
import { CrossrefRelation, type CrossrefWork } from './schemas';

/** Crossref work types → normalised types. Crossref does not mark reviews, so none map to `review`. */
export function crossrefType(type: string | null | undefined, subtype: string | null | undefined): PublicationType | null {
  switch (type) {
    case null:
    case undefined:
      return null;
    case 'journal-article':
      return 'journal-article';
    case 'proceedings-article':
      return 'conference-paper';
    case 'posted-content':
      // List results carry no subtype (it cannot be selected); posted content is overwhelmingly preprints.
      return subtype === 'preprint' || !subtype ? 'preprint' : 'other';
    case 'book':
    case 'monograph':
    case 'edited-book':
    case 'reference-book':
    case 'book-set':
      return 'book';
    case 'book-chapter':
    case 'book-section':
    case 'book-part':
      return 'book-chapter';
    case 'dissertation':
      return 'dissertation';
    case 'report':
    case 'report-component':
      return 'report';
    case 'dataset':
      return 'dataset';
    default:
      return 'other';
  }
}

/** arXiv DOIs named in `relation` (`has-preprint`, `is-preprint-of`), i.e. a publisher-asserted preprint link. */
function relatedArxiv(relation: Record<string, unknown> | null | undefined): string | null {
  if (!relation) return null;
  for (const key of ['has-preprint', 'is-preprint-of', 'is-version-of', 'has-version']) {
    const parsed = CrossrefRelation.safeParse(relation[key]);
    if (!parsed.success) continue;
    for (const r of parsed.data) {
      if (r['id-type'] !== 'doi') continue;
      const id = parseArxivId(r.id ?? '')?.id;
      if (id) return id;
    }
  }
  return null;
}

export function mapCrossrefWork(w: CrossrefWork, retrievedAt: string, requestUrl: string | null): ScholarlySourceRecord | null {
  const doi = normalizeDoi(w.DOI);
  const title = stripMarkup(w.title?.[0]);
  if (!doi || !title) return null;
  const r = baseRecord('crossref', doi, title, retrievedAt, requestUrl);
  r.recordUrl = `https://api.crossref.org/works/${doi}`;
  r.abstract = stripMarkup(w.abstract);

  r.authors = (w.author ?? [])
    .map((a) =>
      normalizeAuthor({
        given: a.given,
        family: a.family,
        name: a.name,
        orcid: a.ORCID,
        affiliations: (a.affiliation ?? []).map((x) => x.name),
      }),
    )
    .filter((a): a is ScholarlyAuthor => a !== null);

  // `issued` is the earliest of print and online publication; keep all three.
  r.dates.published = fromDateParts(w.issued?.['date-parts']) ?? fromDateParts(w.published?.['date-parts']) ?? fromDateParts(w.posted?.['date-parts']);
  r.dates.publishedOnline = fromDateParts(w['published-online']?.['date-parts']);
  r.dates.publishedPrint = fromDateParts(w['published-print']?.['date-parts']);
  r.publicationYear = yearOf(r.dates.published);

  r.venue = stripMarkup(w['container-title']?.[0]);
  r.publisher = cleanText(w.publisher);
  r.rawType = w.subtype ? `${w.type ?? ''} (${w.subtype})` : (w.type ?? null);
  r.publicationType = crossrefType(w.type, w.subtype);

  const arxiv = parseArxivId(doi)?.id ?? relatedArxiv(w.relation);
  r.identifiers = { doi, arxivId: arxiv, openAlexId: null, semanticScholarId: null, pmid: null };
  r.urls.landingPage = safeUrl(w.URL) ?? `https://doi.org/${doi}`;
  const pdf = (w.link ?? []).find((l) => l['content-type'] === 'application/pdf' && l['intended-application'] !== 'text-mining');
  r.urls.pdf = safeUrl(pdf?.URL);

  // Crossref lists licences but does not say whether a work is open access.
  const vor = (w.license ?? []).find((l) => l['content-version'] === 'vor') ?? w.license?.[0];
  r.openAccess.license = safeUrl(vor?.URL);

  r.citedByCount = nonNegativeInt(w['is-referenced-by-count']);
  r.referenceCount = nonNegativeInt(w['references-count']);
  r.bibliographic = {
    volume: cleanText(w.volume),
    issue: cleanText(w.issue),
    pages: cleanText(w.page),
    issn: [...new Set((w.ISSN ?? []).map((i) => normalizeIssn(i)).filter((i): i is string => i !== null))],
  };
  r.categories = (w.subject ?? []).map((value) => ({ scheme: 'crossref-subject', value }));

  const extra: Record<string, unknown> = {};
  if (w.subtitle?.length) extra.subtitle = stripMarkup(w.subtitle[0]);
  if (w.language) extra.language = w.language;
  if (w['update-to']?.length) extra.updateTo = w['update-to'].map((u) => ({ type: u.type ?? null, doi: normalizeDoi(u.DOI) }));
  if (w.relation && Object.keys(w.relation).length) extra.relations = Object.keys(w.relation);
  r.extra = extra;
  return r;
}
