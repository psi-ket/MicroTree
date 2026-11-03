// Personal research library (M3.2): library items over durable scholarly works,
// PDF storage, BibTeX/RIS import and export, collections, project references
// and the optional Zotero integration. Node-only (file storage, worker threads).

export * from './errors/library-errors';

export * from './library/library-types';
export * from './library/library-repository';
export * from './library/library-service';
export * from './library/citation-keys';

export * from './metadata/metadata-merger';
export * from './metadata/pdf-metadata';
export * from './metadata/identifier-extractor';
export * from './metadata/metadata-matcher';
export * from './metadata/metadata-resolver';

export * from './attachments/content-hash';
export * from './attachments/attachment-validator';
export * from './attachments/attachment-storage';
export * from './attachments/attachment-service';
export * from './attachments/open-access-fetcher';

export * from './collections/collection-repository';
export * from './collections/collection-service';

export * from './deduplication/library-deduplicator';

export * from './imports/bibtex-importer';
export * from './imports/ris-importer';
export * from './imports/pdf-importer';
export * from './imports/reference-import';
export * from './imports/import-jobs';

export * from './exports/bibtex-exporter';
export * from './exports/ris-exporter';

export * from './projects/project-library-service';

export * from './integrations/zotero/zotero-mapper';
export * from './integrations/zotero/zotero-client';
export * from './integrations/zotero/zotero-import';
export * from './integrations/zotero/zotero-export';
