import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunOptions } from '@research-studio/ai-core';
import { buildAgentEnvironment, ClaudeCodeAgent, CodexAgent, CustomAgent, fromConfiguredPath, parseAgentsFile, spawnLines, StagingWorkspace } from '../src';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');

let tmp: string;
let work: string;
let log: string;
let pidFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rs-agents-'));
  work = path.join(tmp, 'stage');
  await mkdir(work);
  await writeFile(path.join(work, 'intro.tex'), 'This is teh intro.\n');
  log = path.join(tmp, 'log.jsonl');
  pidFile = path.join(tmp, 'pid');
});
afterEach(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

const env = () => buildAgentEnvironment(process.env, 'claude-code', { allow: [], set: { FAKE_LOG: log, FAKE_PID_FILE: pidFile } }).env;
const opts = (over: Partial<AgentRunOptions> = {}): AgentRunOptions => ({
  prompt: 'Fix the intro',
  workingDirectory: work,
  permission: 'read',
  model: null,
  resumeSessionId: null,
  timeoutMs: 20_000,
  env: env(),
  ...over,
});

async function collect(events: AsyncIterable<AgentEvent>, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
    onEvent?.(e);
  }
  return out;
}

async function lastInvocation(): Promise<{ args: string[]; cwd: string; env: string[] }> {
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1)!) as { args: string[]; cwd: string; env: string[] };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const done = (events: AgentEvent[]) => events.at(-1) as Extract<AgentEvent, { type: 'done' }>;

describe('process supervision', () => {
  it('kills the process on timeout and when the consumer stops early', async () => {
    const exe = { command: process.execPath, prefixArgs: ['-e', 'console.log("a");console.log("b");setInterval(()=>{},1000)'] };
    const events = [];
    for await (const e of spawnLines({ executable: exe, args: [], cwd: tmp, env: {}, stdin: null, timeoutMs: 1_500 })) events.push(e);
    expect(events.filter((e) => e.type === 'stdout').map((e) => (e as { line: string }).line)).toEqual(['a', 'b']);
    expect(events.at(-1)).toMatchObject({ type: 'exit', timedOut: true });

    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('x'); setInterval(()=>{},1000)`;
    for await (const e of spawnLines({ executable: { command: process.execPath, prefixArgs: ['-e', script] }, args: [], cwd: tmp, env: {}, stdin: null, timeoutMs: 30_000 })) {
      if (e.type === 'stdout') break;
    }
    const pid = Number(await readFile(pidFile, 'utf8'));
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  });

  it('refuses relative paths and batch files', async () => {
    await expect(spawnLines({ executable: { command: 'node', prefixArgs: [] }, args: [], cwd: tmp, env: {}, stdin: null, timeoutMs: 1000 }).next()).rejects.toThrow(/absolute/);
    expect(await fromConfiguredPath('claude')).toMatchObject({ problem: expect.stringMatching(/absolute/) });
    if (process.platform === 'win32') {
      const bat = path.join(tmp, 'x.cmd');
      await writeFile(bat, '@echo off');
      expect(await fromConfiguredPath(bat)).toMatchObject({ problem: expect.stringMatching(/Batch/) });
    }
  });

  it('passes agents only what they need from the environment', () => {
    const { env: e } = buildAgentEnvironment(
      { PATH: '/bin', Path: 'C:/x', HOME: '/h', RS_PAIRING_TOKEN: 'secret', RS_DATA_DIR: '/d', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'k', CODEX_HOME: '/c', npm_config_user_agent: 'pnpm' },
      'codex',
    );
    expect(Object.keys(e).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'Path']);
  });
});

describe('Claude Code adapter', () => {
  const agent = () => new ClaudeCodeAgent({ configuredPath: FAKE_CLAUDE, env: env() });

  it('detects the executable, version and login method without exposing account details', async () => {
    const a = agent();
    expect(await a.detect()).toMatchObject({ available: true, version: '2.1.316', executable: { command: process.execPath, prefixArgs: [FAKE_CLAUDE] } });
    const auth = await a.authStatus();
    expect(auth).toEqual({ state: 'authenticated', method: 'claude.ai', detail: null });
    expect(JSON.stringify(auth)).not.toContain('example.com');
    expect(await new ClaudeCodeAgent({ configuredPath: path.join(tmp, 'missing.exe'), env: env() }).detect()).toMatchObject({ available: false });
  });

  it('restricts tools per permission profile and never enables shell or web tools', () => {
    const read = ClaudeCodeAgent.args({ permission: 'read', model: null, resumeSessionId: null });
    const write = ClaudeCodeAgent.args({ permission: 'write-staged', model: 'sonnet', resumeSessionId: 'abc' });
    const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    expect(value(read, '--tools')).toBe('Read,Glob,Grep');
    expect(value(read, '--permission-mode')).toBe('dontAsk');
    expect(value(write, '--tools')).toBe('Read,Glob,Grep,Edit,Write');
    expect(value(write, '--permission-mode')).toBe('acceptEdits');
    for (const args of [read, write]) {
      expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '-p']));
      expect(value(args, '--permission-prompts')).toBe('none');
      expect(value(args, '--tools')).not.toMatch(/Bash|PowerShell|WebFetch|WebSearch/);
      expect(args).not.toContain('bypassPermissions');
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
    expect(value(write, '--resume')).toBe('abc');
    expect(value(write, '--model')).toBe('sonnet');
  });

  it('streams session, text, tool activity, usage and the final result', async () => {
    const events = await collect(agent().run(opts({ prompt: 'EDIT please', permission: 'write-staged' })));
    expect(events[0]).toEqual({ type: 'session', sessionId: '11111111-2222-3333-4444-555555555555', model: 'claude-test' });
    const text = events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('');
    expect(text).toBe('Reading done.'); // sub-agent text excluded
    expect(events).toContainEqual({ type: 'tool', name: 'Edit', detail: 'intro.tex', phase: 'started' });
    expect(events).toContainEqual({ type: 'tool', name: 'Edit', detail: null, phase: 'completed' });
    expect(events).toContainEqual({ type: 'file-change', path: 'intro.tex', change: 'update' });
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 90, costUsd: 0.0123 } });
    expect(done(events)).toEqual({ type: 'done', status: 'completed', result: 'Reading done.', error: null });
    const call = await lastInvocation();
    expect(path.resolve(call.cwd)).toBe(path.resolve(work));
    expect(call.env.some((k) => k.toUpperCase().startsWith('RS_'))).toBe(false);
    expect(call.args).not.toContain('EDIT please'); // the prompt goes through stdin
  });

  it('resumes a session and reports failures, crashes and permission denials', async () => {
    const resumed = await collect(agent().run(opts({ resumeSessionId: 'prev-session' })));
    expect(resumed[0]).toMatchObject({ type: 'session', sessionId: 'prev-session' });
    expect(done(await collect(agent().run(opts({ prompt: 'FAIL' }))))).toMatchObject({ status: 'failed', error: expect.stringMatching(/error_during_execution/) });
    expect(done(await collect(agent().run(opts({ prompt: 'CRASH' }))))).toMatchObject({ status: 'failed', error: expect.stringMatching(/something broke/) });
    expect(done(await collect(agent().run(opts({ prompt: 'DENY' }))))).toMatchObject({ status: 'completed', error: 'Denied by permissions: Bash' });
  });

  it('cancels a running agent and kills its process', async () => {
    const controller = new AbortController();
    const events = await collect(agent().run(opts({ prompt: 'SLOW', signal: controller.signal })), (e) => {
      if (e.type === 'text-delta' && e.text === 'the file') controller.abort();
    });
    expect(done(events)).toMatchObject({ status: 'cancelled' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  });

  it('stops an agent that exceeds its time limit', async () => {
    const events = await collect(agent().run(opts({ prompt: 'SLOW', timeoutMs: 1_500 })));
    expect(done(events)).toMatchObject({ status: 'timed-out' });
  });
});

describe('Codex adapter', () => {
  const agent = () => new CodexAgent({ configuredPath: FAKE_CODEX, env: env() });

  it('detects version and login', async () => {
    expect(await agent().detect()).toMatchObject({ available: true, version: '0.163.0' });
    expect(await agent().authStatus()).toEqual({ state: 'authenticated', method: 'ChatGPT', detail: null });
    const out = new CodexAgent({ configuredPath: FAKE_CODEX, env: { ...env(), FAKE_LOGGED_OUT: '1' } });
    expect((await out.authStatus()).state).toBe('unauthenticated');
  });

  it('maps permission profiles to Codex sandboxes with network disabled', () => {
    const a = agent();
    const read = a.args({ permission: 'read', model: null, resumeSessionId: null, workingDirectory: work });
    const write = a.args({ permission: 'write-staged', model: 'gpt-x', resumeSessionId: null, workingDirectory: work });
    expect(read.slice(read.indexOf('--sandbox'), read.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(write.slice(write.indexOf('--sandbox'), write.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'workspace-write']);
    for (const args of [read, write]) {
      expect(args).toEqual(expect.arrayContaining(['--json', '--ignore-user-config', 'sandbox_workspace_write.network_access=false', 'approval_policy="never"']));
      expect(args.join(' ')).not.toMatch(/danger|bypass/);
    }
    const resume = a.args({ permission: 'write-staged', model: null, resumeSessionId: 'thread-1', workingDirectory: work });
    expect(resume.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume).toContain('sandbox_mode="workspace-write"');
    expect(resume.slice(-2)).toEqual(['thread-1', '-']);
  });

  it('translates JSONL events', async () => {
    const events = await collect(agent().run(opts({ prompt: 'EDIT', permission: 'write-staged' })));
    expect(events[0]).toEqual({ type: 'session', sessionId: 'thread-new', model: null });
    expect(events).toContainEqual({ type: 'tool', name: 'command', detail: 'rg teh', phase: 'started' });
    expect(events).toContainEqual({ type: 'tool', name: 'command', detail: 'rg teh', phase: 'completed' });
    expect(events).toContainEqual({ type: 'file-change', path: 'intro.tex', change: 'update' });
    expect(events).toContainEqual({ type: 'message', text: 'Fixed the typo.' });
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 400, costUsd: null } });
    expect(done(events)).toEqual({ type: 'done', status: 'completed', result: 'Fixed the typo.', error: null });
    expect(await readFile(path.join(work, 'intro.tex'), 'utf8')).toBe('This is the intro.\n');
  });

  it('reports turn failures and supports cancellation and resume', async () => {
    expect(done(await collect(agent().run(opts({ prompt: 'FAIL' }))))).toMatchObject({ status: 'failed', error: 'model overloaded' });
    const resumed = await collect(agent().run(opts({ resumeSessionId: 'thread-old' })));
    expect(resumed[0]).toMatchObject({ type: 'session', sessionId: 'thread-old' });
    const controller = new AbortController();
    const events = await collect(agent().run(opts({ prompt: 'SLOW', signal: controller.signal })), (e) => {
      if (e.type === 'message') controller.abort();
    });
    expect(done(events)).toMatchObject({ status: 'cancelled' });
  });
});

describe('custom agents', () => {
  it('validates the agents file', () => {
    expect(() => parseAgentsFile({ agents: [{ id: 'codex', displayName: 'x', command: '/x' }] })).toThrow(/reserved/);
    expect(() => parseAgentsFile({ agents: [{ id: 'a1', displayName: 'x', command: '/x' }, { id: 'a1', displayName: 'y', command: '/y' }] })).toThrow(/Duplicate/);
    expect(() => parseAgentsFile({ agents: [{ id: 'Bad Id', displayName: 'x', command: '/x' }] })).toThrow();
    expect(parseAgentsFile({ agents: [{ id: 'echo', displayName: 'Echo', command: '/x' }] })[0]).toMatchObject({ permissionProfiles: ['read'], args: [] });
  });

  it('runs a fixed command with the prompt on stdin and streams stdout', async () => {
    const script = path.join(tmp, 'echo-agent.mjs');
    await writeFile(script, "const t=require('fs').readFileSync(0,'utf8'); console.log('model=' + process.argv[2]); console.log('got ' + t.length + ' chars');".replace("require('fs')", "(await import('node:fs'))"));
    const [config] = parseAgentsFile({ agents: [{ id: 'echo', displayName: 'Echo', command: script, args: ['{model}'], versionArgs: null }] });
    const agent = new CustomAgent(config!, env());
    expect(agent.capabilities).toMatchObject({ modelSelection: true, fileEdits: false, permissionProfiles: ['read'] });
    const events = await collect(agent.run(opts({ prompt: 'hello', model: 'm1' })));
    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')).toMatch(/^model=m1\ngot \d+ chars\n$/);
    expect(done(events)).toMatchObject({ status: 'completed' });
  });
});

describe('staging workspace', () => {
  let project: string;
  let stage: string;
  beforeEach(async () => {
    project = path.join(tmp, 'project');
    stage = path.join(tmp, 'staging', 'conv1');
    await mkdir(path.join(project, 'sections'), { recursive: true });
    await mkdir(path.join(project, '.rs-build'), { recursive: true });
    await writeFile(path.join(project, 'main.tex'), 'main\n');
    await writeFile(path.join(project, 'sections', 'a.tex'), 'aaa\n');
    await writeFile(path.join(project, 'old.tex'), 'remove me\n');
    await writeFile(path.join(project, 'fig.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await writeFile(path.join(project, '.rs-build', 'main.aux'), 'aux');
  });

  it('refuses a staging directory inside the project', () => {
    expect(() => new StagingWorkspace({ projectRoot: project, stagingRoot: path.join(project, 'stage'), sessionId: 'conv1' })).toThrow(/outside/);
    expect(() => new StagingWorkspace({ projectRoot: project, stagingRoot: project, sessionId: 'conv1' })).toThrow(/outside/);
  });

  it('copies the project (without build output) and reports text changes for review', async () => {
    const ws = new StagingWorkspace({ projectRoot: project, stagingRoot: path.dirname(stage), sessionId: 'conv1' });
    expect(await ws.prepare()).toMatchObject({ files: 4 });
    await expect(readFile(path.join(stage, '.rs-build', 'main.aux'))).rejects.toThrow();
    await writeFile(path.join(stage, 'sections', 'a.tex'), 'bbb\n');
    await writeFile(path.join(stage, 'new.tex'), 'new\n');
    await rm(path.join(stage, 'old.tex'));
    await writeFile(path.join(stage, 'fig.png'), Buffer.from([1, 2, 3]));
    await mkdir(path.join(stage, '.rs-build'));
    await writeFile(path.join(stage, '.rs-build', 'x.log'), 'build');
    const { changes, ignored } = await ws.diff();
    expect(changes.map((c) => [c.path, c.change])).toEqual([
      ['new.tex', 'add'],
      ['old.tex', 'delete'],
      ['sections/a.tex', 'update'],
    ]);
    expect(changes.find((c) => c.path === 'sections/a.tex')).toMatchObject({ before: 'aaa\n', after: 'bbb\n', baseHash: ws.baseHash('sections/a.tex') });
    expect(ignored).toEqual([{ path: 'fig.png', reason: 'binary or non-text file changed' }]);
    // The project itself is untouched.
    expect(await readFile(path.join(project, 'sections', 'a.tex'), 'utf8')).toBe('aaa\n');
  });

  it('drops changes to files the user edited while the agent ran', async () => {
    const ws = new StagingWorkspace({ projectRoot: project, stagingRoot: path.dirname(stage), sessionId: 'conv1' });
    await ws.prepare();
    await writeFile(path.join(stage, 'main.tex'), 'agent\n');
    await writeFile(path.join(project, 'main.tex'), 'user\n');
    const { changes, ignored } = await ws.diff();
    expect(changes).toEqual([]);
    expect(ignored).toEqual([{ path: 'main.tex', reason: 'the project file changed while the agent was running' }]);
  });

  it('does not follow symbolic links', async () => {
    const outside = path.join(tmp, 'outside.tex');
    await writeFile(outside, 'secret');
    try {
      await symlink(outside, path.join(project, 'link.tex'), 'file');
    } catch {
      return; // creating symlinks needs privileges on some Windows setups
    }
    const ws = new StagingWorkspace({ projectRoot: project, stagingRoot: path.dirname(stage), sessionId: 'conv1' });
    await ws.prepare();
    await expect(readFile(path.join(stage, 'link.tex'))).rejects.toThrow();
  });
});
