import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@research-studio/ai-core';
import { buildAgentEnvironment, ClaudeCodeAgent, CodexAgent, parseAgentsConfig, type CustomAgent, type EnvironmentPolicy } from '../src';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A runtime environment with credentials for several providers. */
const SOURCE = {
  PATH: process.env.PATH ?? '/usr/bin',
  HOME: '/home/u',
  LC_ALL: 'C.UTF-8',
  OPENAI_API_KEY: 'sk-openai-0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef',
  GEMINI_API_KEY: 'gemini-0123456789abcdef',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-0123456789abcdef',
  CODEX_API_KEY: 'codex-0123456789abcdef',
  AWS_SECRET_ACCESS_KEY: 'aws-0123456789abcdef',
  GITHUB_TOKEN: 'ghp_0123456789abcdef',
  CLAUDE_CONFIG_DIR: '/home/u/.claude-alt',
  CODEX_HOME: '/home/u/.codex-alt',
  RS_PAIRING_TOKEN: 'pairing-0123456789abcdef',
  NODE_OPTIONS: '--require /tmp/evil.js',
  HTTPS_PROXY: 'http://user:hunter2-proxy@proxy.local:8080',
};
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'];
const names = (env: Record<string, string>) => Object.keys(env).sort();

describe('agent environment policy', () => {
  it('keeps OpenAI and every other provider credential away from Claude Code', () => {
    const { env } = buildAgentEnvironment(SOURCE, 'claude-code');
    for (const key of PROVIDER_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/home/u/.claude-alt', HOME: '/home/u', LC_ALL: 'C.UTF-8' });
    expect(env).not.toHaveProperty('CODEX_HOME');
  });

  it('keeps Anthropic and every other provider credential away from Codex', () => {
    const { env } = buildAgentEnvironment(SOURCE, 'codex');
    for (const key of PROVIDER_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ CODEX_HOME: '/home/u/.codex-alt' });
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('gives custom agents no provider keys and no other agent configuration by default', () => {
    const { env } = buildAgentEnvironment(SOURCE, 'my-agent');
    for (const key of [...PROVIDER_KEYS, 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) expect(env).not.toHaveProperty(key);
    expect(names(env)).toEqual(['HOME', 'HTTPS_PROXY', 'LC_ALL', 'PATH']);
  });

  it('never forwards RS_* or loader-injection variables', () => {
    for (const agent of ['claude-code', 'codex', 'my-agent']) {
      const { env } = buildAgentEnvironment(SOURCE, agent);
      expect(env).not.toHaveProperty('RS_PAIRING_TOKEN');
      expect(env).not.toHaveProperty('NODE_OPTIONS');
    }
  });

  it('forwards explicitly allowed variables, by exact name, for that agent only', () => {
    const config = parseAgentsConfig({ environment: { 'claude-code': { allow: ['ANTHROPIC_API_KEY'], set: { CLAUDE_CODE_DISABLE_TELEMETRY: '1' } } } });
    const policy = config.environment['claude-code']!;
    const claude = buildAgentEnvironment(SOURCE, 'claude-code', policy);
    expect(claude.env).toMatchObject({ ANTHROPIC_API_KEY: SOURCE.ANTHROPIC_API_KEY, CLAUDE_CODE_DISABLE_TELEMETRY: '1' });
    expect(claude.env).not.toHaveProperty('OPENAI_API_KEY');
    // Codex's environment is unaffected by Claude Code's policy.
    expect(buildAgentEnvironment(SOURCE, 'codex', config.environment.codex).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('matches names case-insensitively, as Windows environments do', () => {
    const { env } = buildAgentEnvironment({ Path: 'C:\\bin', anthropic_api_key: 'sk-lower-0123456789' }, 'claude-code', { allow: ['ANTHROPIC_API_KEY'], set: {} });
    expect(env).toEqual({ Path: 'C:\\bin', anthropic_api_key: 'sk-lower-0123456789' });
  });

  it('reports forwarded credentials so they can be redacted, including proxy passwords', () => {
    const { secrets } = buildAgentEnvironment(SOURCE, 'claude-code', { allow: ['ANTHROPIC_API_KEY'], set: {} });
    expect(secrets.sort()).toEqual([SOURCE.ANTHROPIC_API_KEY, SOURCE.HTTPS_PROXY].sort());
  });

  it('drops values that are not valid environment strings', () => {
    const { env } = buildAgentEnvironment({ HOME: 'a\0b', PATH: 'x'.repeat(40_000), LANG: 'en_US.UTF-8' }, 'codex');
    expect(env).toEqual({ LANG: 'en_US.UTF-8' });
  });
});

describe('agents file cannot bypass the policy', () => {
  const bad: [string, unknown][] = [
    ['allowing RS_* variables', { environment: { codex: { allow: ['RS_PAIRING_TOKEN'] } } }],
    ['allowing NODE_OPTIONS', { environment: { 'claude-code': { allow: ['NODE_OPTIONS'] } } }],
    ['setting LD_PRELOAD', { agents: [{ id: 'my-agent', displayName: 'Mine', command: '/bin/x', environment: { set: { LD_PRELOAD: '/x.so' } } }] }],
    ['writing a credential into the file', { environment: { codex: { set: { OPENAI_API_KEY: 'sk-literal' } } } }],
    ['an invalid name', { environment: { codex: { allow: ['A=B'] } } }],
    ['a value with a line break', { environment: { codex: { set: { MODE: 'a\nb' } } } }],
    ['a policy for an unknown built-in', { environment: { 'my-agent': { allow: ['HOME'] } } }],
    ['unknown policy keys', { environment: { codex: { inherit: true } } }],
    ['a custom agent impersonating a built-in', { agents: [{ id: 'claude-code', displayName: 'Fake', command: '/bin/x' }] }],
  ];
  it.each(bad)('rejects %s', (_name, data) => {
    expect(() => parseAgentsConfig(data)).toThrow();
  });

  it('ignores denied and credential names even in a policy built without the schema', () => {
    const policy = { allow: ['RS_PAIRING_TOKEN', 'NODE_OPTIONS'], set: { LD_PRELOAD: '/x.so', OPENAI_API_KEY: 'sk-literal-0123456789' } } as EnvironmentPolicy;
    const { env } = buildAgentEnvironment(SOURCE, 'my-agent', policy);
    for (const key of ['RS_PAIRING_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'OPENAI_API_KEY']) expect(env).not.toHaveProperty(key);
  });
});

describe('agent processes receive only the policy environment', () => {
  let tmp: string;
  let log: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'rs-env-'));
    log = path.join(tmp, 'log.jsonl');
  });
  afterEach(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

  const received = async () => (JSON.parse((await readFile(log, 'utf8')).trim().split('\n').at(-1)!) as { env: string[] }).env.map((n) => n.toUpperCase());
  const drain = async (events: AsyncIterable<AgentEvent>) => {
    for await (const _ of events) void _;
  };
  const run = (agent: { run: CustomAgent['run'] }, env: Record<string, string>) =>
    drain(agent.run({ prompt: 'hello', workingDirectory: tmp, permission: 'read', model: null, resumeSessionId: null, timeoutMs: 20_000, env }));
  const withLog = (agentId: string) => {
    const built = buildAgentEnvironment({ ...process.env, ...SOURCE, PATH: process.env.PATH ?? '' }, agentId, { allow: [], set: { FAKE_LOG: log } });
    return built.env;
  };

  it('Claude Code', async () => {
    await run(new ClaudeCodeAgent({ configuredPath: path.join(FIXTURES, 'fake-claude.mjs'), env: {} }), withLog('claude-code'));
    const env = await received();
    for (const key of [...PROVIDER_KEYS, 'RS_PAIRING_TOKEN', 'NODE_OPTIONS']) expect(env).not.toContain(key);
    expect(env).toContain('CLAUDE_CONFIG_DIR');
  });

  it('Codex', async () => {
    await run(new CodexAgent({ configuredPath: path.join(FIXTURES, 'fake-codex.mjs'), env: {}, windowsSandbox: 'unelevated' }), withLog('codex'));
    const env = await received();
    for (const key of [...PROVIDER_KEYS, 'RS_PAIRING_TOKEN', 'NODE_OPTIONS']) expect(env).not.toContain(key);
    expect(env).toContain('CODEX_HOME');
  });
});
