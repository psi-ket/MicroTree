import { z } from 'zod';
import {
  PROVIDER_KINDS,
  ProviderError,
  providerErrorFromStatus,
  textOf,
  validateRequestContent,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type StructuredOutputSpec,
  type StructuredResult,
} from '@research-studio/ai-core';
import type { ModelInfo, TokenUsage } from '@research-studio/shared-types';
import { parseJson } from './anthropic';
import { toProviderError, trimSlash, type ProviderConnection } from './util';

// Shapes from Ollama's documented REST API (docs/api.md): /api/tags and /api/chat.
const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string(), model: z.string().optional() })),
});

const ChatChunk = z.object({
  message: z.object({ content: z.string().optional() }).optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  error: z.string().optional(),
});
type ChatChunk = z.infer<typeof ChatChunk>;

function stopReason(reason: string | undefined): StopReason {
  if (reason === 'stop') return 'end';
  if (reason === 'length') return 'max-tokens';
  return 'other';
}

function usageOf(c: ChatChunk): TokenUsage {
  return { inputTokens: c.prompt_eval_count ?? null, outputTokens: c.eval_count ?? null, cachedInputTokens: null, costUsd: null };
}

/** A local Ollama server, through its documented HTTP API (newline-delimited JSON streaming). */
export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  readonly capabilities = PROVIDER_KINDS.ollama.capabilities;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly connection: ProviderConnection) {
    this.base = trimSlash(connection.baseUrl ?? PROVIDER_KINDS.ollama.defaultBaseUrl!);
    this.fetchFn = connection.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(this.connection.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(this.connection.apiKey ? { authorization: `Bearer ${this.connection.apiKey}` } : {}),
        },
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) throw new ProviderError('timeout', 'Ollama did not respond in time.');
      throw toProviderError(err, signal, this.connection.apiKey);
    }
    if (!response.ok) {
      let message = `Ollama responded with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
      } catch {
        /* not JSON */
      }
      throw providerErrorFromStatus(response.status, message);
    }
    return response;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request('/api/tags', { method: 'GET' }, signal);
    const parsed = TagsResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('bad-response', 'Unexpected response from Ollama /api/tags.');
    return parsed.data.models.map((m) => ({ id: m.model ?? m.name, displayName: m.name, contextTokens: null }));
  }

  private body(request: ModelRequest, extra: Record<string, unknown>) {
    validateRequestContent(request, this.capabilities);
    return JSON.stringify({
      model: request.model,
      messages: [{ role: 'system', content: request.system }, ...request.messages.map((m) => ({ role: m.role, content: textOf(m.content) }))],
      options: { num_predict: request.maxOutputTokens },
      ...extra,
    });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { signal } = request;
    const response = await this.request('/api/chat', { method: 'POST', body: this.body(request, { stream: true }) }, signal);
    if (!response.body) throw new ProviderError('bad-response', 'Ollama returned no stream.');
    const decoder = new TextDecoder();
    let buffer = '';
    let final: ChatChunk | null = null;
    try {
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const chunk = parseChunk(line);
          if (chunk.error) throw new ProviderError('unknown', chunk.error);
          if (chunk.message?.content) yield { type: 'text-delta', text: chunk.message.content };
          if (chunk.done) final = chunk;
        }
      }
    } catch (err) {
      throw toProviderError(err, signal, this.connection.apiKey);
    }
    if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    if (!final) throw new ProviderError('bad-response', 'The Ollama stream ended early.');
    yield { type: 'usage', usage: usageOf(final) };
    yield { type: 'done', stopReason: stopReason(final.done_reason), rawReason: final.done_reason ?? null, detail: null };
  }

  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>> {
    const response = await this.request(
      '/api/chat',
      { method: 'POST', body: this.body(request, { stream: false, format: spec.jsonSchema }) },
      request.signal,
    );
    const chunk = parseChunk(await response.text());
    if (chunk.done_reason === 'length') throw new ProviderError('bad-response', 'The structured answer was cut off.');
    return { value: parseJson(chunk.message?.content ?? '', spec), usage: usageOf(chunk) };
  }
}

function parseChunk(line: string): ChatChunk {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    throw new ProviderError('bad-response', 'Ollama sent malformed JSON.');
  }
  const parsed = ChatChunk.safeParse(data);
  if (!parsed.success) throw new ProviderError('bad-response', 'Unexpected message from Ollama.');
  return parsed.data;
}
