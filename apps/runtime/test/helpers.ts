import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import type { AgentProvider } from '@research-studio/ai-core';
import { MemorySecretStore, openAiDb, type SecretStore } from '@research-studio/ai-storage';
import { createDatabase, createRepositories, type DatabaseHandle } from '@research-studio/database';
import { detectToolchain, type Toolchain } from '@research-studio/latex-engine';
import { buildApp, type RuntimeApp } from '../src/app';
import type { ModelProviderFactory } from '../src/services/ai/provider-service';
import type { DocumentRuntimeOptions } from '../src/services/document-runtime';
import type { LibraryRuntimeOptions } from '../src/services/library-runtime';
import type { LiteratureServiceOptions } from '../src/services/literature-service';
import { loadConfig, type RuntimeConfig } from '../src/config';

export const PAIRING_TOKEN = 'test-pairing-token-0123456789abcdef0123456789';
export const ORIGIN = 'http://localhost:5173';

let cachedToolchain: Promise<Toolchain> | null = null;
export function toolchain(): Promise<Toolchain> {
  cachedToolchain ??= detectToolchain();
  return cachedToolchain;
}

export interface TestAiOptions {
  env?: Record<string, string | undefined>;
  modelFactory?: ModelProviderFactory;
  agentRegistry?: () => AgentProvider[];
  /** Extra RS_* settings. */
  config?: Record<string, string>;
  literature?: LiteratureServiceOptions;
  library?: LibraryRuntimeOptions;
  documents?: DocumentRuntimeOptions;
}

export interface TestRuntime extends RuntimeApp {
  config: RuntimeConfig;
  secrets: SecretStore;
  db: DatabaseHandle;
  base: string;
  token: string;
  request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: { body?: unknown; headers?: Record<string, string>; auth?: boolean },
  ): Promise<LightMyRequestResponse>;
  restart(): Promise<TestRuntime>;
  dispose(): Promise<void>;
}

async function start(base: string, ai: TestAiOptions, secrets: SecretStore): Promise<TestRuntime> {
  const config = loadConfig({
    ...ai.config,
    RS_DATA_DIR: path.join(base, 'data'),
    RS_WORKSPACE_ROOT: path.join(base, 'workspace'),
    RS_PAIRING_TOKEN: PAIRING_TOKEN,
    RS_PORT: '0',
    RS_LOG_LEVEL: 'silent',
    RS_COMPILE_TIMEOUT_MS: '120000',
  });
  const db = createDatabase(config.dbPath);
  const repos = createRepositories(db.db);
  repos.jobs.failInterrupted('restarted');
  const runtime = await buildApp({
    config,
    repos,
    toolchain: await toolchain(),
    pairingToken: PAIRING_TOKEN,
    ai: { db: openAiDb(db.sqlite), secrets, env: ai.env ?? {}, modelFactory: ai.modelFactory, agentRegistry: ai.agentRegistry },
    literature: ai.literature,
    library: { db: db.db, ...ai.library },
    ...(ai.documents ? { documents: ai.documents } : {}),
  });

  const session = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { origin: ORIGIN, host: '127.0.0.1:4317' },
    payload: { pairingToken: PAIRING_TOKEN },
  });
  const token = session.json<{ sessionToken: string }>().sessionToken;

  const self: TestRuntime = {
    ...runtime,
    config,
    secrets,
    db,
    base,
    token,
    request: (method, url, options = {}) =>
      runtime.app.inject({
        method,
        url,
        headers: {
          host: '127.0.0.1:4317',
          origin: ORIGIN,
          ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
          ...options.headers,
        },
        ...(options.body !== undefined ? { payload: options.body as string } : {}),
      }),
    restart: async () => {
      await runtime.app.close();
      db.close();
      return start(base, ai, secrets);
    },
    dispose: async () => {
      await runtime.app.close();
      db.close();
      await rm(base, { recursive: true, force: true });
    },
  };
  return self;
}

export async function createTestRuntime(ai: TestAiOptions = {}): Promise<TestRuntime> {
  return start(await mkdtemp(path.join(os.tmpdir(), 'rs-runtime-')), ai, new MemorySecretStore());
}

/** Build a multipart/form-data body by hand (inject has no FormData support). */
export function multipart(fields: Record<string, string>, file: { name: string; bytes: Uint8Array; type?: string }) {
  const boundary = `----rs${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
    ),
  );
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
