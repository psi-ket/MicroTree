/**
 * How a model answer ends decides whether it may propose edits. These tests go
 * through the real OpenAI and Anthropic adapters (and their SDKs) against a
 * local mock of both APIs; the model name picks how the mock ends the stream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { Conversation, ConversationMessage, EditProposal, Project, ProviderConfigView } from '@research-studio/shared-types';
import { MockProviderServer } from '../../../packages/model-adapters/test/mock-server';
import { createTestRuntime, type TestRuntime } from './helpers';

const server = new MockProviderServer();
let rt: TestRuntime;
let project: Project;
const providers: Record<'openai' | 'anthropic', ProviderConfigView> = {} as never;
const events: ServerEvent[] = [];

const api = (p: string) => `/api/v1${p}`;
const proj = (p: string) => api(`/projects/${project.id}${p}`);

const MAIN = '\\documentclass{article}\n\\begin{document}\nWe show that teh method converges.\n\\end{document}\n';
const EDIT = '<rs-edit file="main.tex">\n<rs-original>\nteh method\n</rs-original>\n<rs-proposed>\nthe method\n</rs-proposed>\n<rs-reason>Typo.</rs-reason>\n</rs-edit>';
const ANSWER = ['Fixed the typo.\n', EDIT.slice(0, 60), EDIT.slice(60)];

beforeAll(async () => {
  const root = await server.start();
  rt = await createTestRuntime({ env: {} });
  rt.events.subscribe((e) => events.push(e));
  for (const kind of ['openai', 'anthropic'] as const) {
    const res = await rt.request('POST', api('/ai/providers'), {
      body: { kind, displayName: kind, baseUrl: kind === 'openai' ? `${root}/v1` : root, apiKey: 'sk-test-completion-0123456789' },
    });
    expect(res.statusCode).toBe(201);
    providers[kind] = res.json<{ provider: ProviderConfigView }>().provider;
  }
  project = (await rt.request('POST', api('/projects'), { body: { name: 'Endings', template: 'empty' } })).json<{ project: Project }>().project;
  await rt.request('PUT', proj('/files/content'), { body: { path: 'main.tex', content: MAIN } });
});
afterAll(async () => {
  await rt.dispose();
  await server.stop();
});

async function detail(conversationId: string) {
  return (await rt.request('GET', proj(`/ai/conversations/${conversationId}`))).json<{ messages: ConversationMessage[]; proposals: EditProposal[] }>();
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function conversation(kind: 'openai' | 'anthropic', model: string): Promise<Conversation> {
  const res = await rt.request('POST', proj('/ai/conversations'), { body: { mode: 'model', providerId: providers[kind].id, model } });
  expect(res.statusCode).toBe(201);
  return res.json<{ conversation: Conversation }>().conversation;
}

async function start(conv: Conversation, text = 'Fix the typo.'): Promise<string> {
  const res = await rt.request('POST', proj(`/ai/conversations/${conv.id}/messages`), { body: { text, context: { activeFile: 'main.tex' } } });
  expect(res.statusCode).toBe(202);
  return res.json<{ assistantMessage: ConversationMessage }>().assistantMessage.id;
}

/** Ask once and wait for the answer to end; returns the answer and its proposals. */
async function ask(kind: 'openai' | 'anthropic', model: string) {
  server.reply = ANSWER;
  const conv = await conversation(kind, model);
  const id = await start(conv);
  const message = await waitFor(async () => (await detail(conv.id)).messages.find((m) => m.id === id && m.status !== 'streaming'));
  const proposals = (await detail(conv.id)).proposals.filter((p) => p.messageId === id);
  return { conv, message, proposals };
}

describe('model answers and edit proposals', () => {
  it('OpenAI: a normal finish (stop) creates a proposal', async () => {
    const { message, proposals } = await ask('openai', 'ok');
    expect(message).toMatchObject({ status: 'complete', finishReason: 'stop', error: null, editIssues: [] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ file: 'main.tex', original: 'teh method', proposed: 'the method', status: 'pending' });
  });

  it('OpenAI: finish_reason length creates no proposal and explains why', async () => {
    const { message, proposals } = await ask('openai', 'length');
    expect(message).toMatchObject({ status: 'truncated', finishReason: 'length' });
    expect(message.error).toMatch(/output limit/);
    expect(proposals).toHaveLength(0);
    expect(message.editIssues).toEqual([{ index: 0, problem: expect.stringMatching(/cut off/) }]);
  });

  it('Anthropic: a normal finish (end_turn) creates a proposal', async () => {
    const { message, proposals } = await ask('anthropic', 'ok');
    expect(message).toMatchObject({ status: 'complete', finishReason: 'end_turn', error: null });
    expect(proposals).toHaveLength(1);
  });

  it('Anthropic: stop_reason max_tokens creates no proposal', async () => {
    const { message, proposals } = await ask('anthropic', 'length');
    expect(message).toMatchObject({ status: 'truncated', finishReason: 'max_tokens' });
    expect(proposals).toHaveLength(0);
  });

  it('an unrecognised or missing finish reason is incomplete and creates no proposal', async () => {
    const paused = await ask('anthropic', 'pause');
    expect(paused.message).toMatchObject({ status: 'incomplete', finishReason: 'pause_turn' });
    expect(paused.proposals).toHaveLength(0);
    const unfinished = await ask('openai', 'nofinish');
    expect(unfinished.message).toMatchObject({ status: 'incomplete', finishReason: null });
    expect(unfinished.message.error).toMatch(/no finish reason/);
    expect(unfinished.proposals).toHaveLength(0);
  });

  it('a cancelled answer creates no proposal', async () => {
    server.reply = [`Fixed.\n${EDIT}`, ' more'];
    const conv = await conversation('anthropic', 'slow');
    const id = await start(conv);
    // The first chunk (with a complete edit block) has been streamed; then stop.
    await waitFor(async () => events.some((e) => e.type === 'ai.message.delta' && e.messageId === id && e.text.includes('</rs-edit>')));
    expect((await rt.request('POST', proj(`/ai/messages/${id}/cancel`))).statusCode).toBe(200);
    const message = await waitFor(async () => (await detail(conv.id)).messages.find((m) => m.id === id && m.status !== 'streaming'));
    expect(message.status).toBe('cancelled');
    expect(message.content).toContain('</rs-edit>');
    expect((await detail(conv.id)).proposals.filter((p) => p.messageId === id)).toHaveLength(0);
  });

  it('a provider failure creates no proposal', async () => {
    const failed = await ask('openai', 'error-401');
    expect(failed.message.status).toBe('error');
    expect(failed.message.error).not.toContain('sk-test-completion');
    expect(failed.proposals).toHaveLength(0);
    // The connection drops after the edit block was streamed.
    const dropped = await ask('anthropic', 'drop');
    expect(['error', 'incomplete']).toContain(dropped.message.status);
    expect(dropped.message.content).toContain('</rs-edit>');
    expect(dropped.proposals).toHaveLength(0);
  });

  it('rejects malformed edit blocks in a completed answer', async () => {
    server.reply = ['Two tries.\n', '<rs-edit file="main.tex"><rs-original>teh</rs-original><rs-original>x</rs-original><rs-proposed>the</rs-proposed></rs-edit>\n', '<rs-edit file="main.tex">\n<rs-original>\nteh method'];
    const conv = await conversation('openai', 'ok');
    const id = await start(conv);
    const message = await waitFor(async () => (await detail(conv.id)).messages.find((m) => m.id === id && m.status !== 'streaming'));
    expect(message.status).toBe('complete');
    expect(message.editIssues).toEqual([
      { index: 0, problem: expect.stringMatching(/more than one <rs-original>/) },
      { index: 1, problem: expect.stringMatching(/not closed/) },
    ]);
    expect((await detail(conv.id)).proposals.filter((p) => p.messageId === id)).toHaveLength(0);
  });

  it('keeps a truncated answer readable in the conversation, but does not send it back to the model', async () => {
    const { conv, message } = await ask('openai', 'length');
    const stored = (await detail(conv.id)).messages.find((m) => m.id === message.id)!;
    expect(stored.content).toBe(ANSWER.join(''));
    server.reply = ['Sure.'];
    const before = server.requests.length;
    const next = await start(conv, 'Try again.');
    await waitFor(async () => (await detail(conv.id)).messages.find((m) => m.id === next && m.status !== 'streaming'));
    const sent = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions')!;
    const history = JSON.stringify((sent.body as { messages: unknown[] }).messages);
    expect(history).not.toContain('Fixed the typo.');
    expect(history).toContain('Try again.');
  });
});
