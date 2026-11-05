import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completionState, ProviderError, type ModelProvider, type ModelRequest, type ModelStreamEvent, type StructuredOutputSpec } from '@research-studio/ai-core';
import type { ModelProviderKind } from '@research-studio/shared-types';
import { AnthropicProvider, createModelProvider } from '../src';
import { MockProviderServer } from './mock-server';

const server = new MockProviderServer();
let root = '';
const KEY = 'sk-test-SECRET-0123456789abcdef';

beforeAll(async () => {
  root = await server.start();
});
afterAll(() => server.stop());

const baseUrlFor = (kind: ModelProviderKind) => (kind === 'openai' || kind === 'openai-compatible' ? `${root}/v1` : root);

function provider(kind: ModelProviderKind, apiKey: string | null = KEY): ModelProvider {
  return createModelProvider(kind, { apiKey, baseUrl: baseUrlFor(kind), timeoutMs: 10_000, maxRetries: 0 });
}

function req(model: string, signal?: AbortSignal): ModelRequest {
  return {
    model,
    system: 'You are terse.',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
      { role: 'user', content: 'Explain $E=mc^2$.' },
    ],
    maxOutputTokens: 256,
    ...(signal ? { signal } : {}),
  };
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** Run one scenario to its end and classify it the way the runtime does. */
async function outcome(kind: ModelProviderKind, scenario: string) {
  try {
    const done = (await collect(provider(kind).stream(req(scenario)))).find((e) => e.type === 'done');
    return completionState({ stopReason: done?.type === 'done' ? done.stopReason : null, cancelled: false, error: false });
  } catch {
    return completionState({ stopReason: null, cancelled: false, error: true });
  }
}

// The HTTP adapters; the CLI kinds are covered in agent-adapters.
const KINDS = ['anthropic', 'openai', 'openai-compatible', 'gemini', 'ollama'] as const satisfies readonly ModelProviderKind[];

describe.each(KINDS)('%s adapter', (kind) => {
  it('streams text deltas, then usage, then one done event', async () => {
    const events = await collect(provider(kind).stream(req('ok')));
    const text = events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello from the mock.');
    expect(events.filter((e) => e.type === 'text-delta').length).toBe(3);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.type === 'usage' && usage.usage.inputTokens).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end', detail: null });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('lists models', async () => {
    const models = await provider(kind).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id && m.displayName)).toBe(true);
  });

  it('reports a refusal as a stop reason', async () => {
    if (kind === 'ollama') return; // Ollama has no refusal signal
    const events = await collect(provider(kind).stream(req('refuse')));
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'refusal' });
  });

  it('reports the output limit as truncated, with the raw finish reason', async () => {
    const events = await collect(provider(kind).stream(req('length')));
    const raw = { anthropic: 'max_tokens', openai: 'length', 'openai-compatible': 'length', gemini: 'MAX_TOKENS', ollama: 'length' }[kind];
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max-tokens', rawReason: raw });
    expect(await outcome(kind, 'length')).toBe('truncated');
  });

  it('classifies a normal end as completed and a dropped connection as not completed', async () => {
    expect(await outcome(kind, 'ok')).toBe('completed');
    expect(['failed', 'incomplete']).toContain(await outcome(kind, 'drop'));
  });

  it('classifies a stream without a finish reason as incomplete', async () => {
    if (kind === 'anthropic') {
      // Anthropic always sends a stop reason; pause_turn is the "not finished" one.
      expect(await outcome(kind, 'pause')).toBe('incomplete');
      return;
    }
    expect(await outcome(kind, 'nofinish')).toBe('incomplete');
  });

  it('normalizes errors without leaking the key', async () => {
    if (kind === 'ollama') {
      await expect(collect(provider(kind).stream(req('error-404')))).rejects.toMatchObject({ code: 'not-found' });
      return;
    }
    const auth = await collect(provider(kind).stream(req('error-401'))).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(ProviderError);
    expect((auth as ProviderError).code).toBe('auth');
    expect((auth as ProviderError).message).not.toContain(KEY);
    const limited = await collect(provider(kind).stream(req('error-429'))).catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: 'rate-limit', retryable: true });
  });

  it('cancels a stream mid-flight and closes the connection', async () => {
    const controller = new AbortController();
    const before = server.closedEarly;
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of provider(kind).stream(req('slow', controller.signal))) {
        if (e.type === 'text-delta') {
          seen.push(e.text);
          controller.abort();
        }
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen).toEqual(['Hello']);
    await expect.poll(() => server.closedEarly).toBeGreaterThan(before);
  });

  it('returns validated structured output when supported', async () => {
    const p = provider(kind);
    const spec: StructuredOutputSpec<{ verdict: string; issues: string[] }> = {
      name: 'notation_report',
      jsonSchema: {
        type: 'object',
        properties: { verdict: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } },
        required: ['verdict', 'issues'],
        additionalProperties: false,
      },
      parse: (v) => z.object({ verdict: z.string(), issues: z.array(z.string()) }).parse(v),
    };
    if (!p.capabilities.structuredOutput) {
      await expect(p.generateStructured(req('ok'), spec)).rejects.toMatchObject({ code: 'invalid-request' });
      return;
    }
    server.structured = { verdict: 'consistent', issues: [] };
    await expect(p.generateStructured(req('ok'), spec)).resolves.toMatchObject({ value: { verdict: 'consistent', issues: [] } });
    server.structured = { verdict: 3 };
    await expect(p.generateStructured(req('ok'), spec)).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('request shapes', () => {
  it('Anthropic: key header, system prompt, roles, effort and server-side fallbacks', async () => {
    const p = new AnthropicProvider({ apiKey: KEY, baseUrl: root, timeoutMs: 10_000, maxRetries: 0 }, { serverFallbacks: true });
    await collect(p.stream(req('claude-opus-5-5')));
    const r = server.last();
    // SDK 1.x sends the key as a bearer token; older releases used x-api-key.
    expect(r.headers['x-api-key'] ?? r.headers.authorization).toMatch(new RegExp(`^(Bearer )?${KEY}$`));
    expect(r.body).toMatchObject({ model: 'claude-opus-5-5', system: 'You are terse.', max_tokens: 256, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(String(r.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect((r.body!.messages as unknown[]).length).toBe(3);
    expect(r.body).not.toHaveProperty('temperature');
    // Proxies and older models get a plain request.
    await collect(provider('anthropic').stream(req('claude-haiku-4-5')));
    expect(server.last().body).not.toHaveProperty('fallbacks');
    expect(server.last().body).not.toHaveProperty('output_config');
  });

  it('OpenAI: developer message and max_completion_tokens; compatible: system message and max_tokens', async () => {
    await collect(provider('openai').stream(req('gpt-5')));
    expect(server.last().headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.last().body).toMatchObject({ max_completion_tokens: 256, stream: true, stream_options: { include_usage: true } });
    expect((server.last().body!.messages as { role: string }[])[0]!.role).toBe('developer');
    await collect(provider('openai-compatible', null).stream(req('local-llama')));
    expect(server.last().body).toMatchObject({ max_tokens: 256 });
    expect((server.last().body!.messages as { role: string }[])[0]!.role).toBe('system');
  });

  it('OpenAI lists chat models only; compatible endpoints list everything', async () => {
    expect((await provider('openai').listModels()).map((m) => m.id)).toEqual(['gpt-5', 'o4-mini']);
    expect((await provider('openai-compatible').listModels()).map((m) => m.id)).toContain('local-llama');
  });

  it('Gemini: api key header, system instruction and model role mapping', async () => {
    await collect(provider('gemini').stream(req('gemini-pro-x')));
    const r = server.last();
    expect(r.headers['x-goog-api-key']).toBe(KEY);
    expect(r.path).toContain('/models/gemini-pro-x:streamGenerateContent');
    expect(JSON.stringify(r.body)).toContain('You are terse.');
    expect((r.body!.contents as { role: string }[]).map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect((await provider('gemini').listModels()).map((m) => m.id)).toEqual(['gemini-pro-x']);
  });

  it('Ollama: system message first, num_predict, no auth header without a key', async () => {
    await collect(provider('ollama', null).stream(req('qwen2.5:7b')));
    const r = server.last();
    expect(r.headers.authorization).toBeUndefined();
    expect(r.body).toMatchObject({ model: 'qwen2.5:7b', stream: true, options: { num_predict: 256 } });
    expect((r.body!.messages as { role: string }[])[0]).toEqual({ role: 'system', content: 'You are terse.' });
  });

  it('requires credentials and base URLs where the provider needs them', () => {
    expect(() => createModelProvider('anthropic', { apiKey: null, baseUrl: null, timeoutMs: 1, maxRetries: 0 })).toThrow(/API key/);
    expect(() => createModelProvider('openai', { apiKey: null, baseUrl: null, timeoutMs: 1, maxRetries: 0 })).toThrow(/API key/);
    expect(() => createModelProvider('gemini', { apiKey: null, baseUrl: null, timeoutMs: 1, maxRetries: 0 })).toThrow(/API key/);
    expect(() => createModelProvider('openai-compatible', { apiKey: null, baseUrl: null, timeoutMs: 1, maxRetries: 0 })).toThrow(/base URL/);
    expect(() => createModelProvider('ollama', { apiKey: null, baseUrl: null, timeoutMs: 1, maxRetries: 0 })).not.toThrow();
  });

  it('maps an unreachable endpoint to a network error', async () => {
    const p = createModelProvider('openai-compatible', { apiKey: null, baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 5_000, maxRetries: 0 });
    await expect(collect(p.stream(req('x')))).rejects.toMatchObject({ code: 'network' });
  });
});

describe('image input', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const B64 = Buffer.from(PNG).toString('base64');
  const withImage = (model: string): ModelRequest => ({
    model,
    system: 'You are terse.',
    messages: [
      { role: 'user', content: 'Earlier question.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] },
      { role: 'user', content: [{ type: 'text', text: 'What does this figure show?' }, { type: 'image', mimeType: 'image/png', data: PNG }] },
    ],
    maxOutputTokens: 256,
  });
  const sent = () => server.last().body as Record<string, unknown>;

  it('anthropic sends a base64 image block', async () => {
    await collect(provider('anthropic').stream(withImage('ok')));
    const messages = sent().messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] });
    expect(messages[2]!.content).toEqual([
      { type: 'text', text: 'What does this figure show?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
    ]);
  });

  it('openai sends an image_url data URL, and plain text for assistant turns', async () => {
    await collect(provider('openai').stream(withImage('ok')));
    const messages = sent().messages as { role: string; content: unknown }[];
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Earlier answer.' });
    expect(messages[3]!.content).toEqual([
      { type: 'text', text: 'What does this figure show?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
    ]);
  });

  it('gemini sends inline data', async () => {
    await collect(provider('gemini').stream(withImage('ok')));
    const contents = sent().contents as { role: string; parts: unknown[] }[];
    expect(contents[2]!.parts).toEqual([{ text: 'What does this figure show?' }, { inlineData: { mimeType: 'image/png', data: B64 } }]);
  });

  it('ollama sends images as base64 in the message, and reports per-model vision support', async () => {
    await collect(provider('ollama').stream(withImage('llama3.2-vision')));
    const messages = sent().messages as Record<string, unknown>[];
    expect(messages[3]).toEqual({ role: 'user', content: 'What does this figure show?', images: [B64] });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Earlier answer.' });
    const p = provider('ollama');
    expect(await p.describeModel!('llama3.2-vision')).toEqual({ vision: true });
    expect(await p.describeModel!('qwen2.5:7b')).toEqual({ vision: false });
    expect(await p.describeModel!('unknown-caps')).toEqual({ vision: null });
  });

  it('openai passes the image detail level when one is set', async () => {
    const r = withImage('ok');
    (r.messages[2]!.content as { detail?: string }[])[1]!.detail = 'high';
    await collect(provider('openai').stream(r));
    const messages = sent().messages as { content: { image_url?: unknown }[] }[];
    expect(messages[3]!.content[1]!.image_url).toEqual({ url: `data:image/png;base64,${B64}`, detail: 'high' });
  });

  it.each(['openai-compatible'] as const)('%s refuses images before sending anything', async (kind) => {
    const before = server.requests.length;
    await expect(collect(provider(kind).stream(withImage('ok')))).rejects.toMatchObject({ code: 'unsupported-modality' });
    expect(server.requests.length).toBe(before);
  });

  it('still sends text-only content parts to providers without vision', async () => {
    await collect(provider('ollama').stream({ ...withImage('ok'), messages: [{ role: 'user', content: [{ type: 'text', text: 'Only text.' }] }] }));
    expect(sent().messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Only text.' },
    ]);
  });

  it('rejects a spoofed image type in every adapter', async () => {
    for (const kind of ['anthropic', 'openai', 'gemini'] as const) {
      const bad = withImage('ok');
      (bad.messages[2]!.content as { type: string; mimeType?: string }[])[1]!.mimeType = 'image/jpeg';
      await expect(collect(provider(kind).stream(bad))).rejects.toMatchObject({ code: 'invalid-request' });
    }
  });
});
