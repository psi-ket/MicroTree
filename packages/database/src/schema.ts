import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  BLOCK_TYPES,
  DOCUMENT_JOB_KINDS,
  DOCUMENT_JOB_STATUSES,
  ELEMENT_TYPES,
  EXTRACTION_STATUSES,
  EXTRACTORS,
  PASSAGE_KINDS,
  REFERENCE_RESOLUTION,
  SECTION_TYPES,
  type DocumentCoordinate,
  type ExtractedMetadata,
  type ExtractionQuality,
  type InlineSpan,
  type JobError,
  type PageGeometry,
  type ReferenceMetadata,
} from '@research-studio/document-intelligence';
import {
  ANCHOR_STATUSES,
  ASSESSMENT_STATES,
  ASSESSMENTS,
  ATOMICITY,
  CITATION_PLACEMENTS,
  CITATION_RECOMMENDATION_STATUSES,
  CLAIM_REVIEW_STATES,
  CLAIM_STATUSES,
  CONFLICT_CATEGORIES,
  EVIDENCE_JOB_KINDS,
  EVIDENCE_JOB_STATUSES,
  EVIDENCE_LEVELS,
  EVIDENCE_RECORD_STATUSES,
  MANUSCRIPT_BLOCK_KINDS,
  RETRIEVAL_METHODS,
  REVIEW_DECISIONS,
  REVIEW_SCOPES,
  UNCERTAINTY,
  WRITING_SUGGESTION_STATUSES,
  type ClaimQuantity,
  APPROVAL_STATUSES,
  COMPILATION_STATUSES,
  INSERTION_STATUSES,
  PRIVACY_MODES,
  VERSION_ORIGINS,
  VISUAL_ARTIFACT_TYPES,
  VISUAL_ASSET_KINDS,
  VISUAL_TASK_STATUSES,
  VISUAL_TASK_TYPES,
  type PreprocessOperation,
  type VisualProvenance,
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

// ------------------------------------------------------------------------
// Scientific document intelligence and retrieval (M3.3, migration 0003)
// ------------------------------------------------------------------------

/**
 * One extraction run over one library attachment (its PDF). Several runs of
 * the same attachment can exist (new extractor version, new settings); at
 * most one is active. A failed run never replaces an active one.
 */
export const documentExtractions = sqliteTable(
  'document_extractions',
  {
    id: text('id').primaryKey(),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => libraryAttachments.id, { onDelete: 'cascade' }),
    libraryItemId: text('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),
    /** The work the item had when this run started (a snapshot; joins use the item). */
    scholarlyWorkId: text('scholarly_work_id').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    extractor: text('extractor', { enum: EXTRACTORS }).notNull(),
    extractorVersion: text('extractor_version'),
    parserVersion: text('parser_version').notNull(),
    segmenterVersion: text('segmenter_version').notNull(),
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    configHash: text('config_hash').notNull(),
    status: text('status', { enum: EXTRACTION_STATUSES }).notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    language: text('language'),
    pageCount: integer('page_count'),
    pages: text('pages', { mode: 'json' }).$type<PageGeometry[]>().notNull().default([]),
    metadata: text('metadata', { mode: 'json' }).$type<ExtractedMetadata>().notNull(),
    quality: text('quality', { mode: 'json' }).$type<ExtractionQuality>().notNull(),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    processingStartedAt: text('processing_started_at').notNull(),
    processingCompletedAt: text('processing_completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('document_extractions_active_uq').on(t.attachmentId).where(sql`${t.isActive} = 1`),
    index('document_extractions_attachment_idx').on(t.attachmentId),
    index('document_extractions_item_idx').on(t.libraryItemId),
    index('document_extractions_sha_idx').on(t.sourceSha256),
  ],
);

/** The extractor's original output (GROBID TEI, PyMuPDF JSON), gzip-compressed, kept for debugging and reprocessing. */
export const documentRawOutputs = sqliteTable('document_raw_outputs', {
  extractionId: text('extraction_id')
    .primaryKey()
    .references(() => documentExtractions.id, { onDelete: 'cascade' }),
  format: text('format', { enum: ['tei-xml', 'pymupdf-json'] }).notNull(),
  encoding: text('encoding', { enum: ['gzip'] }).notNull(),
  content: blob('content', { mode: 'buffer' }).notNull(),
  sizeBytes: integer('size_bytes').notNull(),
});

export const documentSections = sqliteTable(
  'document_sections',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    parentSectionId: text('parent_section_id'),
    heading: text('heading').notNull(),
    headingNumber: text('heading_number'),
    sectionLevel: integer('section_level').notNull(),
    sectionOrder: integer('section_order').notNull(),
    sectionPath: text('section_path').notNull(),
    sectionType: text('section_type', { enum: SECTION_TYPES }).notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
  },
  (t) => [uniqueIndex('document_sections_order_uq').on(t.extractionId, t.sectionOrder)],
);

export const documentBlocks = sqliteTable(
  'document_blocks',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    sectionId: text('section_id'),
    blockType: text('block_type', { enum: BLOCK_TYPES }).notNull(),
    blockOrder: integer('block_order').notNull(),
    /** Inline spans (text, citation and figure markers, inline formulas). */
    content: text('content', { mode: 'json' }).$type<InlineSpan[]>().notNull(),
    plainText: text('plain_text').notNull(),
    sourceXmlId: text('source_xml_id'),
    elementId: text('element_id'),
    sentenceSource: text('sentence_source', { enum: ['extractor', 'segmenter', 'none'] }).notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
  },
  (t) => [uniqueIndex('document_blocks_order_uq').on(t.extractionId, t.blockOrder), index('document_blocks_section_idx').on(t.sectionId)],
);

export const documentPassages = sqliteTable(
  'document_passages',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    sectionId: text('section_id'),
    parentBlockId: text('parent_block_id'),
    /** All blocks that contributed text, in order. */
    blockIds: text('block_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    passageOrder: integer('passage_order').notNull(),
    kind: text('kind', { enum: PASSAGE_KINDS }).notNull(),
    sectionPath: text('section_path').notNull(),
    sectionType: text('section_type', { enum: SECTION_TYPES }).notNull(),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    textHash: text('text_hash').notNull(),
    /** Same value for the same text at the same place of the same PDF across reprocessing. */
    stableKey: text('stable_key').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
    tokenCount: integer('token_count').notNull(),
    language: text('language'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('document_passages_order_uq').on(t.extractionId, t.passageOrder),
    index('document_passages_hash_idx').on(t.textHash),
    index('document_passages_stable_idx').on(t.stableKey),
  ],
);

/** Sentences, kept for later evidence work (M5); not used for claims in M3.3. */
export const documentSentences = sqliteTable(
  'document_sentences',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    passageId: text('passage_id'),
    sentenceOrder: integer('sentence_order').notNull(),
    text: text('text').notNull(),
    textHash: text('text_hash').notNull(),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
  },
  (t) => [index('document_sentences_block_idx').on(t.blockId, t.sentenceOrder), index('document_sentences_passage_idx').on(t.passageId)],
);

/** Bibliography entries as extracted. Never treated as verified; links to works need an exact identifier. */
export const documentReferences = sqliteTable(
  'document_references',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    referenceOrder: integer('reference_order').notNull(),
    rawReference: text('raw_reference'),
    parsedMetadata: text('parsed_metadata', { mode: 'json' }).$type<ReferenceMetadata>().notNull(),
    doi: text('doi'),
    arxivId: text('arxiv_id'),
    sourceXmlId: text('source_xml_id'),
    linkedScholarlyWorkId: text('linked_scholarly_work_id').references(() => scholarlyWorks.id, { onDelete: 'set null' }),
    resolutionStatus: text('resolution_status', { enum: REFERENCE_RESOLUTION }).notNull().default('unresolved'),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex('document_references_order_uq').on(t.extractionId, t.referenceOrder),
    index('document_references_doi_idx').on(t.doi),
    index('document_references_arxiv_idx').on(t.arxivId),
  ],
);

/** Equations, figures and tables. `content` is the extracted text, not a faithful rendering. */
export const documentElements = sqliteTable(
  'document_elements',
  {
    id: text('id').primaryKey(),
    extractionId: text('extraction_id')
      .notNull()
      .references(() => documentExtractions.id, { onDelete: 'cascade' }),
    sectionId: text('section_id'),
    elementType: text('element_type', { enum: ELEMENT_TYPES }).notNull(),
    elementOrder: integer('element_order').notNull(),
    label: text('label'),
    caption: text('caption'),
    content: text('content'),
    sourceXmlId: text('source_xml_id'),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
  },
  (t) => [uniqueIndex('document_elements_order_uq').on(t.extractionId, t.elementOrder)],
);

/** Persistent processing jobs; unfinished ones resume after a restart. */
export const documentJobs = sqliteTable(
  'document_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: DOCUMENT_JOB_KINDS }).notNull(),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => libraryAttachments.id, { onDelete: 'cascade' }),
    libraryItemId: text('library_item_id').notNull(),
    configHash: text('config_hash').notNull(),
    status: text('status', { enum: DOCUMENT_JOB_STATUSES }).notNull(),
    /** Measured progress of the current stage, 0..1, when it can be measured. */
    progress: real('progress'),
    error: text('error', { mode: 'json' }).$type<JobError>(),
    retryCount: integer('retry_count').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    previousExtractionId: text('previous_extraction_id'),
    extractionId: text('extraction_id'),
    /** Free-form notes for the user (fallback used, warnings). */
    notes: text('notes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('document_jobs_unfinished_uq')
      .on(t.attachmentId, t.configHash)
      .where(sql`${t.status} NOT IN ('completed', 'partial', 'needs_ocr', 'failed', 'cancelled')`),
    index('document_jobs_status_idx').on(t.status),
    index('document_jobs_created_idx').on(t.createdAt),
  ],
);

/** One embedding model configuration. Vectors of different spaces are never compared. */
export const embeddingSpaces = sqliteTable(
  'embedding_spaces',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    modelVersion: text('model_version').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('embedding_spaces_uq').on(t.provider, t.model, t.dimensions, t.modelVersion)],
);

/** Embedding cache: one unit-length float32 vector per (space, text hash). */
export const embeddingVectors = sqliteTable(
  'embedding_vectors',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: 'cascade' }),
    textHash: text('text_hash').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.textHash] })],
);

/** Which passages are indexed in which space (and with which text). */
export const passageEmbeddings = sqliteTable(
  'passage_embeddings',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => embeddingSpaces.id, { onDelete: 'cascade' }),
    passageId: text('passage_id')
      .notNull()
      .references(() => documentPassages.id, { onDelete: 'cascade' }),
    extractionId: text('extraction_id').notNull(),
    textHash: text('text_hash').notNull(),
    embeddedAt: text('embedded_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.passageId] }), index('passage_embeddings_extraction_idx').on(t.spaceId, t.extractionId)],
);

// ------------------------------------------------------------------------
// Visual intelligence (M4, migration 0004)
// ------------------------------------------------------------------------

/**
 * Images and renders kept for visual work. Bytes are stored once by SHA-256
 * in the runtime's visual object store, never in SQLite. A variant names its
 * parent and the exact preprocessing that produced it; originals never change.
 */
export const visualAssets = sqliteTable(
  'visual_assets',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: VISUAL_ASSET_KINDS }).notNull(),
    parentAssetId: text('parent_asset_id'),
    /** The original at the root of a variant chain (itself for originals). */
    originalAssetId: text('original_asset_id').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    operations: text('operations', { mode: 'json' }).$type<PreprocessOperation[]>().notNull().default([]),
    preprocessVersion: text('preprocess_version'),
    provenance: text('provenance', { mode: 'json' }).$type<VisualProvenance>().notNull(),
    /** Display name only; never part of a path. */
    label: text('label').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('visual_assets_original_idx').on(t.originalAssetId), index('visual_assets_sha_idx').on(t.sha256), index('visual_assets_created_idx').on(t.createdAt)],
);

export const visualArtifacts = sqliteTable(
  'visual_artifacts',
  {
    id: text('id').primaryKey(),
    artifactType: text('artifact_type', { enum: VISUAL_ARTIFACT_TYPES }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sourceAssetId: text('source_asset_id'),
    currentVersion: integer('current_version').notNull(),
    approval: text('approval', { enum: APPROVAL_STATUSES }).notNull().default('draft'),
    approvedAt: text('approved_at'),
    approvedVersion: integer('approved_version'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('visual_artifacts_updated_idx').on(t.updatedAt), index('visual_artifacts_project_idx').on(t.projectId)],
);

export const visualArtifactVersions = sqliteTable(
  'visual_artifact_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => visualArtifacts.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    sourceCode: text('source_code').notNull(),
    structuredData: text('structured_data', { mode: 'json' }).$type<Record<string, unknown>>(),
    dataCsv: text('data_csv'),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    origin: text('origin', { enum: VERSION_ORIGINS }).notNull(),
    changeDescription: text('change_description').notNull(),
    packages: text('packages', { mode: 'json' }).$type<string[]>().notNull().default([]),
    compilationStatus: text('compilation_status', { enum: COMPILATION_STATUSES }).notNull().default('not-compiled'),
    diagnostics: text('diagnostics', { mode: 'json' }).$type<Diagnostic[]>().notNull().default([]),
    compileLog: text('compile_log'),
    previewAssetId: text('preview_asset_id'),
    taskId: text('task_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('visual_artifact_versions_uq').on(t.artifactId, t.versionNumber)],
);

export const visualTasks = sqliteTable(
  'visual_tasks',
  {
    id: text('id').primaryKey(),
    taskType: text('task_type', { enum: VISUAL_TASK_TYPES }).notNull(),
    /** What ran after automatic detection (null while undecided). */
    resolvedType: text('resolved_type', { enum: VISUAL_TASK_TYPES }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sourceAssetId: text('source_asset_id'),
    inputAssetId: text('input_asset_id'),
    sourceAttachmentId: text('source_attachment_id'),
    sourcePage: integer('source_page'),
    providerId: text('provider_id'),
    providerKind: text('provider_kind'),
    model: text('model'),
    privacyMode: text('privacy_mode', { enum: PRIVACY_MODES }).notNull(),
    consentAt: text('consent_at'),
    promptVersion: text('prompt_version').notNull(),
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: VISUAL_TASK_STATUSES }).notNull(),
    progress: text('progress'),
    error: text('error'),
    /** Choices offered when the classification was ambiguous. */
    choices: text('choices', { mode: 'json' }).$type<string[]>(),
    usage: text('usage', { mode: 'json' }).$type<Record<string, number | null>>(),
    artifactId: text('artifact_id'),
    artifactVersion: integer('artifact_version'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('visual_tasks_created_idx').on(t.createdAt), index('visual_tasks_status_idx').on(t.status)],
);

/** A reviewed insertion of an artifact version into a project, kept for rollback. */
export const visualInsertions = sqliteTable(
  'visual_insertions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    artifactId: text('artifact_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    createdFiles: text('created_files', { mode: 'json' }).$type<{ path: string; hash: string }[]>().notNull(),
    /** Files changed in place (the target file, and the main file when a preamble change was approved), with their content before. */
    modifiedFiles: text('modified_files', { mode: 'json' }).$type<{ path: string; beforeHash: string; afterHash: string; before: string }[]>().notNull(),
    status: text('status', { enum: INSERTION_STATUSES }).notNull(),
    createdAt: text('created_at').notNull(),
    rolledBackAt: text('rolled_back_at'),
  },
  (t) => [index('visual_insertions_project_idx').on(t.projectId)],
);

// ------------------------------------------------------------------------
// Evidence-linked writing (M5, `0005_evidence`)
// ------------------------------------------------------------------------

/** One parsed version of a manuscript file (by content hash). */
export const manuscriptRevisions = sqliteTable(
  'manuscript_revisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    fileHash: text('file_hash').notNull(),
    parserVersion: text('parser_version').notNull(),
    blockCount: integer('block_count').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('manuscript_revisions_file_idx').on(t.projectId, t.filePath, t.createdAt)],
);

/** Stable identity of a manuscript block (paragraph, display, caption, …), carried across edits by reconciliation. */
export const manuscriptBlocks = sqliteTable(
  'manuscript_blocks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    kind: text('kind', { enum: MANUSCRIPT_BLOCK_KINDS }).notNull(),
    sectionId: text('section_id'),
    sectionPath: text('section_path').notNull(),
    parentBlockId: text('parent_block_id'),
    blockOrder: integer('block_order').notNull(),
    text: text('text').notNull(),
    textHash: text('text_hash').notNull(),
    prefixContext: text('prefix_context').notNull(),
    suffixContext: text('suffix_context').notNull(),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    structurePath: text('structure_path').notNull(),
    revisionId: text('revision_id').notNull(),
    status: text('status', { enum: ANCHOR_STATUSES }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('manuscript_blocks_file_idx').on(t.projectId, t.filePath, t.blockOrder), index('manuscript_blocks_hash_idx').on(t.projectId, t.textHash)],
);

/** Stable identity of a sentence within a block. */
export const manuscriptSentences = sqliteTable(
  'manuscript_sentences',
  {
    id: text('id').primaryKey(),
    blockId: text('block_id')
      .notNull()
      .references(() => manuscriptBlocks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    sentenceOrder: integer('sentence_order').notNull(),
    text: text('text').notNull(),
    textHash: text('text_hash').notNull(),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    status: text('status', { enum: ANCHOR_STATUSES }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('manuscript_sentences_block_idx').on(t.blockId, t.sentenceOrder), index('manuscript_sentences_hash_idx').on(t.projectId, t.textHash)],
);

export const scientificClaims = sqliteTable(
  'scientific_claims',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull(),
    documentBlockId: text('document_block_id').notNull(),
    sentenceId: text('sentence_id'),
    originalText: text('original_text').notNull(),
    claimText: text('claim_text').notNull(),
    spanStart: integer('span_start'),
    spanEnd: integer('span_end'),
    normalizedText: text('normalized_text').notNull(),
    claimType: text('claim_type').notNull(),
    atomicity: text('atomicity', { enum: ATOMICITY }).notNull(),
    entities: text('entities', { mode: 'json' }).$type<string[]>().notNull().default([]),
    concepts: text('concepts', { mode: 'json' }).$type<string[]>().notNull().default([]),
    quantities: text('quantities', { mode: 'json' }).$type<ClaimQuantity[]>().notNull().default([]),
    assumptions: text('assumptions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    textHash: text('text_hash').notNull(),
    documentRevision: text('document_revision').notNull(),
    status: text('status', { enum: CLAIM_STATUSES }).notNull(),
    reviewState: text('review_state', { enum: CLAIM_REVIEW_STATES }).notNull(),
    requiresEvidence: integer('requires_evidence', { mode: 'boolean' }).notNull(),
    exclusionReason: text('exclusion_reason'),
    /** Claims produced by a split or merge keep their origin. */
    derivedFrom: text('derived_from', { mode: 'json' }).$type<string[]>().notNull().default([]),
    extractedBy: text('extracted_by').notNull(),
    modelProvider: text('model_provider'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('scientific_claims_project_idx').on(t.projectId, t.status), index('scientific_claims_block_idx').on(t.documentBlockId), index('scientific_claims_hash_idx').on(t.projectId, t.textHash)],
);

export const claimAnchors = sqliteTable(
  'claim_anchors',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .unique()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    filePath: text('file_path').notNull(),
    blockId: text('block_id').notNull(),
    sentenceId: text('sentence_id'),
    sectionId: text('section_id'),
    sectionPath: text('section_path').notNull(),
    parentBlockId: text('parent_block_id'),
    textSnapshot: text('text_snapshot').notNull(),
    prefixContext: text('prefix_context').notNull(),
    suffixContext: text('suffix_context').notNull(),
    textHash: text('text_hash').notNull(),
    revision: text('revision').notNull(),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    structurePath: text('structure_path').notNull(),
    mappingStatus: text('mapping_status', { enum: ANCHOR_STATUSES }).notNull(),
    /** The anchored text before the last material change (for comparison). */
    previousText: text('previous_text'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('claim_anchors_file_idx').on(t.projectId, t.filePath)],
);

/** One snapshot of a source text, shared by every claim that retrieved it. Kept when the paper or extraction is removed. */
export const evidenceSources = sqliteTable(
  'evidence_sources',
  {
    id: text('id').primaryKey(),
    snapshotHash: text('snapshot_hash').notNull().unique(),
    level: text('level', { enum: EVIDENCE_LEVELS }).notNull(),
    scholarlyWorkId: text('scholarly_work_id').references(() => scholarlyWorks.id, { onDelete: 'set null' }),
    libraryItemId: text('library_item_id').references(() => libraryItems.id, { onDelete: 'set null' }),
    attachmentId: text('attachment_id'),
    extractionId: text('extraction_id'),
    passageId: text('passage_id'),
    stableKey: text('stable_key'),
    passageTextHash: text('passage_text_hash'),
    sourceSha256: text('source_sha256'),
    extractorVersion: text('extractor_version'),
    externalId: text('external_id'),
    doi: text('doi'),
    arxivId: text('arxiv_id'),
    url: text('url'),
    title: text('title').notNull(),
    authors: text('authors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    year: integer('year'),
    venue: text('venue'),
    publicationType: text('publication_type'),
    sectionPath: text('section_path'),
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),
    coordinates: text('coordinates', { mode: 'json' }).$type<DocumentCoordinate[]>().notNull().default([]),
    text: text('text').notNull(),
    contextBefore: text('context_before'),
    contextAfter: text('context_after'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('evidence_sources_passage_idx').on(t.passageId), index('evidence_sources_stable_idx').on(t.stableKey), index('evidence_sources_work_idx').on(t.scholarlyWorkId)],
);

/** A claim's link to a source (the claim–evidence relation), with how it was found. */
export const evidenceRecords = sqliteTable(
  'evidence_records',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => evidenceSources.id),
    retrievalMethod: text('retrieval_method', { enum: RETRIEVAL_METHODS }).notNull(),
    queryVariant: text('query_variant'),
    relevanceRank: integer('relevance_rank'),
    keywordRank: integer('keyword_rank'),
    semanticRank: integer('semantic_rank'),
    fusedScore: real('fused_score'),
    retrievalIndexVersion: text('retrieval_index_version'),
    claimTextHash: text('claim_text_hash').notNull(),
    status: text('status', { enum: EVIDENCE_RECORD_STATUSES }).notNull(),
    retrievedAt: text('retrieved_at').notNull(),
  },
  (t) => [uniqueIndex('evidence_records_uq').on(t.claimId, t.sourceId), index('evidence_records_source_idx').on(t.sourceId)],
);

/** AI assessments, append-only: a new analysis supersedes, never overwrites. */
export const evidenceAssessments = sqliteTable(
  'evidence_assessments',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    evidenceRecordId: text('evidence_record_id')
      .notNull()
      .references(() => evidenceRecords.id, { onDelete: 'cascade' }),
    assessment: text('assessment', { enum: ASSESSMENTS }).notNull(),
    explanation: text('explanation').notNull(),
    supportingText: text('supporting_text'),
    excerptVerified: integer('excerpt_verified', { mode: 'boolean' }).notNull(),
    supportedSubclaims: text('supported_subclaims', { mode: 'json' }).$type<string[]>().notNull().default([]),
    unsupportedSubclaims: text('unsupported_subclaims', { mode: 'json' }).$type<string[]>().notNull().default([]),
    contradictoryStatements: text('contradictory_statements', { mode: 'json' }).$type<string[]>().notNull().default([]),
    limitations: text('limitations', { mode: 'json' }).$type<string[]>().notNull().default([]),
    uncertainty: text('uncertainty', { enum: UNCERTAINTY }).notNull(),
    validationNotes: text('validation_notes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    modelProvider: text('model_provider').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    assessmentVersion: text('assessment_version').notNull(),
    claimTextHash: text('claim_text_hash').notNull(),
    sourceSnapshotHash: text('source_snapshot_hash').notNull(),
    status: text('status', { enum: ASSESSMENT_STATES }).notNull(),
    jobId: text('job_id'),
    createdAt: text('created_at').notNull(),
    supersededAt: text('superseded_at'),
  },
  (t) => [index('evidence_assessments_record_idx').on(t.evidenceRecordId, t.createdAt), index('evidence_assessments_claim_idx').on(t.claimId, t.status)],
);

/** Human review, kept apart from AI assessments. */
export const evidenceReviews = sqliteTable(
  'evidence_reviews',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    evidenceRecordId: text('evidence_record_id').references(() => evidenceRecords.id, { onDelete: 'cascade' }),
    assessmentId: text('assessment_id'),
    decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
    reclassifiedAs: text('reclassified_as', { enum: ASSESSMENTS }),
    note: text('note'),
    actor: text('actor'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('evidence_reviews_claim_idx').on(t.claimId, t.createdAt)],
);

export const conflictAnalyses = sqliteTable(
  'conflict_analyses',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    supportingRecordId: text('supporting_record_id').notNull(),
    opposingRecordId: text('opposing_record_id').notNull(),
    category: text('category', { enum: CONFLICT_CATEGORIES }).notNull(),
    explanation: text('explanation').notNull(),
    differences: text('differences', { mode: 'json' }).$type<{ aspect: string; supporting: string; opposing: string }[]>().notNull().default([]),
    uncertainty: text('uncertainty', { enum: UNCERTAINTY }).notNull(),
    modelProvider: text('model_provider').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: text('status', { enum: ASSESSMENT_STATES }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('conflict_analyses_claim_idx').on(t.claimId)],
);

export const citationRecommendations = sqliteTable(
  'citation_recommendations',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id')
      .notNull()
      .references(() => scientificClaims.id, { onDelete: 'cascade' }),
    scholarlyWorkId: text('scholarly_work_id').references(() => scholarlyWorks.id, { onDelete: 'set null' }),
    libraryItemId: text('library_item_id'),
    citationKey: text('citation_key').notNull(),
    keySource: text('key_source').notNull(),
    recommendedPlacement: text('recommended_placement', { enum: CITATION_PLACEMENTS }).notNull(),
    evidenceAssessmentId: text('evidence_assessment_id'),
    evidenceRecordId: text('evidence_record_id'),
    reason: text('reason').notNull(),
    status: text('status', { enum: CITATION_RECOMMENDATION_STATUSES }).notNull(),
    proposalId: text('proposal_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('citation_recommendations_claim_idx').on(t.claimId)],
);

export const writingSuggestions = sqliteTable(
  'writing_suggestions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentBlockId: text('document_block_id'),
    filePath: text('file_path').notNull(),
    originalText: text('original_text').notNull(),
    proposedText: text('proposed_text'),
    suggestionType: text('suggestion_type').notNull(),
    explanation: text('explanation').notNull(),
    findings: text('findings', { mode: 'json' }).$type<Record<string, unknown>[]>().notNull().default([]),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default([]),
    meaningCheck: text('meaning_check', { mode: 'json' }).$type<Record<string, unknown>>(),
    proposalId: text('proposal_id'),
    modelProvider: text('model_provider'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    status: text('status', { enum: WRITING_SUGGESTION_STATUSES }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('writing_suggestions_project_idx').on(t.projectId, t.createdAt)],
);

export const manuscriptReviews = sqliteTable(
  'manuscript_reviews',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentRevision: text('document_revision').notNull(),
    reviewScope: text('review_scope', { enum: REVIEW_SCOPES }).notNull(),
    scopeDetail: text('scope_detail', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: EVIDENCE_JOB_STATUSES }).notNull(),
    coverage: text('coverage', { mode: 'json' }).$type<Record<string, unknown>>(),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    modelProvider: text('model_provider'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [index('manuscript_reviews_project_idx').on(t.projectId, t.startedAt)],
);

/** Persistent background jobs for M5 (extraction, retrieval, assessment, revalidation, review, writing). */
export const evidenceJobs = sqliteTable(
  'evidence_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: EVIDENCE_JOB_KINDS }).notNull(),
    status: text('status', { enum: EVIDENCE_JOB_STATUSES }).notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    progress: text('progress', { mode: 'json' }).$type<{ done: number; total: number; message: string | null }>().notNull(),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    error: text('error'),
    providerId: text('provider_id'),
    providerKind: text('provider_kind'),
    modelId: text('model_id'),
    privacyMode: text('privacy_mode', { enum: PRIVACY_MODES }),
    consentAt: text('consent_at'),
    /** What left the computer (counts only, never the text). */
    outgoing: text('outgoing', { mode: 'json' }).$type<{ manuscriptChars: number; sourceChars: number; passages: number; requests: number }>(),
    usage: text('usage', { mode: 'json' }).$type<Record<string, number | null>>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('evidence_jobs_project_idx').on(t.projectId, t.createdAt), index('evidence_jobs_status_idx').on(t.status)],
);
