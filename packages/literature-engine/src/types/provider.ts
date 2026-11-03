import type {
  LiteratureProviderId,
  LiteratureSearchFilters,
  LiteratureSearchMode,
  LiteratureSort,
  ScholarlyAuthorProfile,
  ScholarlySourceRecord,
} from '@research-studio/shared-types';
import type { ArxivIdentifier } from '../normalization/identifier-normalizer';

/** How a provider handles one search filter. */
export type FilterSupport =
  /** Sent to the provider. */
  | 'native'
  /** Applied by the engine to the mapped records. */
  | 'local'
  /** Cannot be applied or checked: the provider is skipped when the filter is set. */
  | 'unsupported';

export type FilterName = keyof LiteratureSearchFilters;

export interface ProviderCapabilities {
  modes: Record<LiteratureSearchMode, FilterSupport>;
  filters: Record<FilterName, FilterSupport>;
  /** Sorts the provider applies itself; others are applied by the engine to each page only. */
  sorts: LiteratureSort[];
  lookups: { doi: boolean; arxiv: boolean; openalex: boolean; semanticScholar: boolean };
  references: boolean;
  citations: boolean;
  authors: boolean;
  /** Most results the provider will page through for one query. */
  maxResults: number;
  maxPageSize: number;
}

export interface ProviderContext {
  signal: AbortSignal;
}

export interface ProviderSearchQuery {
  text: string;
  mode: LiteratureSearchMode;
  filters: LiteratureSearchFilters;
  sort: LiteratureSort;
  pageSize: number;
  /** Provider-specific position from the previous page (JSON-serialisable); null for the first page. */
  position: unknown;
}

export interface ProviderSearchPage {
  records: ScholarlySourceRecord[];
  /** Provider's reported total for the query. */
  total: number | null;
  /** Position of the next page, or null when there are no more results. */
  next: unknown;
  /** Human-readable notes: filters applied approximately, sorts not supported. */
  notes: string[];
  /** Items in the response that could not be read or lacked a title (left out). */
  skipped?: number;
}

export interface RelatedWorksPage {
  records: ScholarlySourceRecord[];
  total: number | null;
}

/**
 * One scholarly data source. Implementations hold all provider-specific
 * knowledge (URLs, parameters, response formats); the search service only
 * sees normalised source records.
 */
export interface LiteratureProvider {
  readonly id: LiteratureProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Why this provider cannot serve the query at all (beyond `capabilities`), or null. */
  skipReason?(query: ProviderSearchQuery): string | null;
  search(query: ProviderSearchQuery, ctx: ProviderContext): Promise<ProviderSearchPage>;
  /** Look up a normalised DOI; null when the provider does not know it. */
  getByDoi(doi: string, ctx: ProviderContext): Promise<ScholarlySourceRecord | null>;
  getByArxivId?(id: ArxivIdentifier, ctx: ProviderContext): Promise<ScholarlySourceRecord | null>;
  /** Look up the provider's own work ID. */
  getById?(providerId: string, ctx: ProviderContext): Promise<ScholarlySourceRecord | null>;
  references?(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext): Promise<RelatedWorksPage>;
  citations?(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext): Promise<RelatedWorksPage>;
  getAuthor?(authorId: string, ctx: ProviderContext): Promise<Omit<ScholarlyAuthorProfile, 'works'> & { works: ScholarlySourceRecord[] } | null>;
  /** One inexpensive request that proves the provider is reachable. */
  check(ctx: ProviderContext): Promise<void>;
}
