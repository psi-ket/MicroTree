import type Database from 'better-sqlite3';
import type { PassageKind, SectionType } from '@research-studio/document-intelligence';
import { EmbeddingError, normalizeVector, type EmbeddingProvider } from '../embeddings/embedding-provider';
import { KeywordIndex, type PassageFilter, type RankedHit } from '../keyword-search/keyword-index';
import { parseQuery, type ParsedQuery } from '../query/query-parser';
import type { Reranker } from '../reranking/reranker';
import type { EmbeddingSpace, SqliteVectorStore } from '../vector-search/vector-store';
import { DEFAULT_FUSION, reciprocalRankFusion, singleList, type FusedHit, type FusionOptions } from './rrf';

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  filter: { extractionIds: readonly string[] | null; kinds?: readonly PassageKind[]; sectionTypes?: readonly SectionType[] };
  limit: number;
  offset: number;
  fusion?: Partial<FusionOptions>;
  /** Candidates taken from each list before fusion. */
  candidates?: number;
}

export interface HybridSearchResult extends FusedHit {
  /** Position in the full result list (1-based). */
  position: number;
}

export interface SearchResponse {
  parsed: ParsedQuery;
  mode: SearchMode;
  results: HybridSearchResult[];
  total: number;
  /** The keyword search found nothing with all words and fell back to any word (reported, not silent). */
  relaxed: boolean;
  semantic: { used: boolean; space: EmbeddingSpace | null; reason: string | null };
  warnings: string[];
}

export interface SemanticBackend {
  space: EmbeddingSpace;
  provider: EmbeddingProvider;
}

const BODY_KINDS: PassageKind[] = ['abstract', 'body', 'caption', 'formula'];

/**
 * Keyword (FTS5/BM25), semantic (exact cosine in the active embedding
 * space) and hybrid (RRF) retrieval over passages of active extractions.
 * Results are passages with their component ranks; no text is generated.
 */
export class HybridSearchEngine {
  readonly keyword: KeywordIndex;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly vectors: SqliteVectorStore,
    private readonly reranker: Reranker | null = null,
  ) {
    this.keyword = new KeywordIndex(sqlite);
  }

  async search(req: SearchRequest, semantic: SemanticBackend | null, signal?: AbortSignal): Promise<SearchResponse> {
    const parsed = parseQuery(req.query);
    const warnings = [...parsed.notes.filter((n) => n.startsWith('Unknown'))];
    const candidates = Math.min(500, Math.max(req.candidates ?? 100, req.offset + req.limit));
    const kinds = req.filter.kinds?.length ? req.filter.kinds : parsed.sections.includes('references') ? (['reference'] as PassageKind[]) : BODY_KINDS;
    const sectionTypes = [...new Set([...(req.filter.sectionTypes ?? []), ...parsed.sections])];
    const filter: PassageFilter = { extractionIds: req.filter.extractionIds, kinds, sectionTypes };
    if (filter.extractionIds && !filter.extractionIds.length) {
      return { parsed, mode: req.mode, results: [], total: 0, relaxed: false, semantic: { used: false, space: semantic?.space ?? null, reason: null }, warnings };
    }

    let keywordHits: RankedHit[] = [];
    let relaxed = false;
    if (req.mode !== 'semantic') {
      keywordHits = this.keyword.search(parsed, filter, candidates);
      if (!keywordHits.length && parsed.clauses.length > 1 && req.mode === 'keyword') {
        keywordHits = this.keyword.search(parsed, filter, candidates, true);
        relaxed = keywordHits.length > 0;
      }
    }

    let semanticHits: RankedHit[] = [];
    let semanticReason: string | null = null;
    const wantsSemantic = req.mode !== 'keyword';
    const text = parsed.semanticText;
    if (wantsSemantic) {
      if (!semantic) semanticReason = 'No embedding index is active; semantic search is not available.';
      else if (!text) semanticReason = 'The query has no words to embed.';
      else {
        try {
          const [q] = await semantic.provider.embed([text], signal);
          const vector = normalizeVector(q!.vector);
          if (vector.length !== semantic.space.dimensions) throw new EmbeddingError('dimension-mismatch', 'The embedding model now returns vectors of a different size; reindex before using semantic search.');
          semanticHits = this.vectors.search(semantic.space.id, vector, filter, candidates);
        } catch (err) {
          if (err instanceof EmbeddingError && err.code === 'cancelled') throw err;
          semanticReason = `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (semanticReason) warnings.push(semanticReason);
    }

    let fused: FusedHit[] =
      req.mode === 'keyword' ? singleList(keywordHits, 'keyword') : req.mode === 'semantic' ? singleList(semanticHits, 'semantic') : reciprocalRankFusion(keywordHits, semanticHits, { ...DEFAULT_FUSION, ...req.fusion });
    if (this.reranker) fused = this.reranker.rerank(parsed, fused);
    const all = fused.map((h, i) => ({ ...h, position: i + 1 }));
    return {
      parsed,
      mode: req.mode,
      results: all.slice(req.offset, req.offset + req.limit),
      total: all.length,
      relaxed,
      semantic: { used: wantsSemantic && !semanticReason, space: semantic?.space ?? null, reason: semanticReason },
      warnings,
    };
  }
}
