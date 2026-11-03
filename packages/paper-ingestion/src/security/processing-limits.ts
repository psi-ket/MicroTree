/** Bounds on every stage, so a hostile or huge document cannot exhaust the runtime. */
export interface ProcessingLimits {
  /** PDF size accepted for processing. */
  maxPdfBytes: number;
  maxPages: number;
  /** Size of an extractor response read into memory (TEI, PyMuPDF JSON). */
  maxOutputBytes: number;
  /** XML nesting depth and element count. */
  maxXmlDepth: number;
  maxXmlNodes: number;
  /** Structures kept per document; the rest are dropped with a warning. */
  maxBlocks: number;
  maxReferences: number;
  maxElements: number;
  /** Wall-clock limits. */
  grobidTimeoutMs: number;
  pymupdfTimeoutMs: number;
  /** Address-space limit for the PyMuPDF process (POSIX only). */
  pymupdfMemoryMb: number;
}

export const DEFAULT_PROCESSING_LIMITS: ProcessingLimits = {
  maxPdfBytes: 100 * 1024 * 1024,
  maxPages: 500,
  maxOutputBytes: 64 * 1024 * 1024,
  maxXmlDepth: 256,
  maxXmlNodes: 2_000_000,
  maxBlocks: 50_000,
  maxReferences: 5_000,
  maxElements: 5_000,
  grobidTimeoutMs: 180_000,
  pymupdfTimeoutMs: 120_000,
  pymupdfMemoryMb: 1536,
};
