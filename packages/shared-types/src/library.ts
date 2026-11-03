/**
 * Personal research library (M3.2). A library item is the user's state for
 * one `ScholarlyWork` (M3.1); bibliographic metadata lives only in the work.
 * Values that no source supplied stay `null`: nothing is guessed.
 */
import type { PublicationType, ScholarlyAuthor, ScholarlyWork } from './literature';

export const READING_STATUSES = ['to-read', 'reading', 'read', 'important'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const READING_STATUS_LABELS: Readonly<Record<ReadingStatus, string>> = {
  'to-read': 'To read',
  reading: 'Reading',
  read: 'Read',
  important: 'Important',
};

/** Where a work's metadata came from. `providers` = resolved through the M3.1 scholarly providers. */
export const WORK_ORIGINS = ['providers', 'bibtex', 'ris', 'pdf', 'manual', 'zotero'] as const;
export type WorkOrigin = (typeof WORK_ORIGINS)[number];

/**
 * `resolved`: metadata from the scholarly providers; `needs-review`: candidates
 * wait for the user's choice; `unresolved`: no match (yet); `manual`: entered or
 * imported by the user and not resolved.
 */
export const METADATA_STATUSES = ['resolved', 'needs-review', 'unresolved', 'manual'] as const;
export type MetadataStatus = (typeof METADATA_STATUSES)[number];

export const MATCH_CONFIDENCES = ['exact-doi', 'exact-arxiv', 'strong', 'possible', 'unresolved'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];

export const ATTACHMENT_TYPES = ['pdf', 'supplementary', 'other'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const ATTACHMENT_SOURCES = ['upload', 'open-access', 'zotero'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export const EXTERNAL_LIBRARY_PROVIDERS = ['zotero'] as const;
export type ExternalLibraryProvider = (typeof EXTERNAL_LIBRARY_PROVIDERS)[number];

export const SYNC_STATUSES = ['synced', 'local-changes', 'remote-changes', 'conflict', 'error'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const CITATION_KEY_FORMATS = ['author-year', 'author-year-keyword', 'author-year-title', 'custom'] as const;
export type CitationKeyFormat = (typeof CITATION_KEY_FORMATS)[number];

export const LIBRARY_SORTS = ['added-desc', 'added-asc', 'year-desc', 'year-asc', 'title-asc', 'title-desc'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

/** Fields the user can correct. Corrections are kept apart from the provider records. */
export interface WorkEdits {
  title?: string;
  authors?: EditedAuthor[];
  publicationYear?: number | null;
  publicationDate?: string | null;
  venue?: string | null;
  publisher?: string | null;
  publicationType?: PublicationType | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  abstract?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  url?: string | null;
}
export type EditableField = keyof WorkEdits;
export const EDITABLE_FIELDS = [
  'title',
  'authors',
  'publicationYear',
  'publicationDate',
  'venue',
  'publisher',
  'publicationType',
  'volume',
  'issue',
  'pages',
  'abstract',
  'doi',
  'arxivId',
  'url',
] as const satisfies readonly EditableField[];

export interface EditedAuthor {
  givenName: string | null;
  familyName: string | null;
  /** Used when the name is not split (organisations). */
  name: string | null;
}

/**
 * One BibTeX field kept for export. `value` is the field's BibTeX text with
 * `@string` macros expanded and the outer delimiters removed; it is written
 * inside braces, or as is when `bare` (numbers and month macros such as `jan`).
 */
export interface BibField {
  name: string;
  value: string;
  bare?: boolean;
}

export interface MatchCandidate {
  work: ScholarlyWork;
  confidence: MatchConfidence;
  /** Why the candidate scored as it did, in plain words. */
  reasons: string[];
}

/** What an import found and how sure the library is about the match. */
export interface MetadataMatch {
  confidence: MatchConfidence;
  candidates: MatchCandidate[];
  /** Identifiers and text found in the imported file or record. */
  extracted: {
    dois: string[];
    arxivIds: string[];
    title: string | null;
    authors: string[];
    /** `pdf-metadata`, `pdf-text`, `file-name`, `bibtex`, `ris`, `zotero`. */
    titleSource: string | null;
  };
  /** Set when the user picked a candidate or chose to keep the item unresolved. */
  decidedAt: string | null;
}

export interface LibraryAttachment {
  id: string;
  libraryItemId: string;
  fileName: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  attachmentType: AttachmentType;
  source: AttachmentSource;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** False when the stored file is missing (it was removed outside the app). */
  available: boolean;
}

export interface LibraryCollection {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryTag {
  id: string;
  name: string;
  itemCount: number;
}

/** Fields changed on both sides since the last synchronisation, with both values. */
export interface ExternalConflict {
  fields: { field: string; local: string | null; remote: string | null }[];
  detectedAt: string;
}

export interface ExternalLinkSummary {
  provider: ExternalLibraryProvider;
  externalLibraryId: string;
  externalItemId: string;
  externalVersion: number | null;
  lastSyncedAt: string | null;
  syncStatus: SyncStatus;
  /** Set when `syncStatus` is `conflict`. */
  conflict: ExternalConflict | null;
}

/** Compact row for lists. */
export interface LibraryItemSummary {
  id: string;
  workId: string;
  title: string;
  authors: string[];
  authorCount: number;
  year: number | null;
  venue: string | null;
  publicationType: PublicationType | null;
  doi: string | null;
  arxivId: string | null;
  citationKey: string | null;
  readingStatus: ReadingStatus;
  isFavorite: boolean;
  metadataStatus: MetadataStatus;
  origin: WorkOrigin;
  pdfCount: number;
  collectionIds: string[];
  tags: string[];
  addedAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  archivedAt: string | null;
}

export interface LibraryItem {
  id: string;
  workId: string;
  /** The work as shown: provider metadata with the user's corrections applied. */
  work: ScholarlyWork;
  origin: WorkOrigin;
  /** The user's corrections (field → value); also applied to `work`. */
  edits: WorkEdits;
  /** The imported record the metadata came from, for non-provider origins (BibTeX entry, RIS tags, Zotero data, PDF metadata). */
  localSource: Record<string, unknown> | null;
  citationKey: string | null;
  readingStatus: ReadingStatus;
  isFavorite: boolean;
  notes: string;
  metadataStatus: MetadataStatus;
  match: MetadataMatch | null;
  bibtexType: string | null;
  bibtexExtra: BibField[];
  tags: string[];
  collections: { id: string; name: string; color: string | null }[];
  attachments: LibraryAttachment[];
  projects: { id: string; name: string }[];
  external: ExternalLinkSummary[];
  addedAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  archivedAt: string | null;
}

export interface LibraryItemQuery {
  q?: string;
  collectionId?: string;
  tag?: string;
  readingStatus?: ReadingStatus;
  metadataStatus?: MetadataStatus;
  favorite?: boolean;
  hasPdf?: boolean;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  /** `active` (default), `archived`, `all`. */
  archived?: 'active' | 'archived' | 'all';
  projectId?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
}

export interface LibraryItemPage {
  items: LibraryItemSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface LibraryOverview {
  total: number;
  withPdf: number;
  byStatus: Record<ReadingStatus, number>;
  archived: number;
  favorites: number;
  needsReview: number;
  collections: LibraryCollection[];
  recentlyAdded: LibraryItemSummary[];
  recentlyOpened: LibraryItemSummary[];
}

export interface LibraryPreferences {
  citationKeyFormat: CitationKeyFormat;
  /** Template for the `custom` format, e.g. `{author}{year}{word}`. */
  customKeyTemplate: string;
  /** Download listed open-access PDFs when adding a paper from literature search. */
  fetchOpenAccessPdf: boolean;
}

export const DEFAULT_LIBRARY_PREFERENCES: LibraryPreferences = {
  citationKeyFormat: 'author-year-keyword',
  customKeyTemplate: '{author}{year}{word}',
  fetchOpenAccessPdf: false,
};

// ------------------------------------------------------------- imports

export const IMPORT_JOB_KINDS = ['pdf', 'bibtex', 'ris', 'identifiers', 'zotero'] as const;
export type ImportJobKind = (typeof IMPORT_JOB_KINDS)[number];

export const IMPORT_JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** `updated`: a linked Zotero item changed remotely and was refreshed; `conflict`: it changed on both sides and waits for the user. */
export const IMPORT_ITEM_OUTCOMES = ['added', 'attached', 'duplicate', 'needs-review', 'unresolved', 'updated', 'conflict', 'failed', 'skipped'] as const;
export type ImportItemOutcome = (typeof IMPORT_ITEM_OUTCOMES)[number];

export interface ImportItemResult {
  /** File name, BibTeX key, RIS record number or identifier as given. */
  label: string;
  outcome: ImportItemOutcome;
  libraryItemId: string | null;
  confidence: MatchConfidence | null;
  /** Why it ended that way (error, duplicate of which item, …). */
  message: string | null;
}

export interface ImportJob {
  id: string;
  kind: ImportJobKind;
  status: ImportJobStatus;
  total: number;
  processed: number;
  items: ImportItemResult[];
  /** Parse problems that did not stop the import (line-numbered). */
  warnings: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ------------------------------------------------------ project references

export const CITE_COMMANDS = ['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite'] as const;
export type CiteCommand = (typeof CITE_COMMANDS)[number];

export interface ProjectReferenceSettings {
  /** Project-relative `.bib` file the library writes to. */
  bibFile: string;
  citeCommand: CiteCommand;
}

export interface ProjectCitation {
  key: string;
  /** Places in `.tex` files where the key is cited. */
  occurrences: { file: string; line: number }[];
  /** `.bib` files of the project that define the key. */
  definedIn: string[];
  libraryItemId: string | null;
  /** `library-and-bib`, `bib-only`, `library-only` (linked but not in a `.bib` yet), `unresolved`. */
  status: 'library-and-bib' | 'bib-only' | 'library-only' | 'unresolved';
}

export interface ProjectReferences {
  settings: ProjectReferenceSettings;
  /** Library items linked to the project. */
  items: LibraryItemSummary[];
  citations: ProjectCitation[];
  bibFiles: string[];
}

export const BIB_CHANGE_KINDS = ['add-entry', 'add-fields', 'existing-key-for-doi', 'key-collision', 'unchanged', 'missing-key'] as const;
export type BibChangeKind = (typeof BIB_CHANGE_KINDS)[number];

export interface BibChange {
  /** Stable within one preview; sent back to apply a selection. */
  id: string;
  kind: BibChangeKind;
  libraryItemId: string;
  citationKey: string | null;
  /** Plain-language explanation. */
  message: string;
  /** Only `add-entry` and `add-fields` change the file. */
  applicable: boolean;
  /** For `add-fields`: the field names that would be added. */
  fields?: string[];
  /** For `existing-key-for-doi`: the key already used in the file for this work. */
  existingKey?: string;
}

export interface BibUpdatePreview {
  path: string;
  /** Hash of the file the preview was computed from (null: the file does not exist yet). */
  baseHash: string | null;
  original: string;
  proposed: string;
  changes: BibChange[];
  /** Parse problems in the existing file (kept as they are). */
  warnings: string[];
}

// ------------------------------------------------------------------ Zotero

export const ZOTERO_MODES = ['web', 'local'] as const;
export type ZoteroMode = (typeof ZOTERO_MODES)[number];

export interface ZoteroStatus {
  /** Web API: a key is stored in the runtime; local: the desktop API answered. */
  web: { configured: boolean; userId: string | null; username: string | null; canWrite: boolean | null; lastError: string | null };
  local: { enabled: boolean; reachable: boolean | null; lastError: string | null };
  linkedItems: number;
  conflicts: number;
}

export interface ZoteroCollectionInfo {
  key: string;
  name: string;
  parentKey: string | null;
  itemCount: number | null;
}

export interface ZoteroImportPreviewItem {
  externalItemId: string;
  version: number;
  title: string;
  itemType: string;
  creators: string[];
  year: number | null;
  doi: string | null;
  hasPdf: boolean;
  /** `new`, `linked` (already imported, unchanged), `remote-changes`, `conflict`, `duplicate` (same DOI/arXiv as a library item that is not linked). */
  state: 'new' | 'linked' | 'remote-changes' | 'conflict' | 'duplicate';
  libraryItemId: string | null;
}

export interface ZoteroImportPreview {
  mode: ZoteroMode;
  libraryVersion: number | null;
  collections: ZoteroCollectionInfo[];
  items: ZoteroImportPreviewItem[];
  /** Items of types that are not imported (notes, annotations, attachments without parent). */
  skipped: number;
}

export interface ZoteroExportPreviewItem {
  libraryItemId: string;
  title: string;
  /** `create`, `update` (linked and changed locally), `unchanged`, `conflict` (changed on both sides). */
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  externalItemId: string | null;
}

/** Authors as plain display strings ("Family, Given" or the full name). */
export function authorDisplayName(a: Pick<ScholarlyAuthor, 'name' | 'givenName' | 'familyName'>): string {
  if (a.familyName && a.givenName) return `${a.givenName} ${a.familyName}`;
  return a.name || a.familyName || a.givenName || '';
}
