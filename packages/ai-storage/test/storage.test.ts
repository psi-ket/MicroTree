import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createRepositories, type DatabaseHandle } from '@research-studio/database';
import { createAiRepositories, createSecretStore, FileSecretStore, keyringService, openAiDb, type AiRepositories } from '../src';

let handle: DatabaseHandle;
let ai: AiRepositories;

beforeEach(() => {
  handle = createDatabase(':memory:');
  ai = createAiRepositories(openAiDb(handle.sqlite));
  const core = createRepositories(handle.db);
  core.projects.create({ id: 'p1', name: 'A', slug: 'a', rootPath: '/w/a', mainFile: 'main.tex', engine: 'pdflatex' });
  core.projects.create({ id: 'p2', name: 'B', slug: 'b', rootPath: '/w/b', mainFile: 'main.tex', engine: 'pdflatex' });
});
afterEach(() => handle.close());

const proposal = (over: Partial<Parameters<AiRepositories['proposals']['create']>[0]> = {}) =>
  ai.proposals.create({
    id: 'pr1',
    projectId: 'p1',
    conversationId: null,
    messageId: 'm1',
    agentRunId: null,
    source: 'model',
    action: 'concise',
    blockIndex: 0,
    file: 'main.tex',
    changeType: 'modify',
    baseHash: 'h1',
    original: 'old',
    proposed: 'new',
    range: { start: 3, end: 6 },
    explanation: 'shorter',
    warnings: [],
    ...over,
  });

describe('migrations', () => {
  it('creates the AI tables with their own migration history and is idempotent', () => {
    const tables = handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%' ORDER BY name").all();
    expect(tables.map((t) => (t as { name: string }).name)).toEqual([
      'ai_agent_approvals',
      'ai_agent_runs',
      'ai_conversations',
      'ai_messages',
      'ai_proposals',
      'ai_providers',
      'ai_staging_workspaces',
    ]);
    expect(handle.sqlite.prepare("SELECT count(*) AS n FROM __ai_migrations").get()).toEqual({ n: 3 });
    const messageColumns = handle.sqlite.prepare('PRAGMA table_info(ai_messages)').all().map((c) => (c as { name: string }).name);
    expect(messageColumns).toContain('finish_reason');
    const conversationColumns = handle.sqlite.prepare('PRAGMA table_info(ai_conversations)').all().map((c) => (c as { name: string }).name);
    expect(conversationColumns).toContain('archived_at');
    expect(() => openAiDb(handle.sqlite)).not.toThrow();
  });

  it('never stores secrets in the providers table', () => {
    const cols = handle.sqlite.prepare('PRAGMA table_info(ai_providers)').all().map((c) => (c as { name: string }).name);
    expect(cols).toContain('secret_ref');
    expect(cols.some((c) => /key|secret_value|token|password/i.test(c))).toBe(false);
  });
});

describe('repositories', () => {
  it('scopes conversations and proposals by project', () => {
    const c = ai.conversations.create({ id: 'c1', projectId: 'p1', mode: 'model', providerId: 'prov', model: 'm', title: 'T' });
    expect(ai.conversations.get('p1', c.id)).toMatchObject({ id: 'c1' });
    expect(ai.conversations.get('p2', c.id)).toBeNull();
    expect(ai.conversations.delete('p2', c.id)).toBe(false);
    proposal();
    expect(ai.proposals.get('p2', 'pr1')).toBeNull();
    expect(ai.proposals.list('p2')).toEqual([]);
    expect(ai.proposals.transition('p2', 'pr1', 'pending', 'accepted')).toBeNull();
  });

  it('orders messages and records status updates', () => {
    ai.conversations.create({ id: 'c1', projectId: 'p1', mode: 'model', providerId: 'prov', model: 'm', title: 'T' });
    ai.messages.append({ id: 'm1', conversationId: 'c1', role: 'user', action: 'chat', content: 'Hi', status: 'complete', context: [] });
    ai.messages.append({ id: 'm2', conversationId: 'c1', role: 'assistant', action: 'chat', content: '', status: 'streaming', context: [{ kind: 'selection', label: 'x', chars: 3, truncated: false }] });
    ai.messages.update('m2', { content: 'Hello', status: 'complete', usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: null, costUsd: null } });
    expect(ai.messages.list('c1').map((m) => [m.id, m.status])).toEqual([['m1', 'complete'], ['m2', 'complete']]);
    ai.messages.append({ id: 'm3', conversationId: 'c1', role: 'assistant', action: null, content: '', status: 'streaming', context: [] });
    expect(ai.messages.failInterrupted('restarted')).toBe(1);
    expect(ai.messages.get('m3')).toMatchObject({ status: 'error', error: 'restarted' });
  });

  it('transitions proposals exactly once', () => {
    proposal();
    expect(ai.proposals.transition('p1', 'pr1', 'pending', 'accepted', { appliedHash: 'h2', previousContent: 'full old' })).toMatchObject({ status: 'accepted', appliedHash: 'h2' });
    expect(ai.proposals.transition('p1', 'pr1', 'pending', 'rejected')).toBeNull();
    expect(ai.proposals.previousContent('p1', 'pr1')).toBe('full old');
    expect(ai.proposals.get('p1', 'pr1')).toMatchObject({ range: { start: 3, end: 6 }, resolvedAt: expect.any(String) });
  });

  it('marks pending proposals on a changed file as stale', () => {
    proposal({ id: 'a', baseHash: 'h1' });
    proposal({ id: 'b', baseHash: 'h2' });
    proposal({ id: 'c', baseHash: 'h1', file: 'other.tex' });
    const stale = ai.proposals.markStale('p1', 'main.tex', 'h2');
    expect(stale.map((p) => p.id)).toEqual(['a']);
    expect(ai.proposals.get('p1', 'a')!.status).toBe('stale');
    expect(ai.proposals.get('p1', 'b')!.status).toBe('pending');
    expect(ai.proposals.get('p1', 'c')!.status).toBe('pending');
  });

  it('removes a project’s AI data when the project is deleted', () => {
    ai.conversations.create({ id: 'c1', projectId: 'p1', mode: 'agent', providerId: 'claude-code', model: null, title: 'T' });
    ai.messages.append({ id: 'm1', conversationId: 'c1', role: 'user', action: 'chat', content: 'Hi', status: 'complete', context: [] });
    ai.agentRuns.create({ id: 'r1', projectId: 'p1', conversationId: 'c1', messageId: 'm1', agentId: 'claude-code', permission: 'read', model: null });
    proposal();
    ai.approvals.set('p1', 'codex', 'read', true);
    createRepositories(handle.db).projects.delete('p1');
    for (const table of ['ai_conversations', 'ai_messages', 'ai_agent_runs', 'ai_proposals', 'ai_agent_approvals']) {
      expect(handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('records agent approvals per project and permission profile', () => {
    expect(ai.approvals.isApproved('p1', 'claude-code', 'read')).toBe(false);
    ai.approvals.set('p1', 'claude-code', 'read', true);
    ai.approvals.set('p1', 'claude-code', 'read', true);
    expect(ai.approvals.isApproved('p1', 'claude-code', 'read')).toBe(true);
    expect(ai.approvals.isApproved('p1', 'claude-code', 'write-staged')).toBe(false);
    expect(ai.approvals.isApproved('p2', 'claude-code', 'read')).toBe(false);
    expect(ai.approvals.list('p1')).toEqual([{ agentId: 'claude-code', permission: 'read', approvedAt: expect.any(String) }]);
    ai.approvals.set('p1', 'claude-code', 'read', false);
    expect(ai.approvals.list('p1')).toEqual([]);
  });

  it('stores a message’s finish reason and the new completion statuses', () => {
    ai.conversations.create({ id: 'c1', projectId: 'p1', mode: 'model', providerId: 'prov', model: 'm', title: 'T' });
    const m = ai.messages.append({ id: 'm1', conversationId: 'c1', role: 'assistant', action: null, content: '', status: 'streaming', context: [] });
    expect(m.finishReason).toBeNull();
    ai.messages.update('m1', { status: 'truncated', finishReason: 'max_tokens', content: 'cut off' });
    expect(ai.messages.get('m1')).toMatchObject({ status: 'truncated', finishReason: 'max_tokens', content: 'cut off' });
  });

  it('tracks staging copies independently of conversations and projects', () => {
    const created = ai.staging.activate({ sessionId: 's1', projectId: 'p1', agentId: 'claude-code' });
    expect(created).toMatchObject({ state: 'active', bytes: 0, files: 0 });
    ai.staging.touch('s1', { files: 3, bytes: 120 });
    ai.staging.release('s1', null);
    expect(ai.staging.get('s1')).toMatchObject({ state: 'idle', files: 3, bytes: 120, createdAt: created.createdAt });
    ai.staging.activate({ sessionId: 's1', projectId: 'p1', agentId: 'claude-code' });
    ai.staging.activate({ sessionId: 's2', projectId: 'p2', agentId: 'codex' });
    expect(ai.staging.releaseAll()).toBe(2);
    // The record outlives its project, so the cleanup can still find the copy.
    handle.sqlite.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    expect(ai.staging.list().map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
    ai.staging.delete('s1');
    expect(ai.staging.get('s1')).toBeNull();
  });

  it('marks interrupted agent runs as failed', () => {
    ai.conversations.create({ id: 'c1', projectId: 'p1', mode: 'agent', providerId: 'codex', model: null, title: 'T' });
    ai.agentRuns.create({ id: 'r1', projectId: 'p1', conversationId: 'c1', messageId: 'm1', agentId: 'codex', permission: 'write-staged', model: null });
    expect(ai.agentRuns.failInterrupted('stopped')).toBe(1);
    expect(ai.agentRuns.get('p1', 'r1')).toMatchObject({ status: 'failed', error: 'stopped' });
    expect(ai.agentRuns.get('p2', 'r1')).toBeNull();
  });
});

describe('secret stores', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rs-secrets-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('memory store keeps values for the process only', async () => {
    const store = await createSecretStore('memory', dir);
    await store.set('provider:a', 'sk-1');
    expect(await store.get('provider:a')).toBe('sk-1');
    await store.delete('provider:a');
    expect(await store.get('provider:a')).toBeNull();
    expect(store.notice).toMatch(/memory/);
  });

  it('file store persists with owner-only permissions', async () => {
    const store = await createSecretStore('file', dir);
    expect(store).toBeInstanceOf(FileSecretStore);
    await Promise.all([store.set('a', '1'), store.set('b', '2'), store.set('c', '3')]);
    expect(JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8'))).toEqual({ a: '1', b: '2', c: '3' });
    if (process.platform !== 'win32') expect((await stat(path.join(dir, 'secrets.json'))).mode & 0o077).toBe(0);
    await store.delete('b');
    expect(await (await createSecretStore('file', dir)).get('b')).toBeNull();
  });

  it('uses a separate keyring service per data directory', () => {
    expect(keyringService('/a')).not.toBe(keyringService('/b'));
    expect(keyringService('/a')).toMatch(/^research-studio\/[0-9a-f]{10}$/);
  });

  // Touches the real OS credential store, so it only runs when asked to.
  it.runIf(process.env.RS_TEST_KEYRING === '1')('round-trips through the OS credential store', async () => {
    const store = await createSecretStore('keyring', dir);
    expect(store.kind).toBe('keyring');
    await store.set('provider:test', 'sk-keyring-roundtrip');
    expect(await store.get('provider:test')).toBe('sk-keyring-roundtrip');
    await store.delete('provider:test');
    expect(await store.get('provider:test')).toBeNull();
  });
});
