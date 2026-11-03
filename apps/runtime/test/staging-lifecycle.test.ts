/**
 * Agent staging copies: recorded while in use, removed when their run ends,
 * swept when left behind, never removed while in use, never a way to delete
 * project files, and bounded in total size. Uses the fake Claude Code CLI.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '@research-studio/agent-adapters';
import { createAiRepositories, openAiDb, type AiRepositories } from '@research-studio/ai-storage';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { ConversationMessage, Project } from '@research-studio/shared-types';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeConfig } from '../src/config';
import type { AuditService } from '../src/services/audit-service';
import { StagingLifecycle } from '../src/services/ai/staging-lifecycle';
import { createTestRuntime } from './helpers';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/agent-adapters/test/fixtures/fake-claude.mjs', import.meta.url));
const registry = () => [new ClaudeCodeAgent({ configuredPath: FAKE_CLAUDE, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })];
const api = (p: string) => `/api/v1${p}`;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(config: Record<string, string> = {}) {
  const rt = await createTestRuntime({ agentRegistry: registry, config });
  const events: ServerEvent[] = [];
  rt.events.subscribe((e) => events.push(e));
  const project = (await rt.request('POST', api('/projects'), { body: { name: 'Staged', template: 'empty' } })).json<{ project: Project }>().project;
  const proj = (p: string) => api(`/projects/${project.id}${p}`);
  await rt.request('PUT', proj('/files/content'), { body: { path: 'main.tex', content: 'Hello.\n' } });
  await rt.request('PUT', proj('/ai/agent-approvals'), { body: { agentId: 'claude-code', permission: 'write-staged', approved: true } });
  const repos: AiRepositories = createAiRepositories(openAiDb(rt.db.sqlite));
  const root = path.join(rt.config.dataDir, 'agent-workspaces');

  const start = async (text: string) => {
    const conv = (await rt.request('POST', proj('/ai/conversations'), { body: { mode: 'agent', providerId: 'claude-code', model: null } })).json<{ conversation: { id: string } }>().conversation;
    const res = await rt.request('POST', proj(`/ai/conversations/${conv.id}/messages`), { body: { text, context: {}, permission: 'write-staged' } });
    expect(res.statusCode).toBe(202);
    return { conversationId: conv.id, messageId: res.json<{ assistantMessage: ConversationMessage }>().assistantMessage.id };
  };
  const finished = (conversationId: string, messageId: string) =>
    waitFor(async () =>
      (await rt.request('GET', proj(`/ai/conversations/${conversationId}`)))
        .json<{ messages: ConversationMessage[] }>()
        .messages.find((m) => m.id === messageId && m.status !== 'streaming'),
    );
  const audit = async () => (await rt.request('GET', api('/audit?limit=200'))).body;
  return { rt, events, project, proj, repos, root, start, finished, audit };
}

describe('agent staging lifecycle', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.rt.dispose());

  it('records a copy while its run uses it, never sweeps it then, and removes it when the run ends', async () => {
    const { rt, events, proj, repos, root, start, finished } = ctx;
    const { conversationId, messageId } = await start('SLOW');
    const dir = path.join(root, conversationId);
    await waitFor(() => events.some((e) => e.type === 'ai.agent.event' && e.conversationId === conversationId && e.activity?.label === 'Started'));
    const record = repos.staging.get(conversationId)!;
    expect(record).toMatchObject({ projectId: ctx.project.id, agentId: 'claude-code', state: 'active', files: 1, bytes: 7 });
    expect(Date.parse(record.createdAt)).not.toBeNaN();
    expect(Date.parse(record.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));

    // A sweep while the run is going leaves the copy alone.
    const swept = await rt.staging.sweep('scheduled');
    expect(swept.removed).not.toContain(conversationId);
    expect(swept.orphans).not.toContain(conversationId);
    expect(existsSync(path.join(dir, 'main.tex'))).toBe(true);

    await rt.request('POST', proj(`/ai/messages/${messageId}/cancel`));
    await finished(conversationId, messageId);
    expect(existsSync(dir)).toBe(false);
    expect(repos.staging.get(conversationId)).toBeNull();
    expect(await ctx.audit()).toMatch(/ai\.agent\.finish[\s\S]*"stagingRemoved":true/);
  });

  it('removes the copy after a completed run as well', async () => {
    const { conversationId, messageId } = await ctx.start('EDIT nothing');
    await ctx.finished(conversationId, messageId);
    expect(existsSync(path.join(ctx.root, conversationId))).toBe(false);
    expect(ctx.repos.staging.get(conversationId)).toBeNull();
  });

  it('sweeps copies left by a crash and directories nothing records, and audits it', async () => {
    const { rt, repos, root } = ctx;
    // A run that was interrupted by a crash: record still "active", files still there.
    repos.staging.activate({ sessionId: 'crashed-run-1', projectId: ctx.project.id, agentId: 'claude-code' });
    repos.staging.touch('crashed-run-1', { files: 1, bytes: 5 });
    await mkdir(path.join(root, 'crashed-run-1', 'sub'), { recursive: true });
    await writeFile(path.join(root, 'crashed-run-1', 'sub', 'a.tex'), 'stale');
    // A directory without a record (e.g. from an older version).
    await mkdir(path.join(root, 'orphan-dir'), { recursive: true });
    await writeFile(path.join(root, 'orphan-dir', 'b.tex'), 'old');

    const result = await rt.staging.sweep('startup');
    expect(result.removed).toEqual(['crashed-run-1']);
    expect(result.orphans).toEqual(['orphan-dir']);
    expect(result.failed).toEqual([]);
    expect(existsSync(path.join(root, 'crashed-run-1'))).toBe(false);
    expect(existsSync(path.join(root, 'orphan-dir'))).toBe(false);
    expect(repos.staging.list()).toEqual([]);
    const audit = await ctx.audit();
    expect(audit).toContain('ai.staging.cleanup');
    expect(audit).toMatch(/"reason":"startup","removed":1,"orphans":1,"failed":0,"bytes":5/);
  });

  it('never deletes project files through a link in the staging root', async () => {
    const { rt, repos, root, project } = ctx;
    await mkdir(root, { recursive: true });
    await symlink(project.rootPath, path.join(root, 'link-to-project'), 'junction');
    repos.staging.activate({ sessionId: 'recorded-link', projectId: project.id, agentId: 'claude-code' });
    await symlink(project.rootPath, path.join(root, 'recorded-link'), 'junction');

    const result = await rt.staging.sweep('scheduled');
    expect(result.orphans).toContain('link-to-project');
    expect(result.removed).toContain('recorded-link');
    expect(existsSync(path.join(root, 'link-to-project'))).toBe(false);
    expect(existsSync(path.join(root, 'recorded-link'))).toBe(false);
    expect(await readFile(path.join(project.rootPath, 'main.tex'), 'utf8')).toBe('Hello.\n');
  });

  it('removes a left-behind copy when its conversation is deleted', async () => {
    const { rt, repos, root, proj } = ctx;
    const conv = (await rt.request('POST', proj('/ai/conversations'), { body: { mode: 'agent', providerId: 'claude-code', model: null } })).json<{ conversation: { id: string } }>().conversation;
    repos.staging.activate({ sessionId: conv.id, projectId: ctx.project.id, agentId: 'claude-code' });
    repos.staging.release(conv.id, null);
    await mkdir(path.join(root, conv.id), { recursive: true });
    await writeFile(path.join(root, conv.id, 'main.tex'), 'copy');
    expect((await rt.request('DELETE', proj(`/ai/conversations/${conv.id}`))).statusCode).toBe(204);
    expect(existsSync(path.join(root, conv.id))).toBe(false);
    expect(repos.staging.get(conv.id)).toBeNull();
  });
});

describe('agent staging limits', () => {
  it('refuses a copy that would exceed the total staging budget', async () => {
    const ctx = await setup({ RS_AGENT_STAGING_MAX_BYTES: String(64 * 1024) });
    try {
      await ctx.rt.request('PUT', ctx.proj('/files/content'), { body: { path: 'big.tex', content: 'x'.repeat(100 * 1024) } });
      const { conversationId, messageId } = await ctx.start('EDIT nothing');
      const message = await ctx.finished(conversationId, messageId);
      expect(message.status).toBe('error');
      expect(message.error).toMatch(/too large to copy/);
      // The partial copy is gone too.
      expect(existsSync(path.join(ctx.root, conversationId))).toBe(false);
    } finally {
      await ctx.rt.dispose();
    }
  });

  it('refuses to run agents when the staging directory overlaps the workspace', () => {
    const quiet = { error: () => undefined, warn: () => undefined } as unknown as FastifyBaseLogger;
    const lifecycle = (dataDir: string, workspaceRoot: string) =>
      new StagingLifecycle({} as AiRepositories, { dataDir, workspaceRoot } as RuntimeConfig, {} as AuditService, quiet);
    expect(lifecycle('/srv/rs/data', '/srv/rs/projects').problem()).toBeNull();
    expect(lifecycle('/srv/rs/projects/data', '/srv/rs/projects').problem()).toMatch(/overlaps the project workspace/);
    expect(lifecycle('/srv/rs', '/srv/rs/agent-workspaces/x').problem()).toMatch(/overlaps/);
  });
});
