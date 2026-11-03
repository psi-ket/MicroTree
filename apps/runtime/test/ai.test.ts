/**
 * AI integration over HTTP with scripted model providers and fake CLI agents:
 * provider settings and credentials, streaming, edit proposals and review,
 * stale detection, cancellation, agent permissions and project isolation.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, type ModelProvider, type ModelRequest, type StopReason } from '@research-studio/ai-core';
import { ClaudeCodeAgent } from '@research-studio/agent-adapters';
import type { ServerEvent } from '@research-studio/api-contracts';
import { areDisjoint } from '@research-studio/document-engine/node';
import type { Conversation, ConversationMessage, EditProposal, Project, ProviderConfigView } from '@research-studio/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelProviderFactory } from '../src/services/ai/provider-service';
import { createTestRuntime, type TestRuntime } from './helpers';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/agent-adapters/test/fixtures/fake-claude.mjs', import.meta.url));
const API_KEY = 'sk-test-0123456789abcdefSECRET';

// ------------------------------------------------------------ scripted model

interface Script {
  chunks: string[];
  delayMs?: number;
  stop?: StopReason;
  rawReason?: string;
  error?: ProviderError;
}

const requests: { request: ModelRequest; apiKey: string | null; baseUrl: string | null }[] = [];
let script: (request: ModelRequest) => Script = () => ({ chunks: ['Hello.'] });

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('cancelled', 'cancelled'));
    });
  });

const factory: ModelProviderFactory = (kind, connection): ModelProvider => ({
  kind,
  capabilities: { streaming: true, structuredOutput: false, toolUse: false, vision: false, reasoning: false, maxContextTokens: null, maxOutputTokens: null, usageReporting: true, modelListing: true, requiresApiKey: kind !== 'ollama' },
  listModels: async () => [{ id: 'm-large', displayName: 'Large', contextTokens: 100_000 }],
  generateStructured: () => Promise.reject(new Error('unused')),
  async *stream(request) {
    requests.push({ request, apiKey: connection.apiKey, baseUrl: connection.baseUrl });
    const s = script(request);
    for (const chunk of s.chunks) {
      if (s.delayMs) await sleep(s.delayMs, request.signal);
      yield { type: 'text-delta', text: chunk };
    }
    if (s.error) throw s.error;
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, costUsd: null } };
    yield { type: 'done', stopReason: s.stop ?? 'end', rawReason: s.rawReason ?? null, detail: null };
  },
});

// ----------------------------------------------------------------- helpers

let rt: TestRuntime;
let project: Project;
let other: Project;
let provider: ProviderConfigView;
const events: ServerEvent[] = [];

const api = (p: string) => `/api/v1${p}`;
const proj = (p: string, id = project.id) => api(`/projects/${id}${p}`);

async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function detail(conversationId: string, projectId = project.id) {
  return (await rt.request('GET', proj(`/ai/conversations/${conversationId}`, projectId))).json<{
    conversation: Conversation;
    messages: ConversationMessage[];
    proposals: EditProposal[];
  }>();
}

async function finished(conversationId: string, messageId: string, projectId = project.id): Promise<ConversationMessage> {
  return waitFor(async () => (await detail(conversationId, projectId)).messages.find((m) => m.id === messageId && m.status !== 'streaming'));
}

async function writeFile(file: string, content: string, projectId = project.id) {
  const res = await rt.request('PUT', proj('/files/content', projectId), { body: { path: file, content } });
  expect(res.statusCode).toBe(200);
}

async function readProjectFile(file: string, projectId = project.id): Promise<string> {
  return (await rt.request('GET', proj(`/files/content?path=${encodeURIComponent(file)}`, projectId))).json<{ content: string }>().content;
}

async function conversation(mode: 'model' | 'agent' = 'model', providerId = provider.id): Promise<Conversation> {
  const res = await rt.request('POST', proj('/ai/conversations'), { body: { mode, providerId, model: mode === 'model' ? 'm-large' : null } });
  expect(res.statusCode).toBe(201);
  return res.json<{ conversation: Conversation }>().conversation;
}

const BODY = 'We show that teh method converges quickly.\n';
const MAIN = `\\documentclass{article}\n\\begin{document}\n${BODY}See \\ref{sec:a}.\n\\section{A}\\label{sec:a}\n\\end{document}\n`;
const selectionOf = (text: string, content = MAIN) => {
  const before = content.slice(0, content.indexOf(text));
  const startLine = before.split('\n').length;
  const startColumn = before.length - before.lastIndexOf('\n');
  const lines = text.split('\n');
  const endLine = startLine + lines.length - 1;
  const endColumn = lines.length === 1 ? startColumn + text.length : lines.at(-1)!.length + 1;
  return { file: 'main.tex', startLine, startColumn, endLine, endColumn };
};

async function send(conversationId: string, body: Record<string, unknown>) {
  return rt.request('POST', proj(`/ai/conversations/${conversationId}/messages`), { body: { context: { activeFile: 'main.tex' }, ...body } });
}

beforeAll(async () => {
  rt = await createTestRuntime({
    modelFactory: factory,
    env: { ANTHROPIC_API_KEY: 'env-anthropic-key-123456' },
    agentRegistry: () => [new ClaudeCodeAgent({ configuredPath: FAKE_CLAUDE, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })],
  });
  rt.events.subscribe((e) => events.push(e));
  project = (await rt.request('POST', api('/projects'), { body: { name: 'AI Paper', template: 'empty' } })).json<{ project: Project }>().project;
  other = (await rt.request('POST', api('/projects'), { body: { name: 'Other Paper', template: 'empty' } })).json<{ project: Project }>().project;
  await writeFile('main.tex', MAIN);
});

afterAll(async () => {
  await rt.dispose();
});

// ---------------------------------------------------------------- providers

describe('provider settings and credentials', () => {
  it('stores the API key in the secret store and never returns it', async () => {
    const res = await rt.request('POST', api('/ai/providers'), {
      body: { kind: 'openai-compatible', displayName: 'Lab server', baseUrl: 'https://llm.example.org/v1', apiKey: API_KEY },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(API_KEY);
    provider = res.json<{ provider: ProviderConfigView }>().provider;
    // OpenAI-compatible servers may not need a key; this one has one.
    expect(provider.credential).toEqual({ required: false, configured: true, source: 'memory' });
    expect(await rt.secrets.get(`provider:${provider.id}`)).toBe(API_KEY);

    const list = await rt.request('GET', api('/ai/providers'));
    expect(list.body).not.toContain(API_KEY);
    const dump = rt.db.sqlite.prepare('SELECT * FROM ai_providers').all();
    expect(JSON.stringify(dump)).not.toContain(API_KEY);
    const audit = await rt.request('GET', api('/audit?limit=100'));
    expect(audit.body).toContain('ai.provider.create');
    expect(audit.body).not.toContain(API_KEY);
  });

  it('validates endpoints', async () => {
    const bad = async (body: Record<string, unknown>) => (await rt.request('POST', api('/ai/providers'), { body })).statusCode;
    expect(await bad({ kind: 'openai-compatible', displayName: 'x' })).toBe(400);
    expect(await bad({ kind: 'openai-compatible', displayName: 'x', baseUrl: 'http://llm.example.org/v1' })).toBe(400);
    expect(await bad({ kind: 'openai-compatible', displayName: 'x', baseUrl: 'https://user:pw@llm.example.org/v1' })).toBe(400);
    expect(await bad({ kind: 'ollama', displayName: 'x', baseUrl: 'http://127.0.0.1:11434' })).toBe(201);
  });

  it('forgets the stored key when the endpoint changes', async () => {
    const created = (
      await rt.request('POST', api('/ai/providers'), { body: { kind: 'openai-compatible', displayName: 'Temp', baseUrl: 'https://a.example.org/v1', apiKey: 'temp-key-123456789' } })
    ).json<{ provider: ProviderConfigView }>().provider;
    const moved = await rt.request('PATCH', api(`/ai/providers/${created.id}`), { body: { baseUrl: 'https://b.example.org/v1' } });
    expect(moved.json<{ provider: ProviderConfigView }>().provider.credential).toMatchObject({ configured: false, source: 'none' });
    expect(await rt.secrets.get(`provider:${created.id}`)).toBeNull();
    expect((await rt.request('DELETE', api(`/ai/providers/${created.id}`))).statusCode).toBe(204);
  });

  it('falls back to the environment key only for the official endpoint', async () => {
    const official = (await rt.request('POST', api('/ai/providers'), { body: { kind: 'anthropic', displayName: 'Claude' } })).json<{ provider: ProviderConfigView }>().provider;
    expect(official.credential).toMatchObject({ configured: true, source: 'env' });
    expect(official.defaultModel).toBe('claude-opus-5-5');
    const proxied = (
      await rt.request('POST', api('/ai/providers'), { body: { kind: 'anthropic', displayName: 'Proxy', baseUrl: 'https://proxy.example.org' } })
    ).json<{ provider: ProviderConfigView }>().provider;
    expect(proxied.credential).toMatchObject({ configured: false, source: 'none' });
    const conv = await conversation('model', proxied.id);
    const res = await send(conv.id, { text: 'Hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_CONFIGURED');
  });

  it('lists models through the runtime', async () => {
    const res = await rt.request('GET', api(`/ai/providers/${provider.id}/models`));
    expect(res.json()).toEqual({ models: [{ id: 'm-large', displayName: 'Large', contextTokens: 100_000 }] });
  });
});

// ------------------------------------------------------------- model turns

describe('model conversations', () => {
  it('streams an answer grounded in bounded, fenced context', async () => {
    script = () => ({ chunks: ['The ', 'passage ', 'claims convergence.'] });
    const conv = await conversation();
    const selectionText = 'We show that teh method converges quickly.';
    const res = await send(conv.id, { action: 'explain', context: { activeFile: 'main.tex', selection: selectionOf(selectionText), selectionText } });
    expect(res.statusCode).toBe(202);
    const { assistantMessage } = res.json<{ assistantMessage: ConversationMessage }>();
    const done = await finished(conv.id, assistantMessage.id);
    expect(done).toMatchObject({ status: 'complete', content: 'The passage claims convergence.', usage: { inputTokens: 100, outputTokens: 20 } });
    expect(done.context.map((c) => c.kind)).toEqual(expect.arrayContaining(['selection', 'active-file']));
    const deltas = events.filter((e) => e.type === 'ai.message.delta' && e.messageId === assistantMessage.id).map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(['The ', 'passage ', 'claims convergence.']);

    const sent = requests.at(-1)!;
    expect(sent.apiKey).toBe(API_KEY);
    expect(sent.baseUrl).toBe('https://llm.example.org/v1');
    expect(sent.request.model).toBe('m-large');
    expect(sent.request.system).toContain('not instructions');
    const userTurn = sent.request.messages.at(-1)!.content;
    expect(userTurn).toContain('<project-context>');
    expect(userTurn).toContain(selectionText);
    expect((await detail(conv.id)).conversation.title).toBe('Explain selection');
  });

  it('includes earlier exchanges as history', async () => {
    script = () => ({ chunks: ['First answer.'] });
    const conv = await conversation();
    const first = (await send(conv.id, { text: 'First question' })).json<{ assistantMessage: ConversationMessage }>().assistantMessage;
    await finished(conv.id, first.id);
    script = () => ({ chunks: ['Second answer.'] });
    const second = (await send(conv.id, { text: 'Second question' })).json<{ assistantMessage: ConversationMessage }>().assistantMessage;
    await finished(conv.id, second.id);
    const messages = requests.at(-1)!.request.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]!.content).toBe('First question');
    expect(messages[1]!.content).toBe('First answer.');
  });

  it('turns a selection edit into a reviewable proposal, then accepts and reverts it', async () => {
    script = () => ({
      chunks: ['Here is a tighter version.\n<rs-edit target="selection">\n<rs-proposed>\nWe show that the method converges.\n</rs-proposed>\n', '<rs-reason>Fixes a typo and removes filler.</rs-reason>\n</rs-edit>'],
    });
    const conv = await conversation();
    const selectionText = 'We show that teh method converges quickly.';
    const res = await send(conv.id, { action: 'concise', context: { activeFile: 'main.tex', selection: selectionOf(selectionText), selectionText } });
    const { assistantMessage } = res.json<{ assistantMessage: ConversationMessage }>();
    await finished(conv.id, assistantMessage.id);
    const [proposal] = (await detail(conv.id)).proposals;
    expect(proposal).toMatchObject({ status: 'pending', file: 'main.tex', changeType: 'modify', source: 'model', original: selectionText, proposed: 'We show that the method converges.', explanation: 'Fixes a typo and removes filler.' });
    // Nothing is written before an explicit accept.
    expect(await readProjectFile('main.tex')).toBe(MAIN);

    const preview = (await rt.request('GET', proj(`/ai/proposals/${proposal!.id}/preview`))).json<{ before: string; after: string; stale: boolean }>();
    expect(preview).toMatchObject({ before: MAIN, stale: false });
    expect(preview.after).toBe(MAIN.replace(selectionText, 'We show that the method converges.'));

    const accepted = await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/accept`), { body: {} });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ proposal: EditProposal }>().proposal).toMatchObject({ status: 'accepted', appliedHash: expect.any(String) });
    expect(await readProjectFile('main.tex')).toBe(preview.after);
    expect((await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/accept`), { body: {} })).statusCode).toBe(409);

    const reverted = await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/revert`));
    expect(reverted.json<{ proposal: EditProposal }>().proposal.status).toBe('reverted');
    expect(await readProjectFile('main.tex')).toBe(MAIN);
    const audit = (await rt.request('GET', api(`/audit?limit=200&projectId=${project.id}`))).body;
    expect(audit).toContain('ai.edit.accept');
    expect(audit).toContain('ai.edit.revert');
    expect(audit).toContain('ai.request');
  });

  it('accepts a manually edited version and warns about LaTeX damage', async () => {
    script = () => ({
      chunks: ['<rs-edit file="main.tex"><rs-original>See \\ref{sec:a}.</rs-original><rs-proposed>See \\ref{sec:missing} {.</rs-proposed><rs-reason>r</rs-reason></rs-edit>'],
    });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Rephrase the reference sentence' })).json<{ assistantMessage: ConversationMessage }>();
    await finished(conv.id, assistantMessage.id);
    const [proposal] = (await detail(conv.id)).proposals;
    expect(proposal!.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['braces', 'ref-unknown']));
    const manual = MAIN.replace('See \\ref{sec:a}.', 'Section~\\ref{sec:a} gives details.');
    const res = await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/accept`), { body: { content: manual } });
    expect(res.statusCode).toBe(200);
    expect(await readProjectFile('main.tex')).toBe(manual);
    await writeFile('main.tex', MAIN);
  });

  it('reports edit blocks that do not match the file instead of guessing', async () => {
    script = () => ({ chunks: ['<rs-edit file="main.tex"><rs-original>This sentence is not there.</rs-original><rs-proposed>x</rs-proposed><rs-reason>r</rs-reason></rs-edit>', '<rs-edit file="../secrets.tex"><rs-original>a</rs-original><rs-proposed>b</rs-proposed><rs-reason>r</rs-reason></rs-edit>'] });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Fix it' })).json<{ assistantMessage: ConversationMessage }>();
    const done = await finished(conv.id, assistantMessage.id);
    expect(done.editIssues).toEqual([
      { index: 0, problem: 'The text to replace was not found in main.tex.' },
      { index: 1, problem: '"../secrets.tex" is not a valid project path.' },
    ]);
    expect((await detail(conv.id)).proposals).toEqual([]);
  });

  it('marks proposals stale when the file changes and refuses to apply them', async () => {
    script = () => ({ chunks: ['<rs-edit file="main.tex"><rs-original>See \\ref{sec:a}.</rs-original><rs-proposed>See Section~\\ref{sec:a}.</rs-proposed><rs-reason>r</rs-reason></rs-edit>'] });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Improve' })).json<{ assistantMessage: ConversationMessage }>();
    await finished(conv.id, assistantMessage.id);
    const [proposal] = (await detail(conv.id)).proposals;
    await writeFile('main.tex', `${MAIN}% edited by the user\n`);
    await waitFor(async () => (await detail(conv.id)).proposals[0]!.status === 'stale');
    const res = await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/accept`), { body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('STALE_PROPOSAL');
    expect(await readProjectFile('main.tex')).toBe(`${MAIN}% edited by the user\n`);
    expect((await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/reject`))).json<{ proposal: EditProposal }>().proposal.status).toBe('rejected');
    await writeFile('main.tex', MAIN);
  });

  it('marks other pending proposals on the same file stale once one is accepted', async () => {
    script = () => ({
      chunks: [
        '<rs-edit file="main.tex"><rs-original>See \\ref{sec:a}.</rs-original><rs-proposed>See Section~\\ref{sec:a}.</rs-proposed><rs-reason>a</rs-reason></rs-edit>',
        '<rs-edit file="main.tex"><rs-original>\\section{A}</rs-original><rs-proposed>\\section{Analysis}</rs-proposed><rs-reason>b</rs-reason></rs-edit>',
      ],
    });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Improve both' })).json<{ assistantMessage: ConversationMessage }>();
    await finished(conv.id, assistantMessage.id);
    const [a, b] = (await detail(conv.id)).proposals;
    expect((await rt.request('POST', proj(`/ai/proposals/${a!.id}/accept`), { body: {} })).statusCode).toBe(200);
    await waitFor(async () => (await detail(conv.id)).proposals.find((p) => p.id === b!.id)!.status === 'stale');
    await writeFile('main.tex', MAIN);
  });

  it('cancels a streaming answer and keeps the partial text; one answer at a time', async () => {
    script = () => ({ chunks: ['Part one. ', 'Part two. ', 'Part three.'], delayMs: 300 });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Long answer please' })).json<{ assistantMessage: ConversationMessage }>();
    const busy = await send(conv.id, { text: 'Another' });
    expect(busy.statusCode).toBe(409);
    await waitFor(() => events.some((e) => e.type === 'ai.message.delta' && e.messageId === assistantMessage.id));
    const res = await rt.request('POST', proj(`/ai/messages/${assistantMessage.id}/cancel`));
    expect(res.json<{ message: ConversationMessage }>().message).toMatchObject({ status: 'cancelled', content: 'Part one. ' });
  });

  it('reports provider failures without leaking credentials', async () => {
    script = () => ({ chunks: ['Partial'], error: new ProviderError('rate-limit', `Rate limited for key ${API_KEY}`, 429) });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Hi' })).json<{ assistantMessage: ConversationMessage }>();
    const done = await finished(conv.id, assistantMessage.id);
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/Rate limited/);
    expect(done.error).not.toContain(API_KEY);
  });

  it('flags refusals and truncated answers', async () => {
    script = () => ({ chunks: ['No.'], stop: 'refusal' });
    const conv = await conversation();
    let m = (await send(conv.id, { text: 'Hi' })).json<{ assistantMessage: ConversationMessage }>().assistantMessage;
    expect(await finished(conv.id, m.id)).toMatchObject({ status: 'error', error: 'The model declined to answer this request.' });
    script = () => ({ chunks: ['Long'], stop: 'max-tokens' });
    m = (await send(conv.id, { text: 'Hi again' })).json<{ assistantMessage: ConversationMessage }>().assistantMessage;
    expect(await finished(conv.id, m.id)).toMatchObject({ status: 'truncated', error: expect.stringMatching(/output limit/) });
  });

  it('requires a selection for selection actions and validates context paths', async () => {
    const conv = await conversation();
    expect((await send(conv.id, { action: 'improve-wording' })).statusCode).toBe(400);
    expect((await send(conv.id, { text: 'x', context: { activeFile: '../outside.tex' } })).statusCode).toBe(400);
    const res = await send(conv.id, { text: 'x', context: { activeFile: 'main.tex', attachedFiles: ['C:/Windows/win.ini'] } });
    expect(res.statusCode).toBe(400);
  });
});

// --------------------------------------------------------------- isolation

describe('project isolation', () => {
  it('scopes conversations and proposals to their project', async () => {
    script = () => ({ chunks: ['<rs-edit file="main.tex"><rs-original>\\section{A}</rs-original><rs-proposed>\\section{B}</rs-proposed><rs-reason>r</rs-reason></rs-edit>'] });
    const conv = await conversation();
    const { assistantMessage } = (await send(conv.id, { text: 'Rename' })).json<{ assistantMessage: ConversationMessage }>();
    await finished(conv.id, assistantMessage.id);
    const [proposal] = (await detail(conv.id)).proposals;
    expect((await rt.request('GET', proj(`/ai/conversations/${conv.id}`, other.id))).statusCode).toBe(404);
    expect((await rt.request('POST', proj(`/ai/proposals/${proposal!.id}/accept`, other.id), { body: {} })).statusCode).toBe(404);
    expect((await rt.request('POST', proj(`/ai/messages/${assistantMessage.id}/cancel`, other.id))).statusCode).toBe(404);
    expect((await rt.request('GET', proj('/ai/proposals', other.id))).json()).toEqual({ proposals: [] });
    expect((await rt.request('GET', proj('/ai/conversations', 'doesnotexist1'))).statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ agents

describe('CLI agents', () => {
  it('lists agents with capabilities but no account details', async () => {
    const res = await rt.request('GET', api('/ai/agents'));
    const [agent] = res.json<{ agents: { id: string; available: boolean; auth: { state: string; method: string } }[] }>().agents;
    expect(agent).toMatchObject({ id: 'claude-code', available: true, auth: { state: 'authenticated', method: 'claude.ai' } });
    expect(res.body).not.toContain('example.com');
  });

  it('rejects model names that would read as command-line flags', async () => {
    const conv = await conversation('agent', 'claude-code');
    for (const model of ['--dangerously-skip-permissions', 'haiku --verbose']) {
      const res = await send(conv.id, { text: 'Hi', permission: 'read', model });
      expect(res.statusCode).toBe(400);
    }
    const create = await rt.request('POST', proj('/ai/conversations'), { body: { mode: 'agent', providerId: 'claude-code', model: '-x' } });
    expect(create.statusCode).toBe(400);
  });

  it('refuses to run an agent the project has not approved', async () => {
    const conv = await conversation('agent', 'claude-code');
    const res = await send(conv.id, { text: 'Look around', permission: 'read' });
    expect(res.statusCode).toBe(403);
    expect((await detail(conv.id)).messages).toEqual([]);
    const audit = (await rt.request('GET', api(`/audit?limit=50&projectId=${project.id}`))).json<{ events: { action: string; outcome: string }[] }>().events;
    expect(audit).toContainEqual(expect.objectContaining({ action: 'ai.agent.start', outcome: 'denied' }));
  });

  it('runs an approved agent on a staging copy and returns its edits as proposals', async () => {
    await writeFile('intro.tex', 'This is teh intro.\n');
    const approve = await rt.request('PUT', proj('/ai/agent-approvals'), { body: { agentId: 'claude-code', permission: 'write-staged', approved: true } });
    expect(approve.json<{ approvals: unknown[] }>().approvals).toEqual([{ agentId: 'claude-code', permission: 'write-staged', approvedAt: expect.any(String) }]);
    // Approval is per project and per profile.
    const conv = await conversation('agent', 'claude-code');
    expect((await send(conv.id, { text: 'EDIT intro', permission: 'read' })).statusCode).toBe(403);

    const res = await send(conv.id, { text: 'EDIT intro', permission: 'write-staged' });
    expect(res.statusCode).toBe(202);
    const { assistantMessage } = res.json<{ assistantMessage: ConversationMessage }>();
    const done = await finished(conv.id, assistantMessage.id);
    expect(done).toMatchObject({ status: 'complete', content: 'Reading done.', usage: { costUsd: 0.0123 } });
    const { proposals } = await detail(conv.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ file: 'intro.tex', changeType: 'modify', source: 'agent', original: 'This is teh intro.\n', proposed: 'This is the intro.\n' });
    // The project itself was not touched by the agent.
    expect(await readProjectFile('intro.tex')).toBe('This is teh intro.\n');
    // It edited the staging copy (its working directory, outside the project),
    // which is removed once the run's changes have become proposals.
    const staging = path.join(rt.config.dataDir, 'agent-workspaces', conv.id);
    expect(areDisjoint(project.rootPath, staging)).toBe(true);
    const activity = events.filter((e) => e.type === 'ai.agent.event' && e.conversationId === conv.id);
    const fileChanges = activity.flatMap((e) => (e.type === 'ai.agent.event' && e.activity?.kind === 'file-change' ? [e.activity.label] : []));
    expect(fileChanges).toEqual([expect.stringMatching(/ intro\.tex$/)]);
    expect(existsSync(staging)).toBe(false);
    expect((await detail(conv.id)).conversation).toBeTruthy();
    expect((await rt.request('POST', proj(`/ai/proposals/${proposals[0]!.id}/accept`), { body: {} })).statusCode).toBe(200);
    expect(await readProjectFile('intro.tex')).toBe('This is the intro.\n');

    // A follow-up turn resumes the agent's own session.
    const next = (await send(conv.id, { text: 'Anything else?', permission: 'write-staged' })).json<{ assistantMessage: ConversationMessage }>().assistantMessage;
    await finished(conv.id, next.id);
    const runs = (await rt.request('GET', proj(`/ai/conversations/${conv.id}`))).json<{ runs: { status: string; externalSessionId: string }[] }>().runs;
    expect(runs.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(runs[1]!.externalSessionId).toBe(runs[0]!.externalSessionId);
  });

  it('cancels a running agent', async () => {
    const conv = await conversation('agent', 'claude-code');
    const { assistantMessage } = (await send(conv.id, { text: 'SLOW', permission: 'write-staged' })).json<{ assistantMessage: ConversationMessage }>();
    await waitFor(() => events.some((e) => e.type === 'ai.message.delta' && e.messageId === assistantMessage.id && e.text === 'the file'));
    const res = await rt.request('POST', proj(`/ai/messages/${assistantMessage.id}/cancel`));
    expect(res.json<{ message: ConversationMessage }>().message.status).toBe('cancelled');
    const runs = (await rt.request('GET', proj(`/ai/conversations/${conv.id}`))).json<{ runs: { status: string }[] }>().runs;
    expect(runs[0]!.status).toBe('cancelled');
  });

  it('revoking approval stops further runs', async () => {
    await rt.request('PUT', proj('/ai/agent-approvals'), { body: { agentId: 'claude-code', permission: 'write-staged', approved: false } });
    const conv = await conversation('agent', 'claude-code');
    expect((await send(conv.id, { text: 'EDIT', permission: 'write-staged' })).statusCode).toBe(403);
  });
});
