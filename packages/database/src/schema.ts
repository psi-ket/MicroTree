import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  ATTACHMENT_SOURCES,
  ATTACHMENT_TYPES,
  AUDIT_OUTCOMES,
  EXTERNAL_LIBRARY_PROVIDERS,
  IMPORT_JOB_KINDS,
  IMPORT_JOB_STATUSES,
  METADATA_STATUSES,
  READING_STATUSES,
  SYNC_STATUSES,
  WORK_ORIGINS,
  type BibField,
  type ExternalConflict,
  type ImportItemResult,
  type MetadataMatch,
  type ScholarlyWork,
  type WorkEdits,
  COMPILE_STATUSES,
  FILE_KINDS,
  LATEX_ENGINES,
  LITERATURE_PROVIDERS,
  type Diagnostic,
  type LiteratureSearchHistoryEntry,
  type LiteratureSearchRequest,
} from '@research-studio/shared-types';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  rootPath: text('root_path').notNull().unique(),
  mainFile: text('main_file').notNull().default('main.tex'),
  engine: text('engine', { enum: LATEX_ENGINES }).notNull().default('pdflatex'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastOpenedAt: text('last_opened_at'),
});

/** Index of files on disk (the filesystem remains the source of truth). */
export const projectFiles = sqliteTable(
  'project_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: text('kind', { enum: FILE_KINDS }).notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256'),
    modifiedAt: text('modified_at').notNull(),
    indexedAt: text('indexed_at').notNull(),
  },
  (t) => [uniqueIndex('project_files_project_path_uq').on(t.projectId, t.path)],
);

/** Key/value settings. `scope` is `global` or `project:<id>`. Values are JSON. */
export const settings = sqliteTable(
  'settings',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const compilationJobs = sqliteTable(
  'compilation_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status', { enum: COMPILE_STATUSES }).notNull(),
    engine: text('engine', { enum: LATEX_ENGINES }).notNull(),
    mainFile: text('main_file').notNull(),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code'),
    pdfAvailable: integer('pdf_available', { mode: 'boolean' }).notNull().default(false),
    errorCount: integer('error_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    diagnostics: text('diagnostics', { mode: 'json' }).$type<Diagnostic[]>().notNull().default([]),
    statusMessage: text('status_message'),
    /** Last part of the latexmk console output, for the raw log view. */
    outputTail: text('output_tail'),
  },
  (t) => [index('compilation_jobs_project_created_idx').on(t.projectId, t.createdAt)],
);

/** Append-only audit trail. No FK to projects: events must outlive deleted projects. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    action: text('action').notNull(),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    actor: text('actor'),
    projectId: text('project_id'),
    target: text('target'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('audit_events_at_idx').on(t.at), index('audit_events_project_idx').on(t.projectId)],
);

/**
 * Provider responses cached by the literature engine. `key` is the engine's
 * cache key (`record:<provider>:<kind>:<id>` or `search:<provider>:<hash>`);
 * `value` is normalised data with its provenance (provider, request URL
 * without secrets, retrieval time). Rows past `expires_at` are never served.
 */
export const literatureCache = sqliteTable(
  'literature_cache',
  {
    key: text('key').primaryKey(),
    provider: text('provider', { enum: LITERATURE_PROVIDERS }).notNull(),
    kind: text('kind', { enum: ['record', 'search'] }).notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    retrievedAt: text('retrieved_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
  },
  (t) => [index('literature_cache_expires_idx').on(t.expiresAt), index('literature_cache_provider_idx').on(t.provider)],
);

/** Searches the user ran (only while history is turned on in preferences). */
export const literatureSearchHistory = sqliteTable(
  'literature_search_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    query: text('query').notNull(),
    request: text('request', { mode: 'json' }).$type<LiteratureSearchRequest>().notNull(),
    resultCount: integer('result_count').notNull(),
    providers: text('providers', { mode: 'json' }).$type<LiteratureSearchHistoryEntry['providers']>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('literature_search_history_created_idx').on(t.createdAt)],
);

/** Last known health of each provider (for the Sources view). Never holds keys. */
export const literatureProviderState = sqliteTable('literature_provider_state', {
  provider: text('provider', { enum: LITERATURE_PROVIDERS }).primaryKey(),
  lastSuccessAt: text('last_success_at'),
  lastErrorAt: text('last_error_at'),
  lastErrorKind: text('last_error_kind'),
  lastError: text('last_error'),
  rateLimit: text('rate_limit', { mode: 'json' }).$type<Record<string, string>>(),
  updatedAt: text('updated_at').notNull(),
});

// ------------------------------------------------------------------ library (M3.2)

/**
 * Durable scholarly works. `work` is the M3.1 `ScholarlyWork` (merged provider
 * metadata with its source records) or the work built from an imported record,
 * as received; the user's corrections are kept apart in `user_edits` and
 * applied when the work is read, so they can be undone and survive a refresh.
 * The other bibliographic columns are derived from the corrected work for
 * indexing and duplicate detection; they are never edited directly.
 */
export const scholarlyWorks = sqliteTable(
  'scholarly_works',
  {
    id: text('id').primaryKey(),
    /** M3.1 canonical ID (`doi:…`, `arxiv:…`, …); null for works no provider knows. */
    canonicalId: text('canonical_id').unique(),
    origin: text('origin', { enum: WORK_ORIGINS }).notNull(),
    work: text('work', { mode: 'json' }).$type<ScholarlyWork>().notNull(),
    /** The imported record the metadata came from (BibTeX entry, RIS tags, Zotero data, PDF metadata). */
    localSource: text('local_source', { mode: 'json' }).$type<Record<string, unknown>>(),
    userEdits: text('user_edits', { mode: 'json' }).$type<WorkEdits>().notNull().default({}),
    doi: text('doi').unique(),
    arxivId: text('arxiv_id').unique(),
    /** Normalised title (lower case, letters and digits) for search and matching. */
    titleKey: text('title_key').notNull(),
    firstAuthorKey: text('first_author_key'),
    /** All author names, normalised, for author filters. */
    authorsKey: text('authors_key').notNull().default(''),
    year: integer('year'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('scholarly_works_title_idx').on(t.titleKey), index('scholarly_works_year_idx').on(t.year)],
);

/** The user's inclusion of a work in the library. Holds only the user's own state. */
export const libraryItems = sqliteTable(
  'library_items',
  {
    id: text('id').primaryKey(),
    scholarlyWorkId: text('scholarly_work_id')
      .notNull()
      .unique()
      .references(() => scholarlyWorks.id, { onDelete: 'restrict' }),
    citationKey: text('citation_key'),
    readingStatus: text('reading_status', { enum: READING_STATUSES }).notNull().default('to-read'),
    isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes').notNull().default(''),
    metadataStatus: text('metadata_status', { enum: METADATA_STATUSES }).notNull(),
    match: text('match', { mode: 'json' }).$type<MetadataMatch>(),
    bibtexType: text('bibtex_type'),
    bibtexExtra: text('bibtex_extra', { mode: 'json' }).$type<BibField[]>().notNull().default([]),
    addedAt: text('added_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastOpenedAt: text('last_opened_at'),
    archivedAt: text('archived_at'),
  },
  (t) => [
    uniqueIndex('library_items_citation_key_uq').on(sql`lower(${t.citationKey})`),
    index('library_items_added_idx').on(t.addedAt),
    index('library_items_status_idx').on(t.readingStatus),
    index('library_items_opened_idx').on(t.lastOpenedAt),
  ],
);

export const libraryCollections = sqliteTable(
  'library_collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('library_collections_name_uq').on(sql`lower(${t.name})`)],
);

export const libraryCollectionItems = sqliteTable(
  'library_collection_items',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => libraryCollections.id, { onDelete: 'cascade' }),
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.libraryItemId] }),
    index('library_collection_items_item_idx').on(t.libraryItemId),
  ],
);

export const libraryTags = sqliteTable(
  'library_tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('library_tags_name_uq').on(sql`lower(${t.name})`)],
);

export const libraryItemTags = sqliteTable(
  'library_item_tags',
  {
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => libraryTags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.libraryItemId, t.tagId] }), index('library_item_tags_tag_idx').on(t.tagId)],
);

/**
 * Files attached to library items. The bytes are stored once per SHA-256 in
 * the runtime's library object store (`storage_key`), never in SQLite; a
 * stored object is owned by every row with its hash.
 */
export const libraryAttachments = sqliteTable(
  'library_attachments',
  {
    id: text('id').primaryKey(),
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    originalFileName: text('original_file_name').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    sha256: text('sha256').notNull(),
    attachmentType: text('attachment_type', { enum: ATTACHMENT_TYPES }).notNull(),
    source: text('source', { enum: ATTACHMENT_SOURCES }).notNull(),
    sourceUrl: text('source_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('library_attachments_item_sha_uq').on(t.libraryItemId, t.sha256),
    index('library_attachments_sha_idx').on(t.sha256),
  ],
);

/** A library item's counterpart in an external reference manager (Zotero). */
export const libraryExternalLinks = sqliteTable(
  'library_external_links',
  {
    id: text('id').primaryKey(),
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: EXTERNAL_LIBRARY_PROVIDERS }).notNull(),
    /** `web:users/<id>` or `local:<server id>:users/0`: versions are only comparable within one. */
    externalLibraryId: text('external_library_id').notNull(),
    externalItemId: text('external_item_id').notNull(),
    externalVersion: integer('external_version'),
    lastSyncedAt: text('last_synced_at'),
    syncStatus: text('sync_status', { enum: SYNC_STATUSES }).notNull(),
    /** The remote data as last synchronised, for conflict detection. */
    remoteSnapshot: text('remote_snapshot', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Fingerprint of the local metadata at the last sync (detects local changes). */
    localFingerprint: text('local_fingerprint'),
    conflict: text('conflict', { mode: 'json' }).$type<ExternalConflict>(),
  },
  (t) => [
    uniqueIndex('library_external_links_remote_uq').on(t.provider, t.externalLibraryId, t.externalItemId),
    uniqueIndex('library_external_links_local_uq').on(t.provider, t.externalLibraryId, t.libraryItemId),
  ],
);

export const libraryExternalCollections = sqliteTable(
  'library_external_collections',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => libraryCollections.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: EXTERNAL_LIBRARY_PROVIDERS }).notNull(),
    externalLibraryId: text('external_library_id').notNull(),
    externalCollectionId: text('external_collection_id').notNull(),
    externalVersion: integer('external_version'),
    lastSyncedAt: text('last_synced_at'),
  },
  (t) => [
    uniqueIndex('library_external_collections_remote_uq').on(t.provider, t.externalLibraryId, t.externalCollectionId),
  ],
);

/** Library references used by a LaTeX project. */
export const libraryProjectLinks = sqliteTable(
  'library_project_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('library_project_links_uq').on(t.projectId, t.libraryItemId),
    index('library_project_links_item_idx').on(t.libraryItemId),
  ],
);

/** Background imports (PDF batches, BibTeX/RIS files, identifier lists, Zotero). */
export const libraryImportJobs = sqliteTable(
  'library_import_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: IMPORT_JOB_KINDS }).notNull(),
    status: text('status', { enum: IMPORT_JOB_STATUSES }).notNull(),
    total: integer('total').notNull(),
    processed: integer('processed').notNull().default(0),
    items: text('items', { mode: 'json' }).$type<ImportItemResult[]>().notNull().default([]),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('library_import_jobs_created_idx').on(t.createdAt)],
);
