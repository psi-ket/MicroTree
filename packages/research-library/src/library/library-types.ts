import type {
  BibField,
  EditedAuthor,
  LiteratureProviderId,
  ProviderSearchOutcome,
  PublicationType,
  ScholarlyWork,
  WorkOrigin,
} from '@research-studio/shared-types';

/**
 * A reference as read from an import (BibTeX, RIS, Zotero, PDF metadata or a
 * form), before it becomes a work. Only values present in the source are set.
 */
export interface ImportedReference {
  origin: Exclude<WorkOrigin, 'providers'>;
  title: string | null;
  authors: EditedAuthor[];
  publicationYear: number | null;
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  publicationDate: string | null;
  venue: string | null;
  publisher: string | null;
  publicationType: PublicationType | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  issn: string[];
  keywords: string[];
  /** Citation key given by the source (BibTeX key, Zotero citationKey, RIS ID). */
  citationKey: string | null;
  bibtexType: string | null;
  /** Fields the library does not map, kept for export. */
  extraFields: BibField[];
  /** The source record as read, kept as provenance. */
  localSource: Record<string, unknown>;
  notes: string | null;
}

export function emptyReference(origin: ImportedReference['origin']): ImportedReference {
  return {
    origin,
    title: null,
    authors: [],
    publicationYear: null,
    publicationDate: null,
    venue: null,
    publisher: null,
    publicationType: null,
    volume: null,
    issue: null,
    pages: null,
    abstract: null,
    doi: null,
    arxivId: null,
    url: null,
    issn: [],
    keywords: [],
    citationKey: null,
    bibtexType: null,
    extraFields: [],
    localSource: {},
    notes: null,
  };
}

/** An import problem that did not stop the import. */
export interface ImportWarning {
  /** Line number (BibTeX, RIS) or record number. */
  line: number | null;
  message: string;
}

export interface ParsedImport {
  references: ImportedReference[];
  warnings: ImportWarning[];
}

/**
 * The M3.1 literature engine as the library sees it. The runtime implements
 * this with its `LiteratureService`; the library never calls a provider itself.
 */
export interface ScholarlyLookup {
  resolveDoi(doi: string, signal?: AbortSignal): Promise<{ works: ScholarlyWork[]; providerStatus: ProviderSearchOutcome[] }>;
  resolveArxiv(arxivId: string, signal?: AbortSignal): Promise<{ works: ScholarlyWork[]; providerStatus: ProviderSearchOutcome[] }>;
  /** Text search; `limit` results at most. */
  search(
    query: string,
    options: { mode: 'title' | 'all'; limit: number; author?: string },
    signal?: AbortSignal,
  ): Promise<{ works: ScholarlyWork[]; providerStatus: ProviderSearchOutcome[] }>;
  /** A work by canonical ID, freshly merged from the providers. */
  work(id: string, signal?: AbortSignal): Promise<ScholarlyWork>;
}

/** Providers that answered with a usable result (for messages). */
export function answered(status: ProviderSearchOutcome[]): LiteratureProviderId[] {
  return status.filter((s) => s.status === 'success' || s.status === 'partial').map((s) => s.provider);
}
