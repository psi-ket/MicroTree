import type { DocumentCoordinate, PageGeometry } from '../coordinates/coordinates';

/**
 * The extractor-independent model of a scholarly document. GROBID TEI and
 * PyMuPDF output are both normalised into this shape; nothing here refers to
 * TEI elements or PyMuPDF dictionaries. Every structure keeps its pages and,
 * when the extractor reported them, its boxes. A structure the extractor did
 * not find is absent (or `null`), never filled in.
 */

export const EXTRACTORS = ['grobid', 'pymupdf'] as const;
export type ExtractorId = (typeof EXTRACTORS)[number];

export const BLOCK_TYPES = [
  'title',
  'abstract',
  'heading',
  'paragraph',
  'list',
  'display_formula',
  'inline_formula',
  'figure_caption',
  'table_caption',
  'footnote',
  'acknowledgement',
  'reference',
  'other',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const SECTION_TYPES = [
  'abstract',
  'introduction',
  'background',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'appendix',
  'acknowledgement',
  'references',
  'body',
  'other',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const ELEMENT_TYPES = ['equation', 'figure', 'table'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const PASSAGE_KINDS = ['abstract', 'body', 'caption', 'formula', 'reference'] as const;
export type PassageKind = (typeof PASSAGE_KINDS)[number];

/** States of one extraction run (a row in `document_extractions`). */
export const EXTRACTION_STATUSES = ['completed', 'partial', 'needs_ocr', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** States of a processing job, in pipeline order, then the terminal states. */
export const DOCUMENT_JOB_STATUSES = [
  'queued',
  'validating',
  'extracting',
  'normalizing',
  'segmenting',
  'indexing_keywords',
  'generating_embeddings',
  'indexing_vectors',
  'completed',
  'partial',
  'needs_ocr',
  'failed',
  'cancelled',
] as const;
export type DocumentJobStatus = (typeof DOCUMENT_JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: readonly DocumentJobStatus[] = ['completed', 'partial', 'needs_ocr', 'failed', 'cancelled'];
export function isTerminalJobStatus(s: DocumentJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(s);
}

export const DOCUMENT_JOB_KINDS = ['process', 'reprocess', 'reindex'] as const;
export type DocumentJobKind = (typeof DOCUMENT_JOB_KINDS)[number];

/** Machine-readable failure classes; `retryable` ones may succeed on a later attempt. */
export const EXTRACTION_ERROR_CODES = [
  'unavailable',
  'overloaded',
  'timeout',
  'empty',
  'unsupported',
  'malformed',
  'too-large',
  'too-many-pages',
  'extractor-error',
  'invalid-output',
  'cancelled',
  'missing-file',
  'embedding-failed',
  'internal',
] as const;
export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

export interface JobError {
  code: ExtractionErrorCode;
  message: string;
  retryable: boolean;
  /** Which extractor or stage reported it. */
  source: string | null;
}

export const REFERENCE_RESOLUTION = ['unresolved', 'matched-doi', 'matched-arxiv'] as const;
export type ReferenceResolution = (typeof REFERENCE_RESOLUTION)[number];

/** Inline pieces of a block: plain text, a citation/figure/table/formula marker, or an inline formula. */
export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; text: string; refType: 'bibr' | 'figure' | 'table' | 'formula' | 'foot' | 'other'; target: string | null }
  | { kind: 'formula'; text: string };

export interface ExtractedAuthor {
  name: string;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  affiliations: string[];
}

export interface ExtractedMetadata {
  title: string | null;
  authors: ExtractedAuthor[];
  abstract: string | null;
  publicationDate: string | null;
  doi: string | null;
  arxivId: string | null;
  keywords: string[];
  venue: string | null;
  language: string | null;
}

export interface NormalizedSection {
  /** Extraction-local key (`s1`, `s1.2`, …); becomes a database ID later. */
  key: string;
  parentKey: string | null;
  heading: string;
  /** Heading number as printed ("2.1"), when there was one. */
  number: string | null;
  level: number;
  order: number;
  /** Headings from the top level down, joined with " › ". */
  path: string;
  type: SectionType;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
}

export interface NormalizedSentence {
  order: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
}

export interface NormalizedBlock {
  key: string;
  sectionKey: string | null;
  type: BlockType;
  order: number;
  spans: InlineSpan[];
  plainText: string;
  /** The extractor's own identifier (TEI `xml:id`), for debugging and reprocessing. */
  sourceId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
  /** Sentences as segmented by the extractor (GROBID `<s>`) or by `segmentSentences`. */
  sentences: NormalizedSentence[];
  sentenceSource: 'extractor' | 'segmenter' | 'none';
  /** Key of the figure/table/equation element this block describes. */
  elementKey: string | null;
}

export interface NormalizedElement {
  key: string;
  type: ElementType;
  sectionKey: string | null;
  label: string | null;
  caption: string | null;
  /**
   * Text of the element as extracted (an equation's characters, a table's
   * cells joined by tabs). It is **not** a faithful rendering of the visual
   * form, in particular not of mathematics.
   */
  content: string | null;
  sourceId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
}

export interface ReferenceMetadata {
  title: string | null;
  authors: string[];
  venue: string | null;
  year: number | null;
  volume: string | null;
  pages: string | null;
  publisher: string | null;
}

export interface NormalizedReference {
  key: string;
  order: number;
  /** The citation as printed, when the extractor kept it. */
  raw: string | null;
  parsed: ReferenceMetadata;
  doi: string | null;
  arxivId: string | null;
  sourceId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
}

export interface ExtractionQuality {
  /** Share of PyMuPDF's characters found again in the normalised text (null when not measured). */
  textCoverage: number | null;
  hasTitle: boolean;
  hasAbstract: boolean;
  sectionCount: number;
  paragraphCount: number;
  referenceCount: number;
  /** Share of blocks with at least one box. */
  coordinateCoverage: number;
  /** Pages whose text layer is empty. */
  emptyPages: number[];
  /** `structured` (GROBID), `layout` (geometry-only fallback). */
  structure: 'structured' | 'layout';
}

export interface NormalizedDocument {
  extractor: ExtractorId;
  extractorVersion: string | null;
  metadata: ExtractedMetadata;
  pages: PageGeometry[];
  sections: NormalizedSection[];
  blocks: NormalizedBlock[];
  elements: NormalizedElement[];
  references: NormalizedReference[];
  quality: ExtractionQuality;
  /** Problems worth showing (missing structures, mismatched page sizes, truncation). */
  warnings: string[];
}

/** A retrieval passage produced by segmentation, before it is stored. */
export interface PassageDraft {
  order: number;
  kind: PassageKind;
  sectionKey: string | null;
  sectionPath: string;
  sectionType: SectionType;
  /** Blocks whose text the passage holds, in order; the first is the parent block. */
  blockKeys: string[];
  text: string;
  normalizedText: string;
  textHash: string;
  stableKey: string;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
  tokenCount: number;
  language: string | null;
  /** Sentences contained in this passage, by block and order (kept for M5). */
  sentences: { blockKey: string; order: number }[];
}

export function emptyMetadata(): ExtractedMetadata {
  return { title: null, authors: [], abstract: null, publicationDate: null, doi: null, arxivId: null, keywords: [], venue: null, language: null };
}

export function emptyReferenceMetadata(): ReferenceMetadata {
  return { title: null, authors: [], venue: null, year: null, volume: null, pages: null, publisher: null };
}

/** Plain text of inline spans (markers and formulas included as printed). */
export function spansText(spans: readonly InlineSpan[]): string {
  return spans
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
