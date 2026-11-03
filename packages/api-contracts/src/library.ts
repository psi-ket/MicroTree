import { z } from 'zod';
import {
  ATTACHMENT_SOURCES,
  ATTACHMENT_TYPES,
  BIB_CHANGE_KINDS,
  CITATION_KEY_FORMATS,
  CITE_COMMANDS,
  EDITABLE_FIELDS,
  EXTERNAL_LIBRARY_PROVIDERS,
  IMPORT_ITEM_OUTCOMES,
  IMPORT_JOB_KINDS,
  IMPORT_JOB_STATUSES,
  LIBRARY_SORTS,
  MATCH_CONFIDENCES,
  METADATA_STATUSES,
  PUBLICATION_TYPES,
  READING_STATUSES,
  SYNC_STATUSES,
  WORK_ORIGINS,
  ZOTERO_MODES,
  type BibUpdatePreview,
  type ImportJob,
  type LibraryAttachment,
  type LibraryCollection,
  type LibraryItem,
  type LibraryItemPage,
  type LibraryItemSummary,
  type LibraryOverview,
  type LibraryPreferences,
  type LibraryTag,
  type ProjectReferences,
  type ZoteroImportPreview,
  type ZoteroStatus,
} from '@research-studio/shared-types';
import { ScholarlyWorkSchema } from './literature';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

const Id = z.string().min(3).max(80).regex(/^[A-Za-z0-9_:-]+$/);
const ItemIds = z.array(Id).min(1).max(1000);
const Iso = z.string();
const ReadingStatus = z.enum(READING_STATUSES);
const NullableText = (max: number) => z.string().max(max).nullable();

// ----------------------------------------------------------------- items

const EditedAuthorSchema = z.object({ givenName: NullableText(200), familyName: NullableText(200), name: NullableText(400) });
const BibFieldSchema = z.object({ name: z.string().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9_:+.-]*$/), value: z.string().max(100_000), bare: z.boolean().optional() });

export const WorkEditsSchema = z
  .object({
    title: z.string().max(2000),
    authors: z.array(EditedAuthorSchema).max(2000),
    publicationYear: z.number().int().nullable(),
    publicationDate: NullableText(10),
    venue: NullableText(1000),
    publisher: NullableText(1000),
    publicationType: z.enum(PUBLICATION_TYPES).nullable(),
    volume: NullableText(100),
    issue: NullableText(100),
    pages: NullableText(100),
    abstract: NullableText(100_000),
    doi: NullableText(300),
    arxivId: NullableText(100),
    url: NullableText(2000),
  })
  .partial();

const MatchCandidateSchema = z.object({ work: ScholarlyWorkSchema, confidence: z.enum(MATCH_CONFIDENCES), reasons: z.array(z.string()) });
const MetadataMatchSchema = z.object({
  confidence: z.enum(MATCH_CONFIDENCES),
  candidates: z.array(MatchCandidateSchema),
  extracted: z.object({ dois: z.array(z.string()), arxivIds: z.array(z.string()), title: z.string().nullable(), authors: z.array(z.string()), titleSource: z.string().nullable() }),
  decidedAt: z.string().nullable(),
});

export const LibraryAttachmentSchema = z.object({
  id: z.string(),
  libraryItemId: z.string(),
  fileName: z.string(),
  originalFileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int(),
  sha256: z.string(),
  attachmentType: z.enum(ATTACHMENT_TYPES),
  source: z.enum(ATTACHMENT_SOURCES),
  sourceUrl: z.string().nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  available: z.boolean(),
});
assertType<Exact<z.infer<typeof LibraryAttachmentSchema>, LibraryAttachment>>();

const ExternalLinkSchema = z.object({
  provider: z.enum(EXTERNAL_LIBRARY_PROVIDERS),
  externalLibraryId: z.string(),
  externalItemId: z.string(),
  externalVersion: z.number().int().nullable(),
  lastSyncedAt: z.string().nullable(),
  syncStatus: z.enum(SYNC_STATUSES),
  conflict: z.object({ fields: z.array(z.object({ field: z.string(), local: z.string().nullable(), remote: z.string().nullable() })), detectedAt: z.string() }).nullable(),
});

export const LibraryItemSummarySchema = z.object({
  id: z.string(),
  workId: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  authorCount: z.number().int(),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  publicationType: z.enum(PUBLICATION_TYPES).nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  citationKey: z.string().nullable(),
  readingStatus: ReadingStatus,
  isFavorite: z.boolean(),
  metadataStatus: z.enum(METADATA_STATUSES),
  origin: z.enum(WORK_ORIGINS),
  pdfCount: z.number().int(),
  collectionIds: z.array(z.string()),
  tags: z.array(z.string()),
  addedAt: Iso,
  updatedAt: Iso,
  lastOpenedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
assertType<Exact<z.infer<typeof LibraryItemSummarySchema>, LibraryItemSummary>>();

export const LibraryItemSchema = z.object({
  id: z.string(),
  workId: z.string(),
  work: ScholarlyWorkSchema,
  origin: z.enum(WORK_ORIGINS),
  edits: WorkEditsSchema,
  localSource: z.record(z.string(), z.unknown()).nullable(),
  citationKey: z.string().nullable(),
  readingStatus: ReadingStatus,
  isFavorite: z.boolean(),
  notes: z.string(),
  metadataStatus: z.enum(METADATA_STATUSES),
  match: MetadataMatchSchema.nullable(),
  bibtexType: z.string().nullable(),
  bibtexExtra: z.array(BibFieldSchema),
  tags: z.array(z.string()),
  collections: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().nullable() })),
  attachments: z.array(LibraryAttachmentSchema),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  external: z.array(ExternalLinkSchema),
  addedAt: Iso,
  updatedAt: Iso,
  lastOpenedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
assertType<Exact<z.infer<typeof LibraryItemSchema>, LibraryItem>>();

export const LibraryCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  itemCount: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
assertType<Exact<z.infer<typeof LibraryCollectionSchema>, LibraryCollection>>();

export const LibraryTagSchema = z.object({ id: z.string(), name: z.string(), itemCount: z.number().int() });
assertType<Exact<z.infer<typeof LibraryTagSchema>, LibraryTag>>();

export const LibraryOverviewSchema = z.object({
  total: z.number().int(),
  withPdf: z.number().int(),
  byStatus: z.record(ReadingStatus, z.number().int()),
  archived: z.number().int(),
  favorites: z.number().int(),
  needsReview: z.number().int(),
  collections: z.array(LibraryCollectionSchema),
  recentlyAdded: z.array(LibraryItemSummarySchema),
  recentlyOpened: z.array(LibraryItemSummarySchema),
});
assertType<Exact<z.infer<typeof LibraryOverviewSchema>, LibraryOverview>>();
export const LibraryOverviewResponse = z.object({ overview: LibraryOverviewSchema });

export const LibraryItemPageSchema = z.object({ items: z.array(LibraryItemSummarySchema), total: z.number().int(), offset: z.number().int(), limit: z.number().int() });
assertType<Exact<z.infer<typeof LibraryItemPageSchema>, LibraryItemPage>>();

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');
export const LibraryItemQuerySchema = z.object({
  q: z.string().max(300).optional(),
  collectionId: Id.optional(),
  tag: z.string().max(80).optional(),
  readingStatus: ReadingStatus.optional(),
  metadataStatus: z.enum(METADATA_STATUSES).optional(),
  favorite: boolParam.optional(),
  hasPdf: boolParam.optional(),
  author: z.string().max(200).optional(),
  yearFrom: z.coerce.number().int().min(0).max(3000).optional(),
  yearTo: z.coerce.number().int().min(0).max(3000).optional(),
  archived: z.enum(['active', 'archived', 'all']).optional(),
  projectId: z.string().max(64).optional(),
  sort: z.enum(LIBRARY_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const AddOptionsSchema = z.object({
  readingStatus: ReadingStatus.optional(),
  isFavorite: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(80)).max(50).optional(),
  collectionIds: z.array(Id).max(50).optional(),
  notes: z.string().max(100_000).optional(),
  citationKey: z.string().max(200).nullable().optional(),
});

/** Add a paper. A search result is sent by its canonical ID and fetched by the runtime; the browser never supplies metadata for it. */
export const AddLibraryItemRequest = z.discriminatedUnion('source', [
  z.object({ source: z.literal('work'), workId: z.string().min(3).max(400), fetchOpenAccessPdf: z.boolean().optional(), options: AddOptionsSchema.optional() }),
  z.object({ source: z.literal('identifier'), kind: z.enum(['doi', 'arxiv']), value: z.string().min(1).max(400), fetchOpenAccessPdf: z.boolean().optional(), options: AddOptionsSchema.optional() }),
  z.object({
    source: z.literal('manual'),
    reference: WorkEditsSchema.extend({ title: z.string().min(1).max(2000), bibtexType: z.string().max(40).optional() }),
    options: AddOptionsSchema.optional(),
  }),
]);

export const LibraryItemResponse = z.object({ item: LibraryItemSchema });

export const UpdateLibraryItemRequest = z
  .object({
    edits: WorkEditsSchema,
    revertFields: z.array(z.enum(EDITABLE_FIELDS)).max(EDITABLE_FIELDS.length),
    readingStatus: ReadingStatus,
    isFavorite: z.boolean(),
    notes: z.string().max(100_000),
    tags: z.array(z.string().min(1).max(80)).max(100),
    bibtexType: z.string().max(40).regex(/^[A-Za-z]*$/).nullable(),
    bibtexExtra: z.array(BibFieldSchema).max(200),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const BulkLibraryRequest = z.object({
  itemIds: ItemIds,
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('set-status'), readingStatus: ReadingStatus }),
    z.object({ kind: z.literal('favorite'), value: z.boolean() }),
    z.object({ kind: z.literal('archive'), value: z.boolean() }),
    z.object({ kind: z.literal('add-tags'), tags: z.array(z.string().min(1).max(80)).min(1).max(50) }),
    z.object({ kind: z.literal('remove-tags'), tags: z.array(z.string().min(1).max(80)).min(1).max(50) }),
    z.object({ kind: z.literal('add-to-collection'), collectionId: Id }),
    z.object({ kind: z.literal('remove-from-collection'), collectionId: Id }),
  ]),
});
export const BulkLibraryResponse = z.object({ updated: z.number().int() });

export const ItemIdsRequest = z.object({ itemIds: ItemIds });
export const DeletionImpactResponse = z.object({
  items: z.number().int(),
  attachments: z.number().int(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), items: z.number().int() })),
  externalLinks: z.number().int(),
});
export const DeleteItemsResponse = z.object({ deleted: z.number().int() });

export const SetCitationKeyRequest = z.object({ key: z.string().min(1).max(200), confirm: z.boolean().optional() });
export const CitationKeySuggestionsResponse = z.object({ suggestions: z.array(z.string()) });
export const RegenerateKeysRequest = z.object({ itemIds: ItemIds, replaceExisting: z.boolean() });
export const RegenerateKeysResponse = z.object({ changed: z.array(z.object({ id: z.string(), from: z.string().nullable(), to: z.string() })), kept: z.array(z.string()) });

export const MatchRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept-candidate'), candidateWorkId: z.string().min(3).max(400) }),
  z.object({ action: z.literal('link-work'), workId: z.string().min(3).max(400) }),
  z.object({ action: z.literal('keep-unresolved') }),
]);

export const MergeRequest = z.object({ keepId: Id, dropId: Id });
export const MergeResponse = z.object({ item: LibraryItemSchema, droppedKey: z.string().nullable() });
export const DuplicatesResponse = z.object({ groups: z.array(z.object({ items: z.array(LibraryItemSummarySchema), reason: z.string() })) });
export const TagsResponse = z.object({ tags: z.array(LibraryTagSchema) });

// ------------------------------------------------------------ attachments

export const AttachmentResponse = z.object({ attachment: LibraryAttachmentSchema });
export const RenameAttachmentRequest = z.object({ fileName: z.string().min(1).max(200) });
/** Counts only: storage locations are never sent to the browser. */
export const StorageReportResponse = z.object({
  tmpRemoved: z.number().int(),
  orphansRemoved: z.number().int(),
  strays: z.number().int(),
  missingFiles: z.number().int(),
});

// ---------------------------------------------------------------- imports

const ImportItemResultSchema = z.object({
  label: z.string(),
  outcome: z.enum(IMPORT_ITEM_OUTCOMES),
  libraryItemId: z.string().nullable(),
  confidence: z.enum(MATCH_CONFIDENCES).nullable(),
  message: z.string().nullable(),
});
export const ImportJobSchema = z.object({
  id: z.string(),
  kind: z.enum(IMPORT_JOB_KINDS),
  status: z.enum(IMPORT_JOB_STATUSES),
  total: z.number().int(),
  processed: z.number().int(),
  items: z.array(ImportItemResultSchema),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: Iso,
  finishedAt: z.string().nullable(),
});
assertType<Exact<z.infer<typeof ImportJobSchema>, ImportJob>>();
export const ImportJobResponse = z.object({ job: ImportJobSchema });
export const AddLibraryItemResponse = z.object({
  item: LibraryItemSchema,
  created: z.boolean(),
  duplicateReason: z.string().nullable(),
  likelyDuplicates: z.array(z.object({ libraryItemId: z.string(), reason: z.string() })),
  notices: z.array(z.string()),
  /** Background download of the paper's listed open-access PDF, when one was started. */
  job: ImportJobSchema.nullable(),
});
export const ImportJobListResponse = z.object({ jobs: z.array(ImportJobSchema) });
export const ImportJobParams = z.object({ jobId: Id });

export const ReferenceFormatSchema = z.enum(['bibtex', 'ris']);
/** Largest BibTeX/RIS text accepted (the request body limit is set from this). */
export const MAX_REFERENCE_TEXT = 20 * 1024 * 1024;
export const ReferencePreviewRequest = z.object({ format: ReferenceFormatSchema, text: z.string().max(MAX_REFERENCE_TEXT) });
export const ReferencePreviewResponse = z.object({
  format: ReferenceFormatSchema,
  entries: z.array(
    z.object({
      index: z.number().int(),
      label: z.string(),
      title: z.string().nullable(),
      authors: z.array(z.string()),
      year: z.number().int().nullable(),
      doi: z.string().nullable(),
      arxivId: z.string().nullable(),
      citationKey: z.string().nullable(),
      state: z.enum(['new', 'duplicate', 'likely-duplicate', 'invalid']),
      libraryItemId: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
});
export const ReferenceImportRequest = ReferencePreviewRequest.extend({
  only: z.array(z.number().int().min(0)).max(100_000).optional(),
  resolveIdentifiers: z.boolean().default(true),
  searchTitles: z.boolean().default(false),
  options: AddOptionsSchema.pick({ tags: true, collectionIds: true, readingStatus: true }).optional(),
});
export const IdentifierImportRequest = z.object({ text: z.string().min(1).max(100_000), options: AddOptionsSchema.pick({ tags: true, collectionIds: true }).optional() });

// ------------------------------------------------------------ collections

export const CollectionsResponse = z.object({ collections: z.array(LibraryCollectionSchema) });
export const CollectionResponse = z.object({ collection: LibraryCollectionSchema });
export const CreateCollectionRequest = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() });
export const UpdateCollectionRequest = CreateCollectionRequest.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export const CollectionParams = z.object({ collectionId: Id });
export const MoveItemsRequest = z.object({ fromId: Id, toId: Id, itemIds: ItemIds });
export const CountResponse = z.object({ count: z.number().int() });

// ----------------------------------------------------------------- export

export const ExportRequest = z.object({
  format: ReferenceFormatSchema,
  selection: z.union([z.object({ itemIds: ItemIds }), z.object({ collectionId: Id }), z.object({ projectId: z.string().min(1).max(64) }), z.object({ all: z.literal(true) })]),
});
export const ExportResponse = z.object({ format: ReferenceFormatSchema, text: z.string(), count: z.number().int(), fileName: z.string() });
// ------------------------------------------------------------ preferences

export const LibraryPreferencesSchema = z.object({
  citationKeyFormat: z.enum(CITATION_KEY_FORMATS),
  customKeyTemplate: z.string().min(1).max(100),
  fetchOpenAccessPdf: z.boolean(),
});
assertType<Exact<z.infer<typeof LibraryPreferencesSchema>, LibraryPreferences>>();
export const LibraryPreferencesResponse = z.object({ preferences: LibraryPreferencesSchema });
export const UpdateLibraryPreferencesRequest = LibraryPreferencesSchema.partial();

export const LibraryItemParams = z.object({ itemId: Id });
export const AttachmentParams = z.object({ attachmentId: Id });

// ----------------------------------------------------- project references

const ProjectReferenceSettingsSchema = z.object({ bibFile: z.string(), citeCommand: z.enum(CITE_COMMANDS) });
export const ProjectReferencesSchema = z.object({
  settings: ProjectReferenceSettingsSchema,
  items: z.array(LibraryItemSummarySchema),
  citations: z.array(
    z.object({
      key: z.string(),
      occurrences: z.array(z.object({ file: z.string(), line: z.number().int() })),
      definedIn: z.array(z.string()),
      libraryItemId: z.string().nullable(),
      status: z.enum(['library-and-bib', 'bib-only', 'library-only', 'unresolved']),
    }),
  ),
  bibFiles: z.array(z.string()),
});
assertType<Exact<z.infer<typeof ProjectReferencesSchema>, ProjectReferences>>();
export const ProjectReferenceSettingsResponse = z.object({ settings: ProjectReferenceSettingsSchema });
export const UpdateProjectReferenceSettingsRequest = z.object({ bibFile: z.string().min(5).max(500), citeCommand: z.enum(CITE_COMMANDS) }).partial();

export const BibPreviewRequest = z.object({
  path: z.string().min(5).max(500).optional(),
  itemIds: z.array(Id).max(5000).optional(),
  /** Render only these changes in `proposed` (all applicable ones when absent). */
  changeIds: z.array(z.string().max(20)).max(5000).optional(),
});
export const BibUpdatePreviewSchema = z.object({
  path: z.string(),
  baseHash: z.string().nullable(),
  original: z.string(),
  proposed: z.string(),
  changes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(BIB_CHANGE_KINDS),
      libraryItemId: z.string(),
      citationKey: z.string().nullable(),
      message: z.string(),
      applicable: z.boolean(),
      fields: z.array(z.string()).optional(),
      existingKey: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
});
assertType<Exact<z.infer<typeof BibUpdatePreviewSchema>, BibUpdatePreview>>();
export const BibApplyRequest = BibPreviewRequest.extend({ baseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable() });
export const BibApplyResponse = z.object({ path: z.string(), applied: BibUpdatePreviewSchema.shape.changes });

// ----------------------------------------------------------------- Zotero

export const ZoteroStatusSchema = z.object({
  web: z.object({ configured: z.boolean(), userId: z.string().nullable(), username: z.string().nullable(), canWrite: z.boolean().nullable(), lastError: z.string().nullable() }),
  local: z.object({ enabled: z.boolean(), reachable: z.boolean().nullable(), lastError: z.string().nullable() }),
  linkedItems: z.number().int(),
  conflicts: z.number().int(),
});
assertType<Exact<z.infer<typeof ZoteroStatusSchema>, ZoteroStatus>>();
export const ZoteroStatusResponse = z.object({ status: ZoteroStatusSchema });
/** The key is sent once, kept by the runtime's secret store and never returned. */
export const ZoteroWebKeyRequest = z.object({ apiKey: z.string().regex(/^[A-Za-z0-9]{10,64}$/, 'A Zotero API key is 24 letters and digits') });
export const ZoteroLocalRequest = z.object({ enabled: z.boolean() });
const ZoteroModeSchema = z.enum(ZOTERO_MODES);
export const ZoteroImportPreviewRequest = z.object({ mode: ZoteroModeSchema, collectionKey: z.string().regex(/^[A-Z0-9]{8}$/).optional() });
export const ZoteroImportPreviewSchema = z.object({
  mode: ZoteroModeSchema,
  libraryVersion: z.number().int().nullable(),
  collections: z.array(z.object({ key: z.string(), name: z.string(), parentKey: z.string().nullable(), itemCount: z.number().int().nullable() })),
  items: z.array(
    z.object({
      externalItemId: z.string(),
      version: z.number().int(),
      title: z.string(),
      itemType: z.string(),
      creators: z.array(z.string()),
      year: z.number().int().nullable(),
      doi: z.string().nullable(),
      hasPdf: z.boolean(),
      state: z.enum(['new', 'linked', 'remote-changes', 'conflict', 'duplicate']),
      libraryItemId: z.string().nullable(),
    }),
  ),
  skipped: z.number().int(),
});
assertType<Exact<z.infer<typeof ZoteroImportPreviewSchema>, ZoteroImportPreview>>();
export const ZoteroImportRequest = ZoteroImportPreviewRequest.extend({
  itemKeys: z.array(z.string().regex(/^[A-Z0-9]{8}$/)).max(50_000).optional(),
  importCollections: z.boolean().default(true),
  importPdfs: z.boolean().default(true),
  resolveIdentifiers: z.boolean().default(true),
});
export const ZoteroExportPreviewResponse = z.object({
  items: z.array(z.object({ libraryItemId: z.string(), title: z.string(), action: z.enum(['create', 'update', 'unchanged', 'conflict']), externalItemId: z.string().nullable() })),
});
export const ZoteroConflictRequest = z.object({ keep: z.enum(['local', 'remote']) });
