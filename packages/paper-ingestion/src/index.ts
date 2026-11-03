// Scientific PDF ingestion (M3.3): GROBID (structure, TEI) and PyMuPDF
// (geometry, fallback) adapters, secure TEI parsing, normalisation into the
// document-intelligence model, persistence and the persistent job pipeline.
// Node only. No UI logic and no retrieval logic (segmentation and indexing
// are injected).

export * from './errors/extraction-errors';
export * from './security/xml-security';
export * from './security/pdf-validation';
export * from './security/processing-limits';
export * from './extractors/grobid/grobid-configuration';
export * from './extractors/grobid/grobid-health';
export * from './extractors/grobid/grobid-client';
export * from './extractors/grobid/tei-parser';
export * from './extractors/grobid/tei-normalizer';
export * from './extractors/pymupdf/pymupdf-client';
export * from './extractors/pymupdf/pymupdf-normalizer';
export * from './normalization/coordinate-normalizer';
export * from './normalization/structure-normalizer';
export * from './normalization/document-normalizer';
export * from './storage/document-store';
export * from './pipeline/concurrency';
export * from './pipeline/ingestion-status';
export * from './pipeline/ingestion-service';
export * from './pipeline/ingestion-worker';
export * from './pipeline/ingestion-queue';
