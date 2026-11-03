import {
  emptyBibliographic,
  emptyDates,
  emptyIdentifiers,
  emptyOpenAccess,
  emptyUrls,
  familyKey,
  normalizeDate,
  safeUrl,
  titleKey,
  yearOf,
} from '@research-studio/literature-engine';
import {
  EDITABLE_FIELDS,
  type EditedAuthor,
  type ScholarlyAuthor,
  type ScholarlyWork,
  type WorkEdits,
} from '@research-studio/shared-types';
import type { ImportedReference } from '../library/library-types';

/** The ID a work gets in its `ScholarlyWork.id` when no provider knows it. */
export const localWorkId = (rowId: string) => `library:${rowId}`;

export function toScholarlyAuthor(a: EditedAuthor): ScholarlyAuthor {
  const name = a.name?.trim() || [a.givenName, a.familyName].filter(Boolean).join(' ').trim();
  return {
    name,
    givenName: a.givenName?.trim() || null,
    familyName: a.familyName?.trim() || null,
    orcid: null,
    affiliations: [],
    providerIds: {},
  };
}

export function toEditedAuthor(a: ScholarlyAuthor): EditedAuthor {
  if (a.familyName || a.givenName) return { givenName: a.givenName, familyName: a.familyName, name: null };
  return { givenName: null, familyName: null, name: a.name };
}

/**
 * A work built from an imported record. Every value comes from the record;
 * fields the record does not have stay empty. There are no source records:
 * the record itself is kept as the work's `local_source`.
 */
export function workFromReference(ref: ImportedReference, rowId: string, now: string): ScholarlyWork {
  const date = normalizeDate(ref.publicationDate);
  const year = ref.publicationYear ?? yearOf(date);
  return {
    id: localWorkId(rowId),
    title: ref.title?.trim() ?? '',
    abstract: ref.abstract?.trim() || null,
    abstractSource: null,
    authors: ref.authors.map(toScholarlyAuthor).filter((a) => a.name),
    publicationDate: date,
    publicationYear: year,
    dates: { ...emptyDates(), published: date },
    venue: ref.venue?.trim() || null,
    publisher: ref.publisher?.trim() || null,
    publicationType: ref.publicationType,
    bibliographic: { ...emptyBibliographic(), volume: ref.volume, issue: ref.issue, pages: ref.pages, issn: ref.issn },
    categories: [],
    identifiers: { ...emptyIdentifiers(), doi: ref.doi, arxivId: ref.arxivId },
    urls: { ...emptyUrls(), landingPage: safeUrl(ref.url) },
    openAccess: emptyOpenAccess(),
    citation: { citedByCount: null, citedBySource: null, referenceCount: null, observations: [] },
    conflicts: [],
    sourceRecords: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply the user's corrections on top of a work (provider or local). Source records stay as they are. */
export function applyEdits(base: ScholarlyWork, edits: WorkEdits): ScholarlyWork {
  const w: ScholarlyWork = {
    ...base,
    dates: { ...base.dates },
    bibliographic: { ...base.bibliographic },
    identifiers: { ...base.identifiers },
    urls: { ...base.urls },
  };
  if (edits.title !== undefined) w.title = edits.title;
  if (edits.authors !== undefined) w.authors = edits.authors.map(toScholarlyAuthor).filter((a) => a.name);
  if (edits.publicationDate !== undefined) {
    w.publicationDate = normalizeDate(edits.publicationDate);
    w.dates.published = w.publicationDate;
    if (edits.publicationYear === undefined && w.publicationDate) w.publicationYear = yearOf(w.publicationDate);
  }
  if (edits.publicationYear !== undefined) w.publicationYear = edits.publicationYear;
  if (edits.venue !== undefined) w.venue = edits.venue;
  if (edits.publisher !== undefined) w.publisher = edits.publisher;
  if (edits.publicationType !== undefined) w.publicationType = edits.publicationType;
  if (edits.volume !== undefined) w.bibliographic.volume = edits.volume;
  if (edits.issue !== undefined) w.bibliographic.issue = edits.issue;
  if (edits.pages !== undefined) w.bibliographic.pages = edits.pages;
  if (edits.abstract !== undefined) {
    w.abstract = edits.abstract;
    w.abstractSource = null;
  }
  if (edits.doi !== undefined) w.identifiers.doi = edits.doi;
  if (edits.arxivId !== undefined) w.identifiers.arxivId = edits.arxivId;
  if (edits.url !== undefined) w.urls.landingPage = safeUrl(edits.url);
  return w;
}

/** Keep only edits that change something compared with the base work. */
export function effectiveEdits(base: ScholarlyWork, edits: WorkEdits): WorkEdits {
  const out: WorkEdits = {};
  const current = fieldValues(base);
  for (const field of EDITABLE_FIELDS) {
    const value = edits[field];
    if (value === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(current[field])) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/** The editable fields of a work, in the shape of `WorkEdits`. */
export function fieldValues(w: ScholarlyWork): Required<WorkEdits> {
  return {
    title: w.title,
    authors: w.authors.map(toEditedAuthor),
    publicationYear: w.publicationYear,
    publicationDate: w.publicationDate,
    venue: w.venue,
    publisher: w.publisher,
    publicationType: w.publicationType,
    volume: w.bibliographic.volume,
    issue: w.bibliographic.issue,
    pages: w.bibliographic.pages,
    abstract: w.abstract,
    doi: w.identifiers.doi,
    arxivId: w.identifiers.arxivId,
    url: w.urls.landingPage,
  };
}

export interface DerivedColumns {
  doi: string | null;
  arxivId: string | null;
  titleKey: string;
  firstAuthorKey: string | null;
  authorsKey: string;
  year: number | null;
}

/** Index columns stored next to a work (search, filters, duplicate detection). */
export function derivedColumns(w: ScholarlyWork): DerivedColumns {
  const first = w.authors[0];
  return {
    doi: w.identifiers.doi,
    arxivId: w.identifiers.arxivId,
    titleKey: titleKey(w.title),
    firstAuthorKey: first ? familyKey(first) : null,
    authorsKey: w.authors.map((a) => titleKey(a.name)).join(' | '),
    year: w.publicationYear,
  };
}

/**
 * Fields where an imported record and the resolved provider work disagree.
 * Shown next to the resolved work; the imported record stays in `local_source`.
 */
export function importDifferences(resolved: ScholarlyWork, ref: ImportedReference): { field: string; imported: string; resolved: string }[] {
  const out: { field: string; imported: string; resolved: string }[] = [];
  const cmp = (field: string, imported: string | null | undefined, value: string | null | undefined, same = (a: string, b: string) => a === b) => {
    if (!imported || !value) return;
    if (!same(imported, value)) out.push({ field, imported, resolved: value });
  };
  cmp('title', ref.title, resolved.title, (a, b) => titleKey(a) === titleKey(b));
  cmp('year', ref.publicationYear?.toString(), resolved.publicationYear?.toString());
  cmp('venue', ref.venue, resolved.venue, (a, b) => titleKey(a) === titleKey(b));
  cmp('volume', ref.volume, resolved.bibliographic.volume);
  cmp('pages', ref.pages, resolved.bibliographic.pages, (a, b) => a.replace(/\D+/g, '-') === b.replace(/\D+/g, '-'));
  if (ref.authors.length && resolved.authors.length && ref.authors.length !== resolved.authors.length) {
    out.push({ field: 'authors', imported: `${ref.authors.length} authors`, resolved: `${resolved.authors.length} authors` });
  }
  return out;
}
