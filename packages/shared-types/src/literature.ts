/**
 * Scholarly literature (M3.1). Shared by the literature engine, the API
 * contracts and the web app. Every value comes from a provider: a field the
 * providers did not supply is `null`, never guessed.
 */

export const LITERATURE_PROVIDERS = ['openalex', 'semantic-scholar', 'arxiv', 'crossref'] as const;
export type LiteratureProviderId = (typeof LITERATURE_PROVIDERS)[number];

export const LITERATURE_PROVIDER_NAMES: Readonly<Record<LiteratureProviderId, string>> = {
  openalex: 'OpenAlex',
  'semantic-scholar': 'Semantic Scholar',
  arxiv: 'arXiv',
  crossref: 'Crossref',
};

/**
 * Normalised publication types. `preprint` means the record describes a
 * preprint (e.g. arXiv, `posted-content`); nothing here says whether a work was
 * peer reviewed.
 */
export const PUBLICATION_TYPES = [
  'journal-article',
  'preprint',
  'review',
  'conference-paper',
  'book',
  'book-chapter',
  'dissertation',
  'report',
  'dataset',
  'editorial',
  'letter',
  'erratum',
  'other',
] as const;
export type PublicationType = (typeof PUBLICATION_TYPES)[number];

export interface ScholarlyAuthor {
  /** Name as displayed by the provider. */
  name: string;
  givenName: string | null;
  familyName: string | null;
  /** Bare ORCID iD (`0000-0002-1825-0097`). */
  orcid: string | null;
  affiliations: string[];
  /** Provider author IDs, e.g. `{ openalex: 'A5023888391' }`. */
  providerIds: Partial<Record<LiteratureProviderId, string>>;
}

export interface WorkIdentifiers {
  /** Lower-case DOI without prefix or URL (`10.1103/physreva.52.r2493`). */
  doi: string | null;
  /** arXiv identifier without version (`2106.15928`, `quant-ph/9605011`). */
  arxivId: string | null;
  /** OpenAlex work ID (`W1999706070`). */
  openAlexId: string | null;
  /** Semantic Scholar paper ID (40-character hash). */
  semanticScholarId: string | null;
  pmid: string | null;
}

export interface WorkDates {
  /** The provider's main publication date (YYYY, YYYY-MM or YYYY-MM-DD). */
  published: string | null;
  publishedOnline: string | null;
  publishedPrint: string | null;
  /** arXiv: first version submitted. */
  submitted: string | null;
  /** arXiv: latest version; other providers: record update, where reported. */
  updated: string | null;
}

export interface WorkUrls {
  /** Publisher or record landing page. */
  landingPage: string | null;
  pdf: string | null;
  /** Abstract page (arXiv). */
  abstract: string | null;
}

export interface WorkOpenAccess {
  isOpenAccess: boolean | null;
  /** OpenAlex `oa_status` (gold, green, hybrid, bronze, diamond, closed). */
  status: string | null;
  license: string | null;
  pdfUrl: string | null;
}

export interface WorkBibliographic {
  volume: string | null;
  issue: string | null;
  pages: string | null;
  issn: string[];
}

/** One provider's citation counts, observed at a point in time. */
export interface CitationObservation {
  provider: LiteratureProviderId;
  citedByCount: number | null;
  referenceCount: number | null;
  retrievedAt: string;
}

/** One provider's view of one work, normalised but not merged. */
export interface ScholarlySourceRecord {
  provider: LiteratureProviderId;
  /** The provider's own ID for this record (OpenAlex W-ID, S2 paper ID, arXiv ID with version, DOI). */
  providerId: string;
  /** Human-readable page of this record at the provider. */
  recordUrl: string | null;
  /** API request that returned it, with credentials and contact details removed. */
  requestUrl: string | null;
  retrievedAt: string;

  title: string;
  abstract: string | null;
  authors: ScholarlyAuthor[];
  dates: WorkDates;
  publicationYear: number | null;
  venue: string | null;
  publisher: string | null;
  publicationType: PublicationType | null;
  /** The provider's own type label(s), unchanged. */
  rawType: string | null;
  identifiers: WorkIdentifiers;
  urls: WorkUrls;
  openAccess: WorkOpenAccess;
  citedByCount: number | null;
  referenceCount: number | null;
  bibliographic: WorkBibliographic;
  /** Subject labels with their scheme, e.g. `{ scheme: 'arxiv', value: 'quant-ph' }`. */
  categories: { scheme: string; value: string }[];
  /** arXiv version of this record (`v5`), when known. */
  version: string | null;
  /** Provider-specific values that have no canonical field (small, JSON). */
  extra: Record<string, unknown>;
}

/** Two or more providers disagree on a field; `chosen` says whose value the work shows. */
export interface MetadataConflict {
  field: string;
  values: { provider: LiteratureProviderId; value: string }[];
  chosen: LiteratureProviderId;
}

export interface ScholarlyWork {
  /** Canonical ID: `doi:…`, `arxiv:…`, `openalex:W…` or `semantic-scholar:…`. */
  id: string;

  title: string;
  abstract: string | null;
  /** Provider whose abstract is shown. */
  abstractSource: LiteratureProviderId | null;
  authors: ScholarlyAuthor[];

  publicationDate: string | null;
  publicationYear: number | null;
  dates: WorkDates;

  venue: string | null;
  publisher: string | null;
  publicationType: PublicationType | null;
  bibliographic: WorkBibliographic;
  categories: { scheme: string; value: string }[];

  identifiers: WorkIdentifiers;
  urls: WorkUrls;
  openAccess: WorkOpenAccess;

  citation: {
    /** Count shown for the work; always attributed to `citedBySource`. */
    citedByCount: number | null;
    citedBySource: LiteratureProviderId | null;
    referenceCount: number | null;
    observations: CitationObservation[];
  };

  conflicts: MetadataConflict[];
  sourceRecords: ScholarlySourceRecord[];

  /** Earliest and latest retrieval among the source records. */
  createdAt: string;
  updatedAt: string;
}

export const LITERATURE_SEARCH_MODES = ['all', 'title', 'author', 'title-abstract'] as const;
export type LiteratureSearchMode = (typeof LITERATURE_SEARCH_MODES)[number];

export const LITERATURE_SORTS = ['relevance', 'newest', 'oldest', 'citations'] as const;
export type LiteratureSort = (typeof LITERATURE_SORTS)[number];

export interface LiteratureSearchFilters {
  authors?: string[];
  yearFrom?: number;
  yearTo?: number;
  publicationTypes?: PublicationType[];
  venues?: string[];
  openAccessOnly?: boolean;
  /** arXiv categories (`quant-ph`, `math-ph`, `cs.LG`, or an archive such as `physics`, `math`, `cs`). */
  categories?: string[];
}

export interface LiteratureSearchRequest {
  query: string;
  mode?: LiteratureSearchMode;
  providers?: LiteratureProviderId[];
  filters?: LiteratureSearchFilters;
  sort?: LiteratureSort;
  limit?: number;
  cursor?: string;
}

export const PROVIDER_SEARCH_STATUSES = ['success', 'partial', 'failed', 'rate_limited', 'skipped'] as const;
export type ProviderSearchStatus = (typeof PROVIDER_SEARCH_STATUSES)[number];

export interface ProviderSearchOutcome {
  provider: LiteratureProviderId;
  status: ProviderSearchStatus;
  resultCount: number;
  /** Provider's reported total for the query, where it reports one. */
  total: number | null;
  error?: string;
  /** How the provider handled the query where it differs from the request (approximate filters, unsupported sort). */
  notes?: string[];
  durationMs: number;
  fromCache: boolean;
}

/** How the runtime understood the query. */
export interface InterpretedQuery {
  kind: 'text' | 'doi' | 'arxiv' | 'openalex' | 'semantic-scholar';
  text: string;
  identifier: string | null;
}

export interface RankedWork {
  work: ScholarlyWork;
  /** Deterministic relevance score (higher is better); null for exact identifier matches. */
  score: number | null;
  /** Why the work ranked where it did (`exact-identifier`, `title-phrase`, …). */
  signals: string[];
}

export interface LiteratureSearchResult {
  results: RankedWork[];
  /** Largest total reported by a provider: an estimate, providers count differently. */
  total: number | null;
  pagination: { hasMore: boolean; nextCursor: string | null };
  providerStatus: ProviderSearchOutcome[];
  query: InterpretedQuery;
}

export interface ScholarlyAuthorProfile {
  id: string;
  provider: LiteratureProviderId;
  name: string;
  orcid: string | null;
  affiliations: string[];
  worksCount: number | null;
  /** Citation count as reported by `provider`. */
  citedByCount: number | null;
  hIndex: number | null;
  recordUrl: string | null;
  retrievedAt: string;
  works: ScholarlyWork[];
}

export const LITERATURE_CONNECTION_STATES = ['unknown', 'ok', 'rate_limited', 'error', 'disabled'] as const;
export type LiteratureConnectionState = (typeof LITERATURE_CONNECTION_STATES)[number];

export interface LiteratureProviderStatus {
  id: LiteratureProviderId;
  name: string;
  enabled: boolean;
  /** Plain-language summary of what the provider needs. */
  authentication: string;
  /** Whether the provider accepts an optional key. */
  acceptsApiKey: boolean;
  /** `stored` (secret store), `environment`, or null. The key itself is never returned. */
  apiKeySource: 'stored' | 'environment' | null;
  connection: LiteratureConnectionState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** Documented limits that apply with the current configuration. */
  limits: string;
  /** Latest rate-limit information reported by the provider, if any. */
  rateLimit: Record<string, string> | null;
  homepage: string;
  termsUrl: string;
}

export interface LiteratureSearchHistoryEntry {
  id: number;
  query: string;
  request: LiteratureSearchRequest;
  resultCount: number;
  providers: { provider: LiteratureProviderId; status: ProviderSearchStatus; resultCount: number }[];
  createdAt: string;
}

export interface LiteraturePreferences {
  providers: LiteratureProviderId[];
  sort: LiteratureSort;
  pageSize: number;
  saveHistory: boolean;
}

export const DEFAULT_LITERATURE_PREFERENCES: LiteraturePreferences = {
  providers: [...LITERATURE_PROVIDERS],
  sort: 'relevance',
  pageSize: 20,
  saveHistory: true,
};
