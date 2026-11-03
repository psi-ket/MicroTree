/**
 * Embedding providers, independent of the chat-model stack in `ai-core`.
 * A provider that sends text off this computer (`local: false`) is only used
 * after the user's explicit consent; none is built in for M3.3.
 */
export interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
  /** Provider's version or digest of the model weights, when it reports one. */
  version?: string;
}

export interface EmbeddingResult {
  vector: number[];
  dimensions: number;
}

export interface EmbeddingProvider {
  id: string;
  /** True when texts never leave this computer. */
  readonly local: boolean;
  /** Most texts per request. */
  readonly maxBatchSize: number;
  getModelInfo(signal?: AbortSignal): Promise<EmbeddingModelInfo>;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]>;
}

export type EmbeddingErrorCode = 'unavailable' | 'model-not-found' | 'invalid-response' | 'dimension-mismatch' | 'timeout' | 'cancelled' | 'refused';

export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Check vectors from a provider: count, dimensions, finite numbers, non-zero length. */
export function validateVectors(results: EmbeddingResult[], expectedCount: number, dimensions: number | null): void {
  if (results.length !== expectedCount) throw new EmbeddingError('invalid-response', `Expected ${expectedCount} embeddings, received ${results.length}`);
  for (const r of results) {
    if (dimensions !== null && r.vector.length !== dimensions) {
      throw new EmbeddingError('dimension-mismatch', `Embedding has ${r.vector.length} dimensions; this index uses ${dimensions}`);
    }
    if (!r.vector.length) throw new EmbeddingError('invalid-response', 'Empty embedding');
    let norm = 0;
    for (const v of r.vector) {
      if (!Number.isFinite(v)) throw new EmbeddingError('invalid-response', 'Embedding contains a non-finite value');
      norm += v * v;
    }
    if (norm === 0) throw new EmbeddingError('invalid-response', 'Embedding has zero length');
  }
}

/** Unit-length float32 copy (so a dot product is the cosine similarity). */
export function normalizeVector(v: readonly number[]): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  const n = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Stable namespace for an embedding space. */
export function spaceKey(info: EmbeddingModelInfo): string {
  return `${info.provider}|${info.model}|${info.dimensions}|${info.version ?? ''}`;
}
