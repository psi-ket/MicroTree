import type Database from 'better-sqlite3';
import { embeddingInput, embeddingInputHash } from '../chunking/chunker';
import { EmbeddingError, normalizeVector, type EmbeddingProvider } from '../embeddings/embedding-provider';
import type { EmbeddingSpace, VectorStore } from '../vector-search/vector-store';

/** Passage kinds that get vectors. References are found by keyword and identifier only. */
export const EMBEDDED_KINDS = ['abstract', 'body', 'caption', 'formula'] as const;

export interface EmbedProgress {
  done: number;
  total: number;
  cached: number;
}

/**
 * Embeds the passages of extractions into one space: cached vectors (same
 * input text in the same space) are reused, the rest are sent in batches.
 * Every vector is checked against the space's dimensions before it is
 * stored. Cancellation stops between batches; what was stored stays valid.
 */
export class EmbeddingIndexer {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly vectors: VectorStore,
  ) {}

  /** Passages of an extraction that have no vector in this space yet. */
  private pending(spaceId: string, extractionId: string) {
    return this.sqlite
      .prepare(
        `SELECT p.id, p.text, p.section_path FROM document_passages p
         WHERE p.extraction_id = ? AND p.kind IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM passage_embeddings pe WHERE pe.space_id = ? AND pe.passage_id = p.id)
         ORDER BY p.passage_order`,
      )
      .all(extractionId, JSON.stringify(EMBEDDED_KINDS), spaceId) as { id: string; text: string; section_path: string }[];
  }

  countPending(spaceId: string, extractionIds: readonly string[]): number {
    let n = 0;
    for (const id of extractionIds) n += this.pending(spaceId, id).length;
    return n;
  }

  async embedExtractions(
    space: EmbeddingSpace,
    provider: EmbeddingProvider,
    extractionIds: readonly string[],
    options: { signal?: AbortSignal; batchSize?: number; onProgress?: (p: EmbedProgress) => void } = {},
  ): Promise<EmbedProgress> {
    const work = extractionIds.flatMap((x) => this.pending(space.id, x).map((p) => ({ ...p, extractionId: x })));
    const progress: EmbedProgress = { done: 0, total: work.length, cached: 0 };
    options.onProgress?.(progress);
    if (!work.length) return progress;
    const inputs = work.map((w) => {
      const input = embeddingInput({ sectionPath: w.section_path, text: w.text });
      return { ...w, input, hash: embeddingInputHash(input) };
    });
    const cache = this.vectors.cached(
      space.id,
      inputs.map((i) => i.hash),
    );
    const cachedItems = inputs.filter((i) => cache.has(i.hash));
    if (cachedItems.length) {
      this.vectors.link(space.id, cachedItems.map((i) => ({ passageId: i.id, extractionId: i.extractionId, textHash: i.hash })));
      progress.done += cachedItems.length;
      progress.cached = cachedItems.length;
      options.onProgress?.(progress);
    }
    // One request per unique text.
    const todo = new Map<string, typeof inputs>();
    for (const i of inputs) if (!cache.has(i.hash)) todo.set(i.hash, [...(todo.get(i.hash) ?? []), i]);
    const unique = [...todo.values()];
    const batch = Math.max(1, Math.min(options.batchSize ?? provider.maxBatchSize, provider.maxBatchSize));
    for (let i = 0; i < unique.length; i += batch) {
      if (options.signal?.aborted) throw new EmbeddingError('cancelled', 'Cancelled');
      const slice = unique.slice(i, i + batch);
      const results = await provider.embed(
        slice.map((group) => group[0]!.input),
        options.signal,
      );
      if (results.length !== slice.length) throw new EmbeddingError('invalid-response', 'The provider returned a different number of embeddings');
      const vectors = results.map((r) => normalizeVector(r.vector));
      for (const v of vectors) if (v.length !== space.dimensions) throw new EmbeddingError('dimension-mismatch', `Embedding has ${v.length} dimensions; this index uses ${space.dimensions}. Reindex with the new model instead.`);
      this.vectors.putVectors(
        space.id,
        slice.map((group, k) => ({ textHash: group[0]!.hash, vector: vectors[k]! })),
      );
      const links = slice.flatMap((group) => group.map((g) => ({ passageId: g.id, extractionId: g.extractionId, textHash: g.hash })));
      this.vectors.link(space.id, links);
      progress.done += links.length;
      options.onProgress?.(progress);
    }
    return progress;
  }
}
