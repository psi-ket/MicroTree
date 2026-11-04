import { z } from 'zod';
import { ProviderError, type ModelProvider, type StructuredOutputSpec } from '@research-studio/ai-core';
import type { TokenUsage } from '@research-studio/shared-types';
import { EvidenceError } from '../errors';

/**
 * Structured output contracts. The JSON Schema sent to the provider is
 * generated from the Zod schema the answer is parsed with, so the two cannot
 * drift apart. Every field is required; optional values are `null`.
 */
export function outputSpec<S extends z.ZodType>(name: string, schema: S): StructuredOutputSpec<z.infer<S>> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { name, jsonSchema, parse: (value: unknown) => schema.parse(value) };
}

export interface ModelTarget {
  provider: ModelProvider;
  model: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredAnswer<T> {
  value: T;
  usage: TokenUsage | null;
}

/** One structured call: system instructions and one user turn of fenced data. Provider errors get stable codes. */
export async function ask<T>(target: ModelTarget, system: string, user: string, spec: StructuredOutputSpec<T>): Promise<StructuredAnswer<T>> {
  try {
    const r = await target.provider.generateStructured(
      { model: target.model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxOutputTokens: target.maxOutputTokens ?? 4096, ...(target.signal ? { signal: target.signal } : {}) },
      spec,
    );
    return { value: r.value, usage: r.usage };
  } catch (err) {
    if (target.signal?.aborted) throw new EvidenceError('cancelled', 'The operation was cancelled');
    if (err instanceof ProviderError) {
      if (err.code === 'cancelled') throw new EvidenceError('cancelled', 'The operation was cancelled');
      if (err.code === 'bad-response') throw new EvidenceError('invalid-output', `The model's answer was not usable: ${err.message}`, { providerCode: err.code });
      throw new EvidenceError('provider-error', err.message, { providerCode: err.code });
    }
    if (err instanceof z.ZodError) throw new EvidenceError('invalid-output', `The model's answer did not match the expected structure: ${err.issues[0]?.message ?? 'invalid'}`);
    throw new EvidenceError('provider-error', err instanceof Error ? err.message : String(err));
  }
}

export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return { inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0), outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0), cachedInputTokens: null, costUsd: a.costUsd !== null && b.costUsd !== null ? a.costUsd + b.costUsd : null };
}

/** Untrusted text inside a prompt: a fenced block the model is told is data. Fence markers in the text are defused. */
export function fence(label: string, text: string): string {
  const safe = text.replace(/<\/?(untrusted|rs-[a-z-]+|project-context|context-item)[^>]*>/gi, (m) => m.replace('<', '&lt;'));
  return `<untrusted kind="${label}">\n${safe}\n</untrusted>`;
}
