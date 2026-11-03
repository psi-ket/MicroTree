export * from './errors/provider-errors';
export * from './types/provider';
export * from './normalization/identifier-normalizer';
export * from './normalization/date-normalizer';
export { normalizeAuthor, familyKey, nameTokens } from './normalization/author-normalizer';
export {
  cleanText,
  stripMarkup,
  titleKey,
  safeUrl,
  emptyBibliographic,
  emptyDates,
  emptyIdentifiers,
  emptyOpenAccess,
  emptyUrls,
} from './normalization/work-normalizer';
export { ProviderHttp, RateGate, type HttpObservation } from './providers/http';
export { DEFAULT_USER_AGENT, passesFilters, type ProviderConfig } from './providers/shared';
export { OpenAlexProvider, OPENALEX_BASE_URL } from './providers/openalex/client';
export { SemanticScholarProvider, SEMANTIC_SCHOLAR_BASE_URL } from './providers/semantic-scholar/client';
export { ArxivProvider, ARXIV_BASE_URL, buildArxivQuery } from './providers/arxiv/client';
export { CrossrefProvider, CROSSREF_BASE_URL } from './providers/crossref/client';
export { deduplicate } from './deduplication/deduplicate';
export { diceSimilarity, titlesMatch, sameWorkByMetadata } from './deduplication/title-matching';
export { mergeRecords } from './metadata/metadata-merger';
export { canonicalWorkId, parseWorkId, workKeys, PRECEDENCE } from './metadata/work-metadata';
export { interpretQuery, queryIntent } from './search/query-parser';
export { rankWorks, scoreWork } from './search/ranking';
export { CursorStore, LiteratureRequestError } from './search/pagination';
export {
  LiteratureSearchService,
  LiteratureUnavailableError,
  LiteratureCancelledError,
  type LiteratureCache,
  type SearchServiceOptions,
  type RelatedWorks,
} from './search/search-service';
export * from './format/index';
