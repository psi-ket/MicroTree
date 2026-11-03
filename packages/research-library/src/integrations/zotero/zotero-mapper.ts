import { createHash } from 'node:crypto';
import { normalizeDoi, normalizeIssn, parseArxivId, yearOf } from '@research-studio/literature-engine';
import type { PublicationType, ScholarlyWork } from '@research-studio/shared-types';
import { emptyReference, type ImportedReference } from '../../library/library-types';

/** The `data` object of a Zotero API item (only the fields the library reads or writes). */
export interface ZoteroItemData {
  key?: string;
  version?: number;
  itemType: string;
  title?: string;
  creators?: ({ creatorType: string; firstName?: string; lastName?: string } | { creatorType: string; name: string })[];
  abstractNote?: string;
  publicationTitle?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  websiteTitle?: string;
  publisher?: string;
  university?: string;
  institution?: string;
  repository?: string;
  archiveID?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  date?: string;
  DOI?: string;
  ISSN?: string;
  url?: string;
  extra?: string;
  citationKey?: string;
  tags?: { tag: string; type?: number }[];
  collections?: string[];
  parentItem?: string;
  contentType?: string;
  linkMode?: string;
  filename?: string;
  md5?: string | null;
  [field: string]: unknown;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
}

/** Item types the library imports; notes, annotations and attachments are handled separately or skipped. */
const SKIPPED_TYPES = new Set(['note', 'annotation', 'attachment']);
export const isImportableType = (t: string) => !SKIPPED_TYPES.has(t);

const TYPE_TO_PUBLICATION: Record<string, PublicationType> = {
  journalArticle: 'journal-article',
  magazineArticle: 'journal-article',
  newspaperArticle: 'journal-article',
  preprint: 'preprint',
  book: 'book',
  bookSection: 'book-chapter',
  conferencePaper: 'conference-paper',
  thesis: 'dissertation',
  report: 'report',
  dataset: 'dataset',
};

const TYPE_TO_BIBTEX: Record<string, string> = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  preprint: 'misc',
  book: 'book',
  bookSection: 'incollection',
  conferencePaper: 'inproceedings',
  thesis: 'phdthesis',
  report: 'techreport',
  manuscript: 'unpublished',
};

const PUBLICATION_TO_TYPE: Partial<Record<PublicationType, string>> = {
  'journal-article': 'journalArticle',
  preprint: 'preprint',
  book: 'book',
  'book-chapter': 'bookSection',
  'conference-paper': 'conferencePaper',
  dissertation: 'thesis',
  report: 'report',
};

/**
 * Fields valid for each item type the library writes (Zotero schema, checked
 * against https://api.zotero.org/schema on 2026-11-03). Writing a field an
 * item type does not have makes the API refuse the item.
 */
const WRITABLE_FIELDS: Record<string, readonly string[]> = {
  journalArticle: ['title', 'abstractNote', 'publicationTitle', 'volume', 'issue', 'pages', 'date', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  preprint: ['title', 'abstractNote', 'repository', 'archiveID', 'date', 'DOI', 'url', 'extra', 'citationKey'],
  book: ['title', 'abstractNote', 'volume', 'publisher', 'date', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  bookSection: ['title', 'abstractNote', 'bookTitle', 'volume', 'publisher', 'date', 'pages', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  conferencePaper: ['title', 'abstractNote', 'proceedingsTitle', 'publisher', 'date', 'volume', 'issue', 'pages', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  thesis: ['title', 'abstractNote', 'university', 'date', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  report: ['title', 'abstractNote', 'institution', 'date', 'pages', 'DOI', 'ISSN', 'url', 'extra', 'citationKey'],
  document: ['title', 'abstractNote', 'publisher', 'date', 'DOI', 'url', 'extra', 'citationKey'],
};

/** Values from the `extra` field ("DOI: …", "arXiv: …", "Citation Key: …"), as Zotero and Better BibTeX write them. */
export function extraValues(extra: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (extra ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]{0,30}):\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]!.toLowerCase()] ??= m[2]!;
  }
  return out;
}

/** Zotero dates are free text ("2017-06-12", "June 2017", "2017"); only what is stated is kept. */
export function zoteroDate(date: string | undefined): { date: string | null; year: number | null } {
  const d = (date ?? '').trim();
  if (!d) return { date: null, year: null };
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(d);
  if (iso) {
    const [, y, m, day] = iso;
    const parts = [y, m?.padStart(2, '0'), day?.padStart(2, '0')].filter(Boolean);
    return { date: parts.join('-'), year: Number(y) };
  }
  const year = /\b(1[5-9]\d\d|20\d\d|21\d\d)\b/.exec(d);
  return { date: year ? year[1]! : null, year: year ? Number(year[1]) : null };
}

/** A Zotero item as a library record. Tags and collections are returned apart. */
export function referenceFromZotero(item: ZoteroItem, libraryId: string): { reference: ImportedReference; tags: string[]; collections: string[] } {
  const d = item.data;
  const extra = extraValues(d.extra);
  const { date, year } = zoteroDate(d.date);
  const authors = (d.creators ?? [])
    .filter((c) => c.creatorType === 'author' || c.creatorType === 'bookAuthor' || c.creatorType === 'inventor')
    .map((c) => ('name' in c ? { givenName: null, familyName: null, name: c.name } : { givenName: c.firstName?.trim() || null, familyName: c.lastName?.trim() || null, name: null }));
  const doi = normalizeDoi(d.DOI ?? extra.doi ?? '');
  const arxivRaw = d.archiveID ?? extra.arxiv ?? (d.repository?.toLowerCase() === 'arxiv' ? d.url : undefined) ?? (/arxiv\.org\/abs\//.test(d.url ?? '') ? d.url : undefined);
  const arxivId = arxivRaw ? (parseArxivId(arxivRaw)?.id ?? null) : null;
  const reference: ImportedReference = {
    ...emptyReference('zotero'),
    title: d.title?.trim() || null,
    authors,
    publicationYear: year ?? yearOf(date),
    publicationDate: date,
    venue: (d.publicationTitle ?? d.proceedingsTitle ?? d.bookTitle ?? d.websiteTitle)?.trim() || null,
    publisher: (d.publisher ?? d.university ?? d.institution ?? (d.itemType === 'preprint' ? d.repository : undefined))?.trim() || null,
    publicationType: TYPE_TO_PUBLICATION[d.itemType] ?? null,
    volume: d.volume?.trim() || null,
    issue: d.issue?.trim() || null,
    pages: d.pages?.trim().replace(/\s*-+\s*/g, '–') || null,
    abstract: d.abstractNote?.trim() || null,
    doi,
    arxivId,
    url: d.url?.trim() || null,
    issn: (d.ISSN ?? '').split(/[,;\s]+/).map((s) => normalizeIssn(s)).filter((s): s is string => !!s),
    citationKey: d.citationKey?.trim() || extra['citation key'] || null,
    bibtexType: TYPE_TO_BIBTEX[d.itemType] ?? 'misc',
    localSource: { format: 'zotero', libraryId, key: item.key, version: item.version, itemType: d.itemType, data: comparable(d) },
  };
  return {
    reference,
    tags: (d.tags ?? []).map((t) => t.tag.trim()).filter(Boolean),
    collections: d.collections ?? [],
  };
}

/** The fields compared to detect changes on either side, in a stable form. */
export function comparable(d: Partial<ZoteroItemData>): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) out[k] = s;
  };
  set('title', d.title);
  set('creators', (d.creators ?? []).map((c) => ('name' in c ? c.name : [c.lastName, c.firstName].filter(Boolean).join(', '))).join('; '));
  set('date', zoteroDate(d.date).date ?? d.date);
  set('venue', d.publicationTitle ?? d.proceedingsTitle ?? d.bookTitle ?? d.websiteTitle);
  set('volume', d.volume);
  set('issue', d.issue);
  set('pages', d.pages?.replace(/\s*[-–]+\s*/g, '-'));
  set('DOI', normalizeDoi(d.DOI ?? '') ?? undefined);
  set('url', d.url);
  set('abstractNote', d.abstractNote);
  return out;
}

export function fingerprint(values: Record<string, string>): string {
  const sorted = Object.keys(values)
    .sort()
    .map((k) => [k, values[k]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32);
}

/** Field-by-field differences between two comparable records. */
export function differences(local: Record<string, string>, remote: Record<string, string>): { field: string; local: string | null; remote: string | null }[] {
  const fields = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
  return fields.filter((f) => (local[f] ?? null) !== (remote[f] ?? null)).map((f) => ({ field: f, local: local[f] ?? null, remote: remote[f] ?? null }));
}

/** A library work as Zotero item data (only fields valid for the item type; nothing invented). */
export function zoteroDataFromWork(work: ScholarlyWork, extras: { citationKey: string | null; tags: string[]; collections: string[] }): ZoteroItemData {
  const itemType = (work.publicationType && PUBLICATION_TO_TYPE[work.publicationType]) ?? (work.identifiers.arxivId ? 'preprint' : 'document');
  const allowed = new Set(WRITABLE_FIELDS[itemType] ?? WRITABLE_FIELDS.document!);
  const venueField = { journalArticle: 'publicationTitle', bookSection: 'bookTitle', conferencePaper: 'proceedingsTitle' }[itemType as 'journalArticle'];
  const publisherField = { thesis: 'university', report: 'institution', preprint: 'repository' }[itemType as 'thesis'] ?? 'publisher';
  const candidate: Record<string, string | null> = {
    title: work.title || null,
    abstractNote: work.abstract,
    date: work.publicationDate ?? (work.publicationYear ? String(work.publicationYear) : null),
    volume: work.bibliographic.volume,
    issue: work.bibliographic.issue,
    pages: work.bibliographic.pages,
    DOI: work.identifiers.doi,
    ISSN: work.bibliographic.issn.join(', ') || null,
    url: work.urls.landingPage,
    citationKey: extras.citationKey,
  };
  if (venueField) candidate[venueField] = work.venue;
  candidate[publisherField] = itemType === 'preprint' && work.identifiers.arxivId ? 'arXiv' : work.publisher;
  if (itemType === 'preprint' && work.identifiers.arxivId) candidate.archiveID = `arXiv:${work.identifiers.arxivId}`;
  const extraLines: string[] = [];
  if (work.identifiers.doi && !allowed.has('DOI')) extraLines.push(`DOI: ${work.identifiers.doi}`);
  if (work.identifiers.arxivId && itemType !== 'preprint') extraLines.push(`arXiv: ${work.identifiers.arxivId}`);
  if (extraLines.length) candidate.extra = extraLines.join('\n');

  const data: ZoteroItemData = {
    itemType,
    creators: work.authors.map((a) =>
      a.familyName ? { creatorType: 'author', firstName: a.givenName ?? '', lastName: a.familyName } : { creatorType: 'author', name: a.name },
    ),
    tags: extras.tags.map((tag) => ({ tag })),
    collections: extras.collections,
  };
  for (const [k, v] of Object.entries(candidate)) if (v && allowed.has(k)) data[k] = v;
  return data;
}
