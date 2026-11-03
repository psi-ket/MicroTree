/**
 * Agent credential isolation through the runtime: which provider keys reach a
 * CLI agent, and that forwarded keys never reach the UI, the database or the
 * audit log. Uses the fake Claude Code CLI; no real agent or key is involved.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '@research-studio/agent-adapters';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { ConversationMessage, Project } from '@research-studio/shared-types';
import { createTestRuntime, type TestRuntime } from './helpers';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/agent-adapters/test/fixtures/fake-claude.mjs', import.meta.url));
const ANTHROPIC_KEY = 'sk-ant-runtime-key-0123456789abcdef';
const OPENAI_KEY = 'sk-openai-runtime-key-0123456789abcdef';

let rt: TestRuntime;
let project: Project;
const events: ServerEvent[] = [];
const api = (p: string) => `/api/v1${p}`;
const proj = (p: string) => api(`/projects/${project.id}${p}`);

beforeAll(async () => {
  rt = await createTestRuntime({
    env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    agentRegistry: () => [new ClaudeCodeAgent({ configuredPath: FAKE_CLAUDE, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })],
  });
  rt.events.subscribe((e) => events.push(e));
  project = (await rt.request('POST', api('/projects'), { body: { name: 'Keys', template: 'empty' } })).json<{ project: Project }>().project;
  await rt.request('PUT', proj('/ai/agent-approvals'), { body: { agentId: 'claude-code', permission: 'read', approved: true } });
});
afterAll(() => rt.dispose());

async function runLeakyAgent(): Promise<{ message: ConversationMessage; everything: string }> {
  const conv = (await rt.request('POST', proj('/ai/conversations'), { body: { mode: 'agent', providerId: 'claude-code', model: null } })).json<{ conversation: { id: string } }>().conversation;
  const res = await rt.request('POST', proj(`/ai/conversations/${conv.id}/messages`), { body: { text: 'LEAK', context: {}, permission: 'read' } });
  expect(res.statusCode).toBe(202);
  const { assistantMessage } = res.json<{ assistantMessage: ConversationMessage }>();
  const deadline = Date.now() + 20_000;
  let detail: { messages: ConversationMessage[] } & Record<string, unknown>;
  for (;;) {
    detail = (await rt.request('GET', proj(`/ai/conversations/${conv.id}`))).json();
    if (detail.messages.find((m) => m.id === assistantMessage.id)?.status !== 'streaming') break;
    if (Date.now() > deadline) throw new Error('agent did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
  const audit = (await rt.request('GET', api(`/audit?limit=200&projectId=${project.id}`))).body;
  const agents = (await rt.request('GET', api('/ai/agents'))).body;
  return {
    message: detail.messages.find((m) => m.id === assistantMessage.id)!,
    everything: [JSON.stringify(events), JSON.stringify(detail), audit, agents].join('\n'),
  };
}

describe('agent credential isolation', () => {
  it('does not give Claude Code any provider key by default', async () => {
    const { message, everything } = await runLeakyAgent();
    expect(message.status).toBe('complete');
    expect(message.content).toContain('key: undefined');
    expect(everything).not.toContain(ANTHROPIC_KEY);
    expect(everything).not.toContain(OPENAI_KEY);
  });

  it('forwards a key the operator allowed, and redacts it from activity, answers, runs and the audit log', async () => {
    await writeFile(
      path.join(rt.config.dataDir, 'agents.json'),
      JSON.stringify({ environment: { 'claude-code': { allow: ['ANTHROPIC_API_KEY'] } } }),
    );
    await rt.request('GET', api('/ai/agents?refresh=1'));
    events.length = 0;
    const { message, everything } = await runLeakyAgent();
    expect(message.status).toBe('complete');
    // The agent did receive the key (it printed it), but nothing shows it.
    expect(message.content).toContain('key: [redacted]');
    expect(everything).toContain('debug ANTHROPIC_API_KEY=[redacted]');
    expect(everything).not.toContain(ANTHROPIC_KEY);
    // The key split across two streamed chunks is not reassemblable either.
    const streamed = events.flatMap((e) => (e.type === 'ai.message.delta' ? [e.text] : [])).join('');
    expect(streamed).not.toContain(ANTHROPIC_KEY);
    expect(streamed).not.toContain(ANTHROPIC_KEY.slice(8));
    // OpenAI's key was not allowed, so Claude Code never had it.
    expect(everything).not.toContain(OPENAI_KEY);
  });

  it('ignores an agents file that tries to forward runtime secrets', async () => {
    await writeFile(path.join(rt.config.dataDir, 'agents.json'), JSON.stringify({ environment: { 'claude-code': { allow: ['RS_PAIRING_TOKEN', 'ANTHROPIC_API_KEY'] } } }));
    await rt.request('GET', api('/ai/agents?refresh=1'));
    const { message } = await runLeakyAgent();
    // The whole file is rejected, so the default policy (no keys) applies.
    expect(message.content).toContain('key: undefined');
  });
});
