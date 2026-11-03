import type {
  CitationObservation,
  LiteratureProviderId,
  MetadataConflict,
  ScholarlyAuthor,
  ScholarlySourceRecord,
  ScholarlyWork,
} from '@research-studio/shared-types';
import { LITERATURE_PROVIDERS } from '@research-studio/shared-types';
import { familyKey } from '../normalization/author-normalizer';
import { titleKey } from '../normalization/work-normalizer';
import { arxivIdOf, journalDoi } from '../deduplication/identifier-matching';
import { canonicalWorkId, PRECEDENCE } from './work-metadata';

const providerRank = (p: LiteratureProviderId) => LITERATURE_PROVIDERS.indexOf(p);
const versionNumber = (r: ScholarlySourceRecord) => (r.version ? Number(r.version.slice(1)) : 0);

/** Records ordered by a precedence list; within a provider the newest arXiv version first. */
function ordered(records: ScholarlySourceRecord[], order: readonly LiteratureProviderId[]): ScholarlySourceRecord[] {
  return records
    .filter((r) => order.includes(r.provider))
    .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider) || versionNumber(b) - versionNumber(a));
}

function pick<T>(records: ScholarlySourceRecord[], order: readonly LiteratureProviderId[], get: (r: ScholarlySourceRecord) => T | null): { value: T; provider: LiteratureProviderId } | null {
  for (const r of ordered(records, order)) {
    const value = get(r);
    if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) return { value, provider: r.provider };
  }
  return null;
}

/** Record a conflict when providers give different values (compared by `key`). */
function conflict(
  field: string,
  records: ScholarlySourceRecord[],
  get: (r: ScholarlySourceRecord) => string | null,
  key: (v: string) => string,
  chosen: LiteratureProviderId | null,
): MetadataConflict | null {
  if (!chosen) return null;
  const values: { provider: LiteratureProviderId; value: string }[] = [];
  const keys = new Set<string>();
  for (const r of [...records].sort((a, b) => providerRank(a.provider) - providerRank(b.provider))) {
    const v = get(r);
    if (v === null) continue;
    if (values.some((x) => x.provider === r.provider && key(x.value) === key(v))) continue;
    values.push({ provider: r.provider, value: v });
    keys.add(key(v));
  }
  return keys.size > 1 ? { field, values, chosen } : null;
}

/** Fill gaps in the chosen author list from the other providers' lists (ORCID, affiliations, provider IDs). */
function enrichAuthors(chosen: ScholarlyAuthor[], records: ScholarlySourceRecord[]): ScholarlyAuthor[] {
  const result = chosen.map((a) => ({ ...a, affiliations: [...a.affiliations], providerIds: { ...a.providerIds } }));
  for (const r of records) {
    const others = r.authors;
    const sameLength = others.length === result.length;
    result.forEach((author, i) => {
      const key = familyKey(author);
      if (!key) return;
      let match: ScholarlyAuthor | undefined;
      if (sameLength && familyKey(others[i]!) === key) match = others[i];
      else {
        const candidates = others.filter((o) => familyKey(o) === key);
        if (candidates.length === 1) match = candidates[0];
      }
      if (!match) return;
      author.orcid ??= match.orcid;
      if (!author.affiliations.length && match.affiliations.length) author.affiliations = [...match.affiliations];
      for (const [p, id] of Object.entries(match.providerIds)) {
        const provider = p as LiteratureProviderId;
        author.providerIds[provider] ??= id;
      }
    });
  }
  return result;
}

/** Merge the records of one work (from `deduplicate`) into a canonical work. Records are kept unchanged. */
export function mergeRecords(group: ScholarlySourceRecord[]): ScholarlyWork {
  if (!group.length) throw new Error('mergeRecords needs at least one record');
  const records = [...group].sort(
    (a, b) => providerRank(a.provider) - providerRank(b.provider) || a.providerId.localeCompare(b.providerId),
  );
  const conflicts: MetadataConflict[] = [];
  const add = (c: MetadataConflict | null) => {
    if (c) conflicts.push(c);
  };

  const title = pick(records, PRECEDENCE.title, (r) => r.title)!;
  add(conflict('title', records, (r) => r.title, titleKey, title.provider));

  const abstract = pick(records, PRECEDENCE.abstract, (r) => r.abstract);
  const authors = pick(records, PRECEDENCE.authors, (r) => (r.authors.length ? r.authors : null));
  add(conflict('authorCount', records, (r) => (r.authors.length ? String(r.authors.length) : null), (v) => v, authors?.provider ?? null));

  // Dates and year come from the same record, so they never contradict each other.
  const dated = pick(records, PRECEDENCE.bibliographic, (r) => r.dates.published ?? (r.publicationYear !== null ? String(r.publicationYear) : null));
  const datedRecord = dated ? ordered(records, PRECEDENCE.bibliographic).find((r) => r.provider === dated.provider && (r.dates.published ?? r.publicationYear) !== null) : undefined;
  const publicationDate = datedRecord?.dates.published ?? null;
  const publicationYear = datedRecord?.publicationYear ?? null;
  add(conflict('publicationYear', records, (r) => (r.publicationYear !== null ? String(r.publicationYear) : null), (v) => v, dated?.provider ?? null));
  add(
    conflict(
      'publicationDate',
      records.filter((r) => r.dates.published && r.dates.published.length === 10),
      (r) => r.dates.published,
      (v) => v,
      dated?.provider ?? null,
    ),
  );

  const venue = pick(records, PRECEDENCE.bibliographic, (r) => r.venue);
  add(conflict('venue', records, (r) => r.venue, titleKey, venue?.provider ?? null));
  const publisher = pick(records, PRECEDENCE.bibliographic, (r) => r.publisher);

  let type = pick(records, PRECEDENCE.publicationType, (r) => r.publicationType);
  // A review is a journal article too; the more specific label wins.
  const review = records.find((r) => r.publicationType === 'review');
  if (type && type.value === 'journal-article' && review) type = { value: 'review', provider: review.provider };
  add(conflict('publicationType', records, (r) => r.publicationType, (v) => v, type?.provider ?? null));

  const doi = pick(records, PRECEDENCE.bibliographic, (r) => journalDoi(r));
  const arxivId = records.map(arxivIdOf).find((x) => x !== null) ?? null;
  const identifiers = {
    doi: doi?.value ?? (arxivId ? null : (records.find((r) => r.identifiers.doi)?.identifiers.doi ?? null)),
    arxivId,
    openAlexId: records.find((r) => r.identifiers.openAlexId)?.identifiers.openAlexId ?? null,
    semanticScholarId: records.find((r) => r.identifiers.semanticScholarId)?.identifiers.semanticScholarId ?? null,
    pmid: records.find((r) => r.identifiers.pmid)?.identifiers.pmid ?? null,
  };

  const oaValues = records.map((r) => r.openAccess.isOpenAccess).filter((v): v is boolean => v !== null);
  const isOpenAccess = oaValues.includes(true) ? true : oaValues.includes(false) ? false : null;
  add(conflict('isOpenAccess', records, (r) => (r.openAccess.isOpenAccess === null ? null : String(r.openAccess.isOpenAccess)), (v) => v, pick(records, PRECEDENCE.openAccess, (r) => r.openAccess.isOpenAccess)?.provider ?? null));
  const pdf = pick(records, PRECEDENCE.pdf, (r) => r.openAccess.pdfUrl ?? r.urls.pdf);

  const bib = (get: (r: ScholarlySourceRecord) => string | null) => pick(records, PRECEDENCE.bibliographic, get)?.value ?? null;
  const arxivRecord = ordered(records, ['arxiv'])[0];
  const crossref = records.find((r) => r.provider === 'crossref');

  const observations: CitationObservation[] = records
    .filter((r) => r.citedByCount !== null || r.referenceCount !== null)
    .map((r) => ({ provider: r.provider, citedByCount: r.citedByCount, referenceCount: r.referenceCount, retrievedAt: r.retrievedAt }));
  const citedBy = pick(records, PRECEDENCE.citedBy, (r) => r.citedByCount);
  const references = pick(records, PRECEDENCE.references, (r) => r.referenceCount);

  const categories = new Map<string, { scheme: string; value: string }>();
  for (const r of records) for (const c of r.categories) categories.set(`${c.scheme}:${c.value}`, c);

  const retrieved = records.map((r) => r.retrievedAt).sort();
  const first = records[0]!;

  const work: ScholarlyWork = {
    id: canonicalWorkId(identifiers, first),
    title: title.value,
    abstract: abstract?.value ?? null,
    abstractSource: abstract?.provider ?? null,
    authors: authors ? enrichAuthors(authors.value, records.filter((r) => r.provider !== authors.provider)) : [],
    publicationDate,
    publicationYear,
    dates: {
      published: publicationDate,
      publishedOnline: crossref?.dates.publishedOnline ?? null,
      publishedPrint: crossref?.dates.publishedPrint ?? null,
      submitted: arxivRecord?.dates.submitted ?? null,
      updated: arxivRecord?.dates.updated ?? null,
    },
    venue: venue?.value ?? null,
    publisher: publisher?.value ?? null,
    publicationType: type?.value ?? null,
    bibliographic: {
      volume: bib((r) => r.bibliographic.volume),
      issue: bib((r) => r.bibliographic.issue),
      pages: bib((r) => r.bibliographic.pages),
      issn: [...new Set(records.flatMap((r) => r.bibliographic.issn))],
    },
    categories: [...categories.values()],
    identifiers,
    urls: {
      landingPage: identifiers.doi ? `https://doi.org/${identifiers.doi}` : (pick(records, PRECEDENCE.bibliographic, (r) => r.urls.landingPage)?.value ?? null),
      pdf: pdf?.value ?? null,
      abstract: arxivRecord?.urls.abstract ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : null),
    },
    openAccess: {
      isOpenAccess,
      status: pick(records, PRECEDENCE.openAccess, (r) => r.openAccess.status)?.value ?? null,
      license: pick(records, PRECEDENCE.openAccess, (r) => r.openAccess.license)?.value ?? null,
      pdfUrl: pdf?.value ?? null,
    },
    citation: {
      citedByCount: citedBy?.value ?? null,
      citedBySource: citedBy?.provider ?? null,
      referenceCount: references?.value ?? null,
      observations,
    },
    conflicts,
    sourceRecords: records,
    createdAt: retrieved[0]!,
    updatedAt: retrieved.at(-1)!,
  };
  return work;
}
