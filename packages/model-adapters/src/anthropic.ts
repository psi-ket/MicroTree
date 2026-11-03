import Anthropic from '@anthropic-ai/sdk';
import {
  PROVIDER_KINDS,
  ProviderError,
  validateRequestContent,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type StructuredOutputSpec,
  type StructuredResult,
} from '@research-studio/ai-core';
import type { ModelInfo, TokenUsage } from '@research-studio/shared-types';
import { toProviderError, type ProviderConnection } from './util';

/** Models that accept server-side refusal fallbacks and adaptive effort control. */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const EFFORT_MODELS = /^claude-(fable|opus|sonnet|haiku)-5/;

function stopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null } | null | undefined): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    cachedInputTokens: u?.cache_read_input_tokens ?? null,
    costUsd: null,
  };
}

/** Claude through the official Anthropic SDK (Messages API). */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  readonly capabilities = PROVIDER_KINDS.anthropic.capabilities;
  private readonly client: Anthropic;
  private readonly secret: string | null;
  /** Server-side fallbacks only exist on Anthropic's own API, not on proxies. */
  private readonly firstParty: boolean;

  constructor(connection: ProviderConnection, options: { serverFallbacks?: boolean } = {}) {
    if (!connection.apiKey) throw new ProviderError('auth', 'An Anthropic API key is required.');
    this.secret = connection.apiKey;
    this.firstParty = options.serverFallbacks ?? !connection.baseUrl;
    this.client = new Anthropic({
      apiKey: connection.apiKey,
      ...(connection.baseUrl ? { baseURL: connection.baseUrl } : {}),
      timeout: connection.timeoutMs,
      maxRetries: connection.maxRetries,
      ...(connection.fetch ? { fetch: connection.fetch } : {}),
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) {
        if (m.lifecycle === 'retired') continue;
        out.push({ id: m.id, displayName: m.display_name, contextTokens: m.max_input_tokens ?? null });
      }
      return out;
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
  }

  private params(request: ModelRequest) {
    validateRequestContent(request, this.capabilities);
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: request.messages.map((m): Anthropic.MessageParam => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) =>
                p.type === 'text'
                  ? { type: 'text' as const, text: p.text }
                  : { type: 'image' as const, source: { type: 'base64' as const, media_type: p.mimeType, data: Buffer.from(p.data).toString('base64') } },
              ),
      })),
      ...(EFFORT_MODELS.test(request.model) ? { output_config: { effort: 'medium' as const } } : {}),
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { signal } = request;
    try {
      // On models with safety classifiers, a declined request is retried on
      // another model server-side instead of ending with a refusal.
      const stream =
        this.firstParty && FALLBACK_MODELS.test(request.model)
          ? this.client.beta.messages.stream(
              { ...this.params(request), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
              { signal },
            )
          : this.client.messages.stream(this.params(request), { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text-delta', text: event.delta.text };
        }
      }
      if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
      const final = await stream.finalMessage();
      yield { type: 'usage', usage: usageOf(final.usage) };
      const detail = final.stop_reason === 'refusal' ? (final.stop_details?.explanation ?? null) : null;
      yield { type: 'done', stopReason: stopReason(final.stop_reason), rawReason: final.stop_reason ?? null, detail };
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
  }

  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>> {
    const { signal } = request;
    let message: Anthropic.Message;
    try {
      message = await this.client.messages
        .stream(
          {
            ...this.params(request),
            output_config: {
              ...(EFFORT_MODELS.test(request.model) ? { effort: 'medium' as const } : {}),
              format: { type: 'json_schema', schema: spec.jsonSchema },
            },
          },
          { signal },
        )
        .finalMessage();
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
    if (message.stop_reason === 'refusal') throw new ProviderError('invalid-request', 'The model declined this request.');
    if (message.stop_reason === 'max_tokens') throw new ProviderError('bad-response', 'The structured answer was cut off.');
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { value: parseJson(text, spec), usage: usageOf(message.usage) };
  }
}

export function parseJson<T>(text: string, spec: StructuredOutputSpec<T>): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProviderError('bad-response', 'The model did not return valid JSON.');
  }
  try {
    return spec.parse(data);
  } catch {
    throw new ProviderError('bad-response', `The model's answer does not match the expected ${spec.name} format.`);
  }
}
