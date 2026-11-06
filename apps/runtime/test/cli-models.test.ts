/**
 * Claude Code and Codex as model providers (`claude-cli`, `codex-cli`) over
 * HTTP, with fake CLIs: settings, model lists, conversations, availability to
 * the visual and evidence features, and RS_AGENTS=off.
 */
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAgent, CodexAgent } from '@research-studio/agent-adapters';
import { VisualProvidersResponse } from '@research-studio/api-contracts';
import type { Conversation, ConversationMessage, Project, ProviderConfigView } from '@research-studio/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRuntime, type TestRuntime } from './helpers';

const FIXTURES = '../../../packages/agent-adapters/test/fixtures/';
const FAKE_CLAUDE = fileURLToPath(new URL(`${FIXTURES}fake-claude-model.mjs`, import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL(`${FIXTURES}fake-codex-model.mjs`, import.meta.url));
const agentEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const registry = () => [new ClaudeCodeAgent({ configuredPath: FAKE_CLAUDE, env: agentEnv }), new CodexAgent({ configuredPath: FAKE_CODEX, env: agentEnv })];

const api = (p: string) => `/api/v1${p}`;
let rt: TestRuntime;
let project: Project;

async function addProvider(runtime: TestRuntime, kind: 'claude-cli' | 'codex-cli'): Promise<ProviderConfigView> {
  const res = await runtime.request('POST', api('/ai/providers'), { body: { kind, displayName: kind } });
  expect(res.statusCode).toBe(201);
  return res.json<{ provider: ProviderConfigView }>().provider;
}

async function ask(runtime: TestRuntime, projectId: string, provider: ProviderConfigView, text: string): Promise<ConversationMessage> {
  const proj = (p: string) => api(`/projects/${projectId}${p}`);
  const conv = (await runtime.request('POST', proj('/ai/conversations'), { body: { mode: 'model', providerId: provider.id, model: 'default' } })).json<{ conversation: Conversation }>().conversation;
  const res = await runtime.request('POST', proj(`/ai/conversations/${conv.id}/messages`), { body: { text, context: {} } });
  expect(res.statusCode).toBe(202);
  const { assistantMessage } = res.json<{ assistantMessage: ConversationMessage }>();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const messages = (await runtime.request('GET', proj(`/ai/conversations/${conv.id}`))).json<{ messages: ConversationMessage[] }>().messages;
    const done = messages.find((m) => m.id === assistantMessage.id && m.status !== 'streaming');
    if (done) return done;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the answer');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  rt = await createTestRuntime({ agentRegistry: registry });
  project = (await rt.request('POST', api('/projects'), { body: { name: 'CLI models', template: 'empty' } })).json<{ project: Project }>().project;
});
afterAll(() => rt.dispose());

describe('CLI model providers', () => {
  it('are added without a key or URL, and refuse either', async () => {
    const claude = await addProvider(rt, 'claude-cli');
    expect(claude).toMatchObject({ kind: 'claude-cli', baseUrl: null, defaultModel: 'default', credential: { required: false, configured: false }, capabilities: { vision: true, structuredOutput: true } });
    const withKey = await rt.request('POST', api('/ai/providers'), { body: { kind: 'claude-cli', displayName: 'x', apiKey: 'sk-ant-should-not-be-here' } });
    expect(withKey.statusCode).toBe(400);
    const withUrl = await rt.request('POST', api('/ai/providers'), { body: { kind: 'codex-cli', displayName: 'x', baseUrl: 'https://api.example.org' } });
    expect(withUrl.statusCode).toBe(400);
    const patchKey = await rt.request('PATCH', api(`/ai/providers/${claude.id}`), { body: { apiKey: 'sk-ant-should-not-be-here' } });
    expect(patchKey.statusCode).toBe(400);
  });

  it('list the models the CLI accepts', async () => {
    const claude = await addProvider(rt, 'claude-cli');
    const codex = await addProvider(rt, 'codex-cli');
    const ids = async (p: ProviderConfigView) => (await rt.request('GET', api(`/ai/providers/${p.id}/models`))).json<{ models: { id: string }[] }>().models.map((m) => m.id);
    expect(await ids(claude)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(await ids(codex)).toEqual(['default']);
  });

  it('answer in assistant conversations', async () => {
    for (const kind of ['claude-cli', 'codex-cli'] as const) {
      const answer = await ask(rt, project.id, await addProvider(rt, kind), 'Say hello');
      expect(answer).toMatchObject({ status: 'complete', content: 'Hello there.' });
    }
  });

  it('report a signed-out CLI as a provider error', async () => {
    const answer = await ask(rt, project.id, await addProvider(rt, 'claude-cli'), 'AUTH please');
    expect(answer.status).toBe('error');
    expect(answer.error).toMatch(/not signed in/);
  });

  it('are offered to image tasks as cloud providers that need consent', async () => {
    const claude = await addProvider(rt, 'claude-cli');
    const list = VisualProvidersResponse.parse((await rt.request('GET', api('/visual/providers'))).json());
    expect(list.providers.find((p) => p.id === claude.id)).toMatchObject({ privacyMode: 'cloud', usable: true, vision: true, structuredOutput: true });
    const check = (await rt.request('GET', api(`/visual/providers/${claude.id}/check?model=default&taskType=equation`))).json<{ ok: boolean; needsConsent: boolean }>();
    expect(check).toMatchObject({ ok: true, needsConsent: true });
  });
});

describe('installed CLIs', () => {
  const listed = async (runtime: TestRuntime) => (await runtime.request('GET', api('/ai/providers'))).json<{ providers: ProviderConfigView[] }>().providers;

  it('are offered to every feature without any setup, and stay removed once removed', async () => {
    let fresh = await createTestRuntime({ agentRegistry: registry });
    try {
      expect((await listed(fresh)).map((p) => [p.id, p.kind, p.enabled])).toEqual([
        ['claude-cli', 'claude-cli', true],
        ['codex-cli', 'codex-cli', true],
      ]);
      const visual = VisualProvidersResponse.parse((await fresh.request('GET', api('/visual/providers'))).json());
      expect(visual.providers.filter((p) => p.usable).map((p) => p.id)).toEqual(['claude-cli', 'codex-cli']);

      expect((await fresh.request('DELETE', api('/ai/providers/codex-cli'))).statusCode).toBeLessThan(300);
      fresh = await fresh.restart();
      expect((await listed(fresh)).map((p) => p.id)).toEqual(['claude-cli']);
    } finally {
      await fresh.dispose();
    }
  });

  it('are not added when the CLI is missing or CLI agents are off', async () => {
    const missing = await createTestRuntime({ agentRegistry: () => [new CodexAgent({ configuredPath: FAKE_CODEX, env: agentEnv })] });
    const off = await createTestRuntime({ agentRegistry: registry, config: { RS_AGENTS: 'off' } });
    try {
      expect((await listed(missing)).map((p) => p.id)).toEqual(['codex-cli']);
      expect(await listed(off)).toEqual([]);
    } finally {
      await missing.dispose();
      await off.dispose();
    }
  });
});

describe('with CLI agents turned off', () => {
  it('cannot be used', async () => {
    const off = await createTestRuntime({ agentRegistry: registry, config: { RS_AGENTS: 'off' } });
    try {
      const p = (await off.request('POST', api('/projects'), { body: { name: 'Off', template: 'empty' } })).json<{ project: Project }>().project;
      const provider = await addProvider(off, 'claude-cli');
      const conv = (await off.request('POST', api(`/projects/${p.id}/ai/conversations`), { body: { mode: 'model', providerId: provider.id, model: 'default' } })).json<{ conversation: Conversation }>().conversation;
      // Refused before anything is recorded.
      const res = await off.request('POST', api(`/projects/${p.id}/ai/conversations/${conv.id}/messages`), { body: { text: 'Say hello', context: {} } });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json<{ error: { message: string } }>().error.message).toMatch(/RS_AGENTS=off/);
    } finally {
      await off.dispose();
    }
  });
});
