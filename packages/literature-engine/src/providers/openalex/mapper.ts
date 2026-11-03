import type { PublicationType, ScholarlyAuthor, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeAuthor } from '../../normalization/author-normalizer';
import { normalizeDate, normalizeYear } from '../../normalization/date-normalizer';
import { normalizeDoi, normalizeIssn, normalizeOpenAlexId, normalizePmid, parseArxivId } from '../../normalization/identifier-normalizer';
import { baseRecord, cleanText, nonNegativeInt, safeUrl, stripMarkup } from '../../normalization/work-normalizer';
import type { OpenAlexWork } from './schemas';

/** Rebuild the abstract from OpenAlex's inverted index (word → positions); returns null when absent. */
export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: string[] = [];
  let count = 0;
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) {
      if (!Number.isInteger(p) || p < 0 || p > 100_000) continue;
      words[p] = word;
      count++;
    }
  }
  if (!count) return null;
  return cleanText(words.filter((w) => w !== undefined).join(' '));
}

/**
 * OpenAlex `article` covers journal and conference papers; the source type
 * tells them apart. Without a source type the record stays `other`.
 */
export function openAlexType(type: string | null | undefined, sourceType: string | null | undefined): PublicationType | null {
  switch (type) {
    case null:
    case undefined:
      return null;
    case 'article':
      return sourceType === 'journal' ? 'journal-article' : sourceType === 'conference' ? 'conference-paper' : 'other';
    case 'preprint':
      return 'preprint';
    case 'review':
      return 'review';
    case 'book':
      return 'book';
    case 'book-chapter':
      return 'book-chapter';
    case 'dissertation':
      return 'dissertation';
    case 'report':
      return 'report';
    case 'dataset':
      return 'dataset';
    case 'editorial':
      return 'editorial';
    case 'letter':
      return 'letter';
    case 'erratum':
      return 'erratum';
    default:
      return 'other';
  }
}

function arxivFromUrl(url: string | null | undefined): string | null {
  if (!url || !/arxiv\.org\//i.test(url)) return null;
  return parseArxivId(url)?.id ?? null;
}

export function mapOpenAlexWork(w: OpenAlexWork, retrievedAt: string, requestUrl: string | null): ScholarlySourceRecord | null {
  const workId = normalizeOpenAlexId(w.id);
  const title = stripMarkup(w.title ?? w.display_name);
  if (!workId || !title) return null;
  const r = baseRecord('openalex', workId, title, retrievedAt, requestUrl);
  r.recordUrl = `https://openalex.org/${workId}`;
  r.abstract = abstractFromInvertedIndex(w.abstract_inverted_index);

  r.authors = (w.authorships ?? [])
    .map((a) =>
      normalizeAuthor({
        name: a.author?.display_name ?? a.raw_author_name,
        orcid: a.author?.orcid,
        affiliations: (a.institutions ?? []).map((i) => i.display_name),
        provider: 'openalex',
        providerId: normalizeOpenAlexId(a.author?.id, 'A'),
      }),
    )
    .filter((a): a is ScholarlyAuthor => a !== null);

  r.dates.published = normalizeDate(w.publication_date);
  r.publicationYear = normalizeYear(w.publication_year);
  r.dates.updated = normalizeDate(w.updated_date);

  const primary = w.primary_location;
  const source = primary?.source;
  r.venue = cleanText(source?.display_name);
  r.publisher = cleanText(source?.host_organization_name);
  r.rawType = w.type ?? null;
  r.publicationType = openAlexType(w.type, source?.type);

  const doi = normalizeDoi(w.doi);
  const arxiv = (doi ? parseArxivId(doi)?.id : null) ?? arxivFromUrl(primary?.landing_page_url) ?? arxivFromUrl(w.best_oa_location?.landing_page_url);
  r.identifiers = {
    doi,
    arxivId: arxiv ?? null,
    openAlexId: workId,
    semanticScholarId: null,
    pmid: normalizePmid(typeof w.ids?.pmid === 'string' ? w.ids.pmid : null),
  };

  r.urls.landingPage = safeUrl(primary?.landing_page_url) ?? (doi ? `https://doi.org/${doi}` : null);
  r.urls.pdf = safeUrl(w.best_oa_location?.pdf_url) ?? safeUrl(primary?.pdf_url);
  if (arxiv) r.urls.abstract = `https://arxiv.org/abs/${arxiv}`;

  r.openAccess = {
    isOpenAccess: w.open_access?.is_oa ?? null,
    status: cleanText(w.open_access?.oa_status),
    license: cleanText(w.best_oa_location?.license ?? primary?.license),
    pdfUrl: safeUrl(w.best_oa_location?.pdf_url),
  };

  r.citedByCount = nonNegativeInt(w.cited_by_count);
  r.referenceCount = nonNegativeInt(w.referenced_works_count);

  const first = cleanText(w.biblio?.first_page);
  const last = cleanText(w.biblio?.last_page);
  r.bibliographic = {
    volume: cleanText(w.biblio?.volume),
    issue: cleanText(w.biblio?.issue),
    pages: first && last && first !== last ? `${first}-${last}` : first,
    issn: [...new Set((source?.issn ?? []).map((i) => normalizeIssn(i)).filter((i): i is string => i !== null))],
  };

  if (w.primary_topic?.field?.display_name) r.categories.push({ scheme: 'openalex-field', value: w.primary_topic.field.display_name });
  if (w.primary_topic?.display_name) r.categories.push({ scheme: 'openalex-topic', value: w.primary_topic.display_name });

  const extra: Record<string, unknown> = {};
  if (w.is_retracted !== null && w.is_retracted !== undefined) extra.isRetracted = w.is_retracted;
  if (w.language) extra.language = w.language;
  if (source?.type) extra.sourceType = source.type;
  if (primary?.version) extra.locationVersion = primary.version;
  if (typeof w.ids?.mag === 'string') extra.magId = w.ids.mag;
  if (w.referenced_works?.length) extra.referencedWorks = w.referenced_works.map((id) => normalizeOpenAlexId(id)).filter(Boolean).slice(0, 500);
  r.extra = extra;
  return r;
}
