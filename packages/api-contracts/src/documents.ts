import { z } from 'zod';
import {
  BLOCK_TYPES,
  DOCUMENT_JOB_KINDS,
  DOCUMENT_JOB_STATUSES,
  ELEMENT_TYPES,
  EXTRACTION_ERROR_CODES,
  EXTRACTION_STATUSES,
  EXTRACTORS,
  PASSAGE_KINDS,
  REFERENCE_RESOLUTION,
  SECTION_TYPES,
} from '@research-studio/document-intelligence';
import { PUBLICATION_TYPES } from '@research-studio/shared-types';

// Scientific document intelligence and retrieval (M3.3). Responses never
// contain file-system paths; documents are addressed by attachment ID.

const Id = z.string().min(3).max(120).regex(/^[A-Za-z0-9_:-]+$/);

export const DocumentCoordinateSchema = z.object({
  pageNumber: z.number().int().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  coordinateSystem: z.enum(['pdf-points', 'normalized', 'pymupdf']),
  pageWidth: z.number(),
  pageHeight: z.number(),
  origin: z.enum(['top-left', 'bottom-left']),
});

export const PageGeometrySchema = z.object({
  pageNumber: z.number().int().min(1),
  width: z.number(),
  height: z.number(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  mediaBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  cropBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});

export const JobErrorSchema = z.object({ code: z.enum(EXTRACTION_ERROR_CODES), message: z.string(), retryable: z.boolean(), source: z.string().nullable() });

export const DocumentJobSchema = z.object({
  id: z.string(),
  kind: z.enum(DOCUMENT_JOB_KINDS),
  attachmentId: z.string(),
  libraryItemId: z.string(),
  status: z.enum(DOCUMENT_JOB_STATUSES),
  stageLabel: z.string(),
  /** Overall progress 0..1. */
  progress: z.number(),
  error: JobErrorSchema.nullable(),
  retryCount: z.number().int(),
  attempts: z.number().int(),
  notes: z.array(z.string()),
  extractionId: z.string().nullable(),
  previousExtractionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type DocumentJob = z.infer<typeof DocumentJobSchema>;

export const ExtractionQualitySchema = z.object({
  textCoverage: z.number().nullable(),
  hasTitle: z.boolean(),
  hasAbstract: z.boolean(),
  sectionCount: z.number().int(),
  paragraphCount: z.number().int(),
  referenceCount: z.number().int(),
  coordinateCoverage: z.number(),
  emptyPages: z.array(z.number().int()),
  structure: z.enum(['structured', 'layout']),
});

export const ExtractedMetadataSchema = z.object({
  title: z.string().nullable(),
  authors: z.array(z.object({ name: z.string(), givenName: z.string().nullable(), familyName: z.string().nullable(), email: z.string().nullable(), affiliations: z.array(z.string()) })),
  abstract: z.string().nullable(),
  publicationDate: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  keywords: z.array(z.string()),
  venue: z.string().nullable(),
  language: z.string().nullable(),
});

export const ExtractionSummarySchema = z.object({
  id: z.string(),
  attachmentId: z.string(),
  libraryItemId: z.string(),
  status: z.enum(EXTRACTION_STATUSES),
  isActive: z.boolean(),
  extractor: z.enum(EXTRACTORS),
  extractorVersion: z.string().nullable(),
  parserVersion: z.string(),
  segmenterVersion: z.string(),
  configHash: z.string(),
  sourceSha256: z.string(),
  pageCount: z.number().int().nullable(),
  language: z.string().nullable(),
  metadata: ExtractedMetadataSchema,
  quality: ExtractionQualitySchema,
  warnings: z.array(z.string()),
  processingStartedAt: z.string(),
  processingCompletedAt: z.string().nullable(),
  counts: z.object({ sections: z.number().int(), blocks: z.number().int(), passages: z.number().int(), references: z.number().int(), elements: z.number().int() }),
  /** Why this extraction no longer matches the current settings (empty: up to date). */
  stale: z.array(z.string()),
});
export type ExtractionSummary = z.infer<typeof ExtractionSummarySchema>;

export const DocumentStatusResponse = z.object({
  attachmentId: z.string(),
  extraction: ExtractionSummarySchema.nullable(),
  job: DocumentJobSchema.nullable(),
  embeddings: z.object({ indexedPassages: z.number().int(), embeddablePassages: z.number().int(), spaceId: z.string().nullable() }),
});
export type DocumentStatus = z.infer<typeof DocumentStatusResponse>;

export const DocumentJobResponse = z.object({ job: DocumentJobSchema, created: z.boolean() });
export const DocumentJobListResponse = z.object({ jobs: z.array(DocumentJobSchema) });
export const ProcessAllResponse = z.object({ queued: z.number().int(), alreadyQueued: z.number().int() });

const InlineSpanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('ref'), text: z.string(), refType: z.enum(['bibr', 'figure', 'table', 'formula', 'foot', 'other']), target: z.string().nullable() }),
  z.object({ kind: z.literal('formula'), text: z.string() }),
]);

const Located = { pageStart: z.number().int().nullable(), pageEnd: z.number().int().nullable(), coordinates: z.array(DocumentCoordinateSchema) };

export const DocumentSectionSchema = z.object({
  id: z.string(),
  parentSectionId: z.string().nullable(),
  heading: z.string(),
  headingNumber: z.string().nullable(),
  level: z.number().int(),
  order: z.number().int(),
  path: z.string(),
  type: z.enum(SECTION_TYPES),
  ...Located,
});
export type DocumentSection = z.infer<typeof DocumentSectionSchema>;

export const DocumentBlockSchema = z.object({
  id: z.string(),
  sectionId: z.string().nullable(),
  type: z.enum(BLOCK_TYPES),
  order: z.number().int(),
  spans: z.array(InlineSpanSchema),
  text: z.string(),
  sourceXmlId: z.string().nullable(),
  elementId: z.string().nullable(),
  sentenceSource: z.enum(['extractor', 'segmenter', 'none']),
  ...Located,
});
export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;

export const DocumentElementSchema = z.object({
  id: z.string(),
  sectionId: z.string().nullable(),
  type: z.enum(ELEMENT_TYPES),
  label: z.string().nullable(),
  caption: z.string().nullable(),
  /** Extracted text, not a faithful rendering (in particular of mathematics). */
  content: z.string().nullable(),
  sourceXmlId: z.string().nullable(),
  ...Located,
});
export type DocumentElement = z.infer<typeof DocumentElementSchema>;

export const DocumentReferenceSchema = z.object({
  id: z.string(),
  order: z.number().int(),
  raw: z.string().nullable(),
  parsed: z.object({ title: z.string().nullable(), authors: z.array(z.string()), venue: z.string().nullable(), year: z.number().int().nullable(), volume: z.string().nullable(), pages: z.string().nullable(), publisher: z.string().nullable() }),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  /** A library paper with exactly this DOI or arXiv ID; never a verified match. */
  linkedLibraryItemId: z.string().nullable(),
  resolutionStatus: z.enum(REFERENCE_RESOLUTION),
  ...Located,
});
export type DocumentReference = z.infer<typeof DocumentReferenceSchema>;

export const PassageSchema = z.object({
  id: z.string(),
  extractionId: z.string(),
  order: z.number().int(),
  kind: z.enum(PASSAGE_KINDS),
  sectionId: z.string().nullable(),
  sectionPath: z.string(),
  sectionType: z.enum(SECTION_TYPES),
  text: z.string(),
  tokenCount: z.number().int(),
  textHash: z.string(),
  stableKey: z.string(),
  ...Located,
});
export type Passage = z.infer<typeof PassageSchema>;

export const DocumentStructureResponse = z.object({
  extraction: ExtractionSummarySchema,
  pages: z.array(PageGeometrySchema),
  sections: z.array(DocumentSectionSchema),
  blocks: z.array(DocumentBlockSchema),
  elements: z.array(DocumentElementSchema),
  references: z.array(DocumentReferenceSchema),
});
export type DocumentStructure = z.infer<typeof DocumentStructureResponse>;

export const DocumentSectionsResponse = z.object({ extractionId: z.string(), sections: z.array(DocumentSectionSchema) });
export const DocumentPassagesResponse = z.object({ extractionId: z.string(), passages: z.array(PassageSchema), total: z.number().int(), offset: z.number().int(), limit: z.number().int() });
export const DocumentReferencesResponse = z.object({ extractionId: z.string(), references: z.array(DocumentReferenceSchema) });
export const DocumentElementsResponse = z.object({ extractionId: z.string(), elements: z.array(DocumentElementSchema) });

export const AttachmentDocumentParams = z.object({ attachmentId: Id });
export const PassageParams = z.object({ passageId: Id });
export const PageQuery = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) });
export const JobsQuery = z.object({ status: z.enum(['active', 'failed', 'all']).default('all'), limit: z.coerce.number().int().min(1).max(500).default(100) });

// ------------------------------------------------------------------ search

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;

export const SearchScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }),
  z.object({ kind: z.literal('collections'), collectionIds: z.array(Id).min(1).max(100) }),
  z.object({ kind: z.literal('papers'), libraryItemIds: z.array(Id).min(1).max(500) }),
]);

export const ResearchSearchRequest = z.object({
  query: z.string().trim().min(1, 'Enter a search').max(1000),
  mode: z.enum(SEARCH_MODES).default('hybrid'),
  scope: SearchScopeSchema.default({ kind: 'library' }),
  filters: z
    .object({
      author: z.string().trim().max(200).optional(),
      yearFrom: z.number().int().min(1000).max(3000).optional(),
      yearTo: z.number().int().min(1000).max(3000).optional(),
      venue: z.string().trim().max(300).optional(),
      sectionTypes: z.array(z.enum(SECTION_TYPES)).max(SECTION_TYPES.length).optional(),
      publicationTypes: z.array(z.enum(PUBLICATION_TYPES)).max(PUBLICATION_TYPES.length).optional(),
      /** Include bibliography entries (excluded from body retrieval by default). */
      includeReferences: z.boolean().optional(),
    })
    .default({}),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(450).default(0),
});

export const SimilarPassagesRequest = z.object({
  passageId: Id,
  scope: SearchScopeSchema.default({ kind: 'library' }),
  limit: z.number().int().min(1).max(50).default(10),
});

const PaperRefSchema = z.object({
  libraryItemId: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  publicationType: z.string().nullable(),
});

export const ProvenanceSchema = z.object({
  attachmentId: z.string(),
  sourceSha256: z.string(),
  extractionId: z.string(),
  extractor: z.enum(EXTRACTORS),
  extractorVersion: z.string().nullable(),
  parserVersion: z.string(),
  configHash: z.string(),
  extractedAt: z.string(),
  attachmentSource: z.string(),
  attachmentSourceUrl: z.string().nullable(),
  attachmentAddedAt: z.string(),
  license: z.string().nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SearchResultSchema = z.object({
  passageId: z.string(),
  position: z.number().int(),
  /** Rank-fusion (or single-list) score. Not a probability of relevance or correctness. */
  score: z.number(),
  keywordRank: z.number().int().nullable(),
  semanticRank: z.number().int().nullable(),
  keywordScore: z.number().nullable(),
  semanticScore: z.number().nullable(),
  matchedBy: z.enum(['keyword', 'semantic', 'hybrid']),
  documentId: z.string(),
  attachmentId: z.string(),
  kind: z.enum(PASSAGE_KINDS),
  sectionPath: z.string(),
  sectionType: z.enum(SECTION_TYPES),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  hasCoordinates: z.boolean(),
  /** The exact passage text as extracted. */
  text: z.string(),
  paper: PaperRefSchema,
  provenance: ProvenanceSchema,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const ResearchSearchResponse = z.object({
  query: z.string(),
  understood: z.object({ notes: z.array(z.string()), sections: z.array(z.enum(SECTION_TYPES)), doi: z.string().nullable(), arxivId: z.string().nullable() }),
  mode: z.enum(SEARCH_MODES),
  results: z.array(SearchResultSchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  relaxed: z.boolean(),
  semantic: z.object({ used: z.boolean(), reason: z.string().nullable(), model: z.string().nullable() }),
  warnings: z.array(z.string()),
  papersSearched: z.number().int(),
});
export type ResearchSearch = z.infer<typeof ResearchSearchResponse>;

export const PassageDetailResponse = z.object({
  passage: PassageSchema,
  paper: PaperRefSchema,
  provenance: ProvenanceSchema,
  before: z.array(PassageSchema),
  after: z.array(PassageSchema),
  sentences: z.array(z.object({ id: z.string(), order: z.number().int(), text: z.string(), ...Located })),
});
export type PassageDetail = z.infer<typeof PassageDetailResponse>;

export const PassageLocationResponse = z.object({
  passageId: z.string(),
  attachmentId: z.string(),
  /** Page to open (one-based), null when the extractor did not report one. */
  pageNumber: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  /** Boxes to highlight; empty when none were reported (then no highlight is drawn). */
  coordinates: z.array(DocumentCoordinateSchema),
  pages: z.array(PageGeometrySchema),
});
export type PassageLocation = z.infer<typeof PassageLocationResponse>;

// --------------------------------------------------------------- providers

export const ServiceStatusSchema = z.object({
  status: z.enum(['available', 'initialising', 'unavailable', 'disabled', 'refused']),
  version: z.string().nullable(),
  message: z.string().nullable(),
});

export const RetrievalProvidersResponse = z.object({
  grobid: ServiceStatusSchema.extend({
    host: z.string().nullable(),
    /** True when PDFs are sent to another computer. */
    remote: z.boolean(),
    consolidation: z.boolean(),
  }),
  pymupdf: ServiceStatusSchema.extend({ python: z.string() }),
  embeddings: ServiceStatusSchema.extend({
    enabled: z.boolean(),
    provider: z.literal('ollama'),
    model: z.string(),
    host: z.string(),
    remote: z.boolean(),
    dimensions: z.number().int().nullable(),
  }),
  settings: z.object({ autoProcess: z.boolean(), embeddingsEnabled: z.boolean(), embeddingModel: z.string(), embeddingBaseUrl: z.string().nullable() }),
});
export type RetrievalProviders = z.infer<typeof RetrievalProvidersResponse>;

export const UpdateRetrievalSettingsRequest = z
  .object({
    autoProcess: z.boolean(),
    embeddingsEnabled: z.boolean(),
    embeddingModel: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][\w.:/-]*$/, 'Invalid model name'),
    embeddingBaseUrl: z.url({ protocol: /^https?$/ }).max(500).nullable(),
  })
  .partial()
  .strict();

export const IndexStatusResponse = z.object({
  documents: z.object({
    pdfAttachments: z.number().int(),
    processed: z.number().int(),
    partial: z.number().int(),
    needsOcr: z.number().int(),
    failed: z.number().int(),
    waiting: z.number().int(),
    queued: z.number().int(),
    running: z.number().int(),
    stale: z.number().int(),
  }),
  keyword: z.object({ passages: z.number().int() }),
  embeddings: z.object({
    activeSpace: z.object({ id: z.string(), provider: z.string(), model: z.string(), dimensions: z.number().int(), version: z.string().nullable() }).nullable(),
    indexedPassages: z.number().int(),
    embeddablePassages: z.number().int(),
    reindex: z
      .object({ status: z.enum(['running', 'completed', 'failed', 'cancelled']), targetModel: z.string(), done: z.number().int(), total: z.number().int(), error: z.string().nullable(), startedAt: z.string(), finishedAt: z.string().nullable() })
      .nullable(),
  }),
  lastIndexedAt: z.string().nullable(),
});
export type IndexStatus = z.infer<typeof IndexStatusResponse>;

export const ReindexRequest = z.object({ rebuild: z.boolean().default(false) }).strict();
