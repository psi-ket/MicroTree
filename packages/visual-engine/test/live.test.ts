/**
 * Opt-in smoke test against a real vision model. Not part of `pnpm test`
 * unless RS_VISUAL_LIVE=1. By default it uses Ollama on this computer:
 *
 *   RS_VISUAL_LIVE=1 RS_VISUAL_MODEL=llava pnpm --filter @research-studio/visual-engine exec vitest run test/live.test.ts
 *
 * RS_VISUAL_KIND (ollama, anthropic, openai, gemini), RS_VISUAL_BASE_URL and
 * RS_VISUAL_API_KEY select another provider. A hosted provider receives a
 * synthetic image of an equation; nothing else is sent.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ModelProviderKind } from '@research-studio/shared-types';
import { createModelProvider } from '@research-studio/model-adapters';
import { routeTask, runVisualTask } from '../src';

const live = process.env.RS_VISUAL_LIVE === '1';
const kind = (process.env.RS_VISUAL_KIND ?? 'ollama') as ModelProviderKind;
const baseUrl = process.env.RS_VISUAL_BASE_URL ?? (kind === 'ollama' ? 'http://127.0.0.1:11434' : null);
const model = process.env.RS_VISUAL_MODEL ?? 'llava';

describe.runIf(live)('live vision model', () => {
  it('reconstructs a rendered equation', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="120"><rect width="520" height="120" fill="white"/><text x="20" y="75" font-family="serif" font-size="48">E = m c² + ∫ f(x) dx</text></svg>`;
    const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
    const provider = createModelProvider(kind, { apiKey: process.env.RS_VISUAL_API_KEY ?? null, baseUrl, timeoutMs: 180_000, maxRetries: 1 });
    const route = await routeTask('equation', { kind, baseUrl, provider, model });
    expect(route.modelVision).not.toBe(false);
    const r = await runVisualTask({ task: 'equation', provider, model, image: { mimeType: 'image/png', data: png }, text: null });
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    console.info(r.payload.sourceCode, r.payload.warnings);
    expect(r.payload.sourceCode).toMatch(/E\s*=\s*m\s*c\^\{?2\}?/);
  }, 240_000);
});
