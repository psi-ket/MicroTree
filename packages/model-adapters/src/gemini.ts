import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  PROVIDER_KINDS,
  ProviderError,
  contentParts,
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
import { toProviderError, type ProviderConnection } from './util';

function stopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'STOP':
      return 'end';
    case 'MAX_TOKENS':
      return 'max-tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'RECITATION':
    case 'SPII':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(r: GenerateContentResponse | null): TokenUsage | null {
  const u = r?.usageMetadata;
  if (!u) return null;
  return {
    inputTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount ?? null,
    cachedInputTokens: u.cachedContentTokenCount ?? null,
    costUsd: null,
  };
}

/** Gemini through the official Google Gen AI SDK (Gemini Developer API). */
export class GeminiProvider implements ModelProvider {
  readonly kind = 'gemini' as const;
  readonly capabilities = PROVIDER_KINDS.gemini.capabilities;
  private readonly client: GoogleGenAI;
  private readonly secret: string;

  constructor(connection: ProviderConnection) {
    if (!connection.apiKey) throw new ProviderError('auth', 'A Gemini API key is required.');
    this.secret = connection.apiKey;
    this.client = new GoogleGenAI({
      apiKey: connection.apiKey,
      httpOptions: { timeout: connection.timeoutMs, ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}) },
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      const pager = await this.client.models.list({ config: { pageSize: 100, abortSignal: signal } });
      for await (const m of pager) {
        if (!m.name || !(m.supportedActions ?? []).includes('generateContent')) continue;
        const id = m.name.replace(/^models\//, '');
        out.push({ id, displayName: m.displayName ?? id, contextTokens: m.inputTokenLimit ?? null });
      }
      return out;
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
  }

  private contents(request: ModelRequest) {
    validateRequestContent(request, this.capabilities);
    return request.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: contentParts(m.content).map((p) =>
        p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: Buffer.from(p.data).toString('base64') } },
      ),
    }));
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { signal } = request;
    let last: GenerateContentResponse | null = null;
    let finish: string | null = null;
    try {
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents: this.contents(request),
        config: { systemInstruction: request.system, maxOutputTokens: request.maxOutputTokens, abortSignal: signal },
      });
      for await (const chunk of stream) {
        if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
        last = chunk;
        const text = chunk.text;
        if (text) yield { type: 'text-delta', text };
        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason) finish = reason;
        if (chunk.promptFeedback?.blockReason) finish = 'SAFETY';
      }
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
    if (signal?.aborted) throw new ProviderError('cancelled', 'The request was cancelled.');
    const usage = usageOf(last);
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: stopReason(finish), rawReason: finish, detail: null };
  }

  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>): Promise<StructuredResult<T>> {
    const { signal } = request;
    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: request.model,
        contents: this.contents(request),
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: spec.jsonSchema,
          abortSignal: signal,
        },
      });
    } catch (err) {
      throw toProviderError(err, signal, this.secret);
    }
    const reason = response.candidates?.[0]?.finishReason;
    if (stopReason(reason) === 'refusal') throw new ProviderError('invalid-request', 'The model declined this request.');
    if (reason === 'MAX_TOKENS') throw new ProviderError('bad-response', 'The structured answer was cut off.');
    return { value: parseJson(response.text ?? '', spec), usage: usageOf(response) };
  }
}
