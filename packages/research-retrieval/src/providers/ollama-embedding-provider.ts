import { z } from 'zod';
import { EmbeddingError, validateVectors, type EmbeddingModelInfo, type EmbeddingProvider, type EmbeddingResult } from '../embeddings/embedding-provider';

// Shapes from Ollama's documented REST API (docs/api.md): POST /api/embed, GET /api/tags.
const EmbedResponse = z.object({ model: z.string().optional(), embeddings: z.array(z.array(z.number())) });
const TagsResponse = z.object({ models: z.array(z.object({ name: z.string(), model: z.string().optional(), digest: z.string().optional() })) });

export interface OllamaEmbeddingOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxBatchSize?: number;
  /** Retries for network errors and 5xx answers. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new EmbeddingError('cancelled', 'Cancelled'));
      },
      { once: true },
    );
  });

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || `${a}:latest` === b;

/**
 * Local embeddings through Ollama's `/api/embed` (batched `input` array).
 * Model availability and the model digest (used as its version) come from
 * `/api/tags`. Every response is validated: count, dimensions, finite values.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly local = true;
  readonly maxBatchSize: number;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private info: EmbeddingModelInfo | null = null;

  constructor(private readonly options: OllamaEmbeddingOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.maxBatchSize = options.maxBatchSize ?? 32;
    this.fetchFn = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private async call(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const attempts = (this.options.maxRetries ?? 2) + 1;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new EmbeddingError('cancelled', 'Cancelled');
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      } catch {
        if (signal?.aborted) throw new EmbeddingError('cancelled', 'Cancelled');
        const err = timeout.aborted ? new EmbeddingError('timeout', 'Ollama did not answer in time', true) : new EmbeddingError('unavailable', 'Ollama is not reachable', true);
        if (attempt >= attempts) throw err;
        await sleep(300 * 2 ** (attempt - 1), signal);
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new EmbeddingError('invalid-response', 'Ollama answered with invalid JSON');
        }
      }
      let message = `Ollama answered HTTP ${res.status}`;
      try {
        const e = (JSON.parse(text) as { error?: unknown }).error;
        if (typeof e === 'string') message = e.slice(0, 300);
      } catch {
        // keep the status message
      }
      if (res.status === 404 || /not found|pull/i.test(message)) throw new EmbeddingError('model-not-found', `Model "${this.options.model}" is not available in Ollama (${message}). Pull it with: ollama pull ${this.options.model}`);
      if (res.status >= 500 && attempt < attempts) {
        await sleep(300 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (/does not support embeddings|not an embedding/i.test(message)) throw new EmbeddingError('model-not-found', `Model "${this.options.model}" cannot produce embeddings`);
      throw new EmbeddingError(res.status >= 500 ? 'unavailable' : 'invalid-response', message, res.status >= 500);
    }
  }

  /** Model availability, dimensions (probed with one short input) and digest. */
  async getModelInfo(signal?: AbortSignal): Promise<EmbeddingModelInfo> {
    if (this.info) return this.info;
    const tags = TagsResponse.safeParse(await this.call('/api/tags', { method: 'GET' }, signal));
    if (!tags.success) throw new EmbeddingError('invalid-response', 'Unexpected answer from Ollama /api/tags');
    const entry = tags.data.models.find((m) => sameModel(m.name, this.options.model) || sameModel(m.model ?? '', this.options.model));
    if (!entry) throw new EmbeddingError('model-not-found', `Model "${this.options.model}" is not available in Ollama. Pull it with: ollama pull ${this.options.model}`);
    const probe = await this.raw(['dimension probe'], signal);
    const dimensions = probe[0]!.vector.length;
    this.info = { provider: 'ollama', model: this.options.model, dimensions, ...(entry.digest ? { version: entry.digest } : {}) };
    return this.info;
  }

  private async raw(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    const body = await this.call('/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.options.model, input: texts, truncate: true }) }, signal);
    const parsed = EmbedResponse.safeParse(body);
    if (!parsed.success) throw new EmbeddingError('invalid-response', 'Unexpected answer from Ollama /api/embed');
    const results = parsed.data.embeddings.map((vector) => ({ vector, dimensions: vector.length }));
    validateVectors(results, texts.length, this.info?.dimensions ?? results[0]?.dimensions ?? null);
    return results;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    if (!texts.length) return [];
    if (texts.length > this.maxBatchSize) throw new EmbeddingError('refused', `At most ${this.maxBatchSize} texts per request`);
    if (texts.some((t) => !t.trim())) throw new EmbeddingError('refused', 'Empty texts cannot be embedded');
    const info = await this.getModelInfo(signal);
    const results = await this.raw(texts, signal);
    validateVectors(results, texts.length, info.dimensions);
    return results;
  }
}
