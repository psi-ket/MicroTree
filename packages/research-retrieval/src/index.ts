// Research retrieval (M3.3): structure-aware passage segmentation, embedding
// providers (Ollama), the embedding cache, FTS5 keyword search, a SQLite
// vector store with exact cosine search, Reciprocal Rank Fusion, query
// parsing and evaluation metrics. Independent of extractors, of the library
// and of literature providers: callers pass extraction IDs to search.

export * from './chunking/chunker';
export * from './embeddings/embedding-provider';
export * from './providers/ollama-embedding-provider';
export * from './query/query-parser';
export * from './keyword-search/keyword-index';
export * from './vector-search/vector-store';
export * from './indexing/embedding-indexer';
export * from './hybrid-search/rrf';
export * from './hybrid-search/search-engine';
export * from './reranking/reranker';
export * from './deletion/index-maintenance';
export * from './metrics/retrieval-metrics';
