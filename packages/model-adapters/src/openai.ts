import OpenAI from 'openai';
import {
  PROVIDER_KINDS,
  ProviderError,
  textOf,
  validateRequestContent,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type StructuredOutputSpec,
  type StructuredResult,
} from '@research-studio/ai-core';
import type { ModelCapabilities, ModelInfo, TokenUsage } from '@research-studio/shared-types';
import { parseJson } from './anthropic';
import { toProviderError, type ProviderConnection } from './util';

function stopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max-tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(u: OpenAI.CompletionUsage | null | undefined): TokenUsage {
  return {
    inputTokens: u?.prompt_tokens ?? null,
    outputTokens: u?.completion_tokens ?? null,
    cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? null,
    costUsd: null,
  };
}

/** Chat models in OpenAI's list (it also returns embedding, audio and image models). */
function isOpenAiChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(id)) return false;
  return !/(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct)/.test(id);
}

/**
 * OpenAI's Chat Completions API through the official SDK. The same class
 * serves OpenAI-compatible servers (vLLM, LM Studio, OpenRouter, …), which
 * only implement the common subset, so it is told which flavour it talks to.
 */
export class OpenAiProvider implements ModelProvider {
  readonly kind: 'openai' | 'openai-compatible';
  readonly capabilities: ModelCapabilities;
  private readonly client: OpenAI;
  private readonly secret: string | null;

  constructor(connection: ProviderConnection, flavour: 'openai' | 'openai-compatible' = 'openai') {
    this.kind = flavour;
    this.capabilities = PROVIDER_KINDS[flavour].capabilities;
    if (flavour === 'openai' && !connection.apiKey) throw new ProviderError('auth', 'An OpenAI API key is required.');
    if (flavour === 'openai-compatible' && !connection.baseUrl) {
      throw new ProviderError('invalid-request', 'An OpenAI-compatible provider needs a base URL.');
    }
    this.secret = connection.apiKey;
    this.client = new OpenAI({
      // Many local servers accept any key; the SDK requires a non-empty one.
      apiKey: connection.apiKey ?? 'not-needed',
      ...(connection.baseUrl ? { baseURL: connection.baseUrl } : {}),
      timeout: connection.timeoutMs,
      maxRetries: connection.maxRetries,
      ...(connection.fetch ? { fetch: connection.fetch } : {}),
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list({ signal })) {
        if (this.kind === 'openai' && !isOpenAiChatModel(m.id)) continue;
        out.push({ id: m.id, displayName: m.id, contextTokens: null });
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
  }

  private messages(request: ModelRequest): OpenAI.ChatCompletionMessageParam[] {
    validateRequestContent(request, this.capabilities);
    return [
      { role: this.kind === 'openai' ? 'developer' : 'system', content: request.system },
      ...request.messages.map((m): OpenAI.ChatCompletionMessageParam =>
        m.role === 'assistant' || typeof m.content === 'string'
          ? { role: m.role, content: textOf(m.content) }
          : {
              role: 'user',
              content: m.content.map((p): OpenAI.ChatCompletionContentPart =>
                p.type === 'text'
                  ? { type: 'text', text: p.text }
                  : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${Buffer.from(p.data).toString('base64')}` } },
              ),
            },
      ),
    ];
  }

  private limit(request: ModelRequest) {
    // Compatible servers commonly only understand the older field.
    return this.kind === 'openai' ? { max_completion_tokens: request.maxOutputTokens } : { max_tokens: request.maxOutputTokens };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { signal } = request;
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | null = null;
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: this.messages(request),
          stream: true,
          stream_options: { include_usage: true },
          ...this.limit(request),
        },
        { signal },
      );
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const text = choice?.delta?.content;
        if (text) yield { type: 'text-delta', text };
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
    // The SDK ends the iteration quietly when aborted.
    if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    if (usage) yield { type: 'usage', usage: usageOf(usage) };
    yield { type: 'done', stopReason: stopReason(finish), rawReason: finish, detail: null };
  }

  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>> {
    if (!this.capabilities.structuredOutput) {
      throw new ProviderError('invalid-request', 'This provider does not support structured output.');
    }
    const { signal } = request;
    let completion: OpenAI.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: this.messages(request),
          response_format: { type: 'json_schema', json_schema: { name: spec.name, schema: spec.jsonSchema, strict: true } },
          ...this.limit(request),
        },
        { signal },
      );
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
    const choice = completion.choices[0];
    if (choice?.message.refusal) throw new ProviderError('invalid-request', 'The model declined this request.');
    if (choice?.finish_reason === 'length') throw new ProviderError('bad-response', 'The structured answer was cut off.');
    return { value: parseJson(choice?.message.content ?? '', spec), usage: usageOf(completion.usage) };
  }
}
