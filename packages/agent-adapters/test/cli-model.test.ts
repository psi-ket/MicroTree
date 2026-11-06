import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, type ModelRequest, type ModelStreamEvent, type StructuredOutputSpec } from '@research-studio/ai-core';
import { buildAgentEnvironment, CliModelProvider, renderConversation, type CliModelOptions } from '../src';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SECRET = 'forwarded-secret-value-123';

let tmp: string;
let work: string;
let log: string;
let pidFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rs-climodel-'));
  work = path.join(tmp, 'calls');
  log = path.join(tmp, 'log.jsonl');
  pidFile = path.join(tmp, 'pid');
});
afterEach(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

function provider(kind: 'claude-cli' | 'codex-cli', over: Partial<CliModelOptions> = {}): CliModelProvider {
  const fake = path.join(FIXTURES, kind === 'claude-cli' ? 'fake-claude-model.mjs' : 'fake-codex-model.mjs');
  const env = buildAgentEnvironment({ ...process.env, RS_SESSION_SECRET: 'never-forwarded' }, kind === 'claude-cli' ? 'claude-code' : 'codex', {
    allow: [],
    set: { FAKE_LOG: log, FAKE_PID_FILE: pidFile, FAKE_SECRET: SECRET },
  });
  return new CliModelProvider({ kind, executable: { command: process.execPath, prefixArgs: [fake] }, env: env.env, secrets: [SECRET], timeoutMs: 20_000, workRoot: work, ...over });
}

const req = (text: string, over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'default', system: 'Be brief.', messages: [{ role: 'user', content: text }], maxOutputTokens: 100, ...over });
const spec: StructuredOutputSpec<{ answer: string; images: number }> = {
  name: 'answer',
  jsonSchema: { type: 'object', properties: { answer: { type: 'string' }, images: { type: 'number' } }, required: ['answer', 'images'], additionalProperties: false },
  parse: (v) => {
    const o = v as { answer?: unknown; images?: unknown };
    if (typeof o.answer !== 'string' || typeof o.images !== 'number') throw new Error('bad');
    return { answer: o.answer, images: o.images };
  },
};

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function lastCall<T = Record<string, unknown>>(): Promise<T> {
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1)!) as T;
}

async function failure(p: Promise<unknown> | AsyncIterable<unknown>): Promise<ProviderError> {
  try {
    if (Symbol.asyncIterator in p) for await (const _ of p) void _;
    else await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a failure');
}

async function alive(): Promise<boolean> {
  const pid = Number(await readFile(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('renderConversation', () => {
  it('sends a single message as it is and earlier turns as marked context', () => {
    expect(renderConversation([{ role: 'user', content: 'Hi' }])).toEqual({ text: 'Hi', images: [] });
    const r = renderConversation([
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: PNG }] },
      { role: 'assistant', content: 'A diagram.' },
      { role: 'user', content: 'Redraw it' },
    ]);
    expect(r.images).toHaveLength(1);
    expect(r.text).toBe('<earlier_conversation>\n<user>\nLook\n\n[Image 1]\n</user>\n\n<assistant>\nA diagram.\n</assistant>\n</earlier_conversation>\n\nRedraw it');
  });
});

describe('Claude Code as a model', () => {
  it('runs with every tool off, its own system prompt and an empty folder, and streams the answer', async () => {
    const p = provider('claude-cli');
    const events = await collect(p.stream(req('Say hello', { model: 'sonnet' })));
    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')).toBe('Hello there.');
    expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 15, outputTokens: 7, cachedInputTokens: 10, costUsd: 0.001 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end', rawReason: 'end_turn', detail: null });

    const call = await lastCall<{ args: string[]; cwdEntries: string[]; env: string[]; system: string; message: unknown }>();
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--include-partial-messages']));
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('');
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(call.args.join(' ')).not.toMatch(/dangerously|bypassPermissions|--add-dir|--resume/);
    expect(call.system).toBe('Be brief.');
    expect(call.cwdEntries).toEqual([]);
    expect(call.env).not.toContain('RS_SESSION_SECRET');
    expect(call.message).toEqual({ role: 'user', content: [{ type: 'text', text: 'Say hello' }] });
    // The per-call folder is gone.
    expect(await readdir(work)).toEqual([]);
  });

  it('leaves the model to the CLI for "default"', async () => {
    await collect(provider('claude-cli').stream(req('hi')));
    expect((await lastCall<{ args: string[] }>()).args).not.toContain('--model');
  });

  it('returns structured answers through --json-schema, with images as content blocks', async () => {
    const r = await provider('claude-cli').generateStructured(req('', { messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: PNG }, { type: 'text', text: 'What is this?' }] }] }), spec);
    expect(r.value).toEqual({ answer: 'structured', images: 1 });
    const call = await lastCall<{ args: string[]; message: { content: { type: string; source?: { media_type: string; data: string } }[] } }>();
    expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]!)).toEqual(spec.jsonSchema);
    expect(call.args).not.toContain('--include-partial-messages');
    expect(call.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } });
  });

  it('refuses answers that do not match the schema', async () => {
    expect((await failure(provider('claude-cli').generateStructured(req('BADJSON'), spec))).message).toMatch(/expected answer format/);
  });

  it('stops the CLI and fails when it tries to use a tool', async () => {
    const err = await failure(provider('claude-cli').stream(req('TOOL')));
    expect(err.message).toMatch(/tried to use a tool \(Read\)/);
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
    expect(await readdir(work)).toEqual([]);
  });

  it('reports a signed-out CLI as an auth error without forwarded secrets', async () => {
    const err = await failure(provider('claude-cli').stream(req('AUTH')));
    expect(err.code).toBe('auth');
    expect(err.message).toMatch(/not signed in/);
    expect(err.message).not.toContain(SECRET);
  });

  it('cancels and times out by killing the CLI', async () => {
    const ac = new AbortController();
    const pending = failure(provider('claude-cli').stream(req('SLOW', { signal: ac.signal })));
    await expect.poll(() => readFile(pidFile, 'utf8').catch(() => ''), { timeout: 10_000 }).not.toBe('');
    ac.abort();
    expect((await pending).code).toBe('cancelled');
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
    expect((await failure(provider('claude-cli', { timeoutMs: 1500 }).stream(req('SLOW')))).code).toBe('timeout');
    expect(await readdir(work)).toEqual([]);
  });
});

describe('Codex as a model', () => {
  it('runs read-only with its tools disabled, outside the user config, and answers', async () => {
    const events = await collect(provider('codex-cli').stream(req('Say hello')));
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hello there.' },
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 4, cachedInputTokens: 3, costUsd: null } },
      { type: 'done', stopReason: 'end', rawReason: null, detail: null },
    ]);
    const call = await lastCall<{ args: string[]; cwdEntries: string[]; prompt: string; env: string[] }>();
    for (const f of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'plugins', 'view_image']) expect(call.args.join(' ')).toContain(`--disable ${f}`);
    expect(call.args).toEqual(expect.arrayContaining(['exec', '--json', '--ignore-user-config', '--ephemeral', 'approval_policy="never"', 'web_search="disabled"']));
    expect(call.args[call.args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(call.args.join(' ')).not.toMatch(/dangerously|workspace-write|full-access|--add-dir/);
    expect(call.cwdEntries).toEqual([]);
    expect(call.prompt).toBe('<instructions>\nBe brief.\n</instructions>\n\nSay hello');
    expect(call.env).not.toContain('RS_SESSION_SECRET');
    expect(await readdir(work)).toEqual([]);
  });

  it('passes images as files and the schema with --output-schema', async () => {
    const r = await provider('codex-cli').generateStructured(req('', { model: 'gpt-test', messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: PNG }, { type: 'text', text: 'What is this?' }] }] }), spec);
    expect(r.value).toEqual({ answer: 'structured', images: 1 });
    const call = await lastCall<{ args: string[]; images: { name: string; bytes: number; head: number[] }[]; schema: unknown; cwd: string }>();
    expect(call.images).toEqual([{ name: expect.stringMatching(/image-1\.png$/), bytes: PNG.length, head: [0x89, 0x50, 0x4e, 0x47] }]);
    // Image and schema files sit next to the working folder, not in it.
    expect(path.dirname(call.images[0]!.name)).toBe(path.dirname(call.cwd));
    expect(call.schema).toEqual(spec.jsonSchema);
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('gpt-test');
  });

  it('ignores notices but reports failed turns', async () => {
    expect((await provider('codex-cli').generateStructured(req('NOTICE'), spec)).value.answer).toBe('structured');
    const err = await failure(provider('codex-cli').stream(req('FAIL')));
    expect(err.code).toBe('rate-limit');
    expect(err.message).toMatch(/usage limit/);
  });

  it('stops Codex when it tries to run a command', async () => {
    const err = await failure(provider('codex-cli').stream(req('ACT')));
    expect(err.message).toMatch(/tried to act \(command_execution\)/);
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
    expect(await readdir(work)).toEqual([]);
  });

  it('lists only the CLI default as a model', async () => {
    expect(await provider('codex-cli').listModels()).toEqual([{ id: 'default', displayName: 'Codex default', contextTokens: null }]);
    expect((await provider('claude-cli').listModels()).map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  });
});
