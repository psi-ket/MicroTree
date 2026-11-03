import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiRepositories, createSecretStore, openAiDb } from '@research-studio/ai-storage';
import { createDatabase, createRepositories } from '@research-studio/database';
import { detectToolchain } from '@research-studio/latex-engine';
import { buildApp } from './app';
import { loadConfig, RUNTIME_VERSION, type RuntimeConfig } from './config';
import { loadOrCreatePairingToken } from './security/tokens';

const SECRET_STORE_LABELS = { keyring: 'OS credential store', file: 'file in the data directory', memory: 'memory only' } as const;

function loggerOptions(config: RuntimeConfig) {
  const base = { level: config.logLevel, redact: ['req.headers.authorization', 'headers.authorization'] };
  if (process.stdout.isTTY) {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  }
  return base;
}

/** The bundled build ships migrations next to main.js; source runs use the database package's folder. */
function migrationsDir(): string | undefined {
  if (process.env.RS_MIGRATIONS_DIR) return process.env.RS_MIGRATIONS_DIR;
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  return existsSync(path.join(bundled, 'meta', '_journal.json')) ? bundled : undefined;
}

function aiMigrationsDir(): string | undefined {
  const bundled = fileURLToPath(new URL('./ai-migrations', import.meta.url));
  return existsSync(path.join(bundled, 'meta', '_journal.json')) ? bundled : undefined;
}

/**
 * Load settings from `RS_ENV_FILE`, or the repository's `.env` (src/ and dist/
 * both sit two levels below the repo root). Variables already set in the
 * environment take precedence.
 */
function loadEnvFile(): void {
  const file = process.env.RS_ENV_FILE ?? fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
  else if (process.env.RS_ENV_FILE) throw new Error(`RS_ENV_FILE points to a missing file: ${file}`);
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });

  const db = createDatabase(config.dbPath, migrationsDir());
  const repos = createRepositories(db.db);
  const interrupted = repos.jobs.failInterrupted('The runtime stopped before this job finished');
  const aiDb = openAiDb(db.sqlite, aiMigrationsDir());
  const aiRepos = createAiRepositories(aiDb);
  const interruptedAi =
    aiRepos.messages.failInterrupted('The runtime stopped before this answer finished') +
    aiRepos.agentRuns.failInterrupted('The runtime stopped while the agent was running');
  const secrets = await createSecretStore(config.ai.secretStore, config.dataDir);

  const [toolchain, pairingToken] = await Promise.all([
    detectToolchain({ latexmk: config.latexmkPath, synctex: config.synctexPath }),
    config.fixedPairingToken ?? loadOrCreatePairingToken(config.dataDir),
  ]);

  const runtime = await buildApp({
    config,
    repos,
    toolchain,
    pairingToken,
    logger: loggerOptions(config),
    ai: { db: aiDb, secrets },
    library: { db: db.db },
  });
  const { app } = runtime;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const apiUrl = `http://${config.host === '::1' ? '[::1]' : config.host}:${port}`;
  const connectUrl = `${config.webUrl}/#runtime=${encodeURIComponent(apiUrl)}&token=${pairingToken}`;
  const tc = toolchain.status;

  const lines = [
    '',
    `  Research Studio runtime v${RUNTIME_VERSION}`,
    '',
    `  API        ${apiUrl}`,
    `  Data       ${config.dataDir}`,
    `  Workspace  ${config.workspaceRoot}`,
    `  latexmk    ${tc.latexmk.available ? `${tc.latexmk.version ?? 'unknown version'} (${tc.latexmk.path})` : 'NOT FOUND - compilation disabled'}`,
    `  synctex    ${tc.synctex.available ? tc.synctex.path : 'NOT FOUND - SyncTeX disabled'}`,
    `  Origins    ${config.allowedOrigins.join(', ')}`,
    `  Secrets    ${SECRET_STORE_LABELS[secrets.kind]}${secrets.notice ? ` - ${secrets.notice}` : ''}`,
    `  Agents     ${config.ai.agentsEnabled ? 'enabled (each project must approve an agent)' : 'disabled'}`,
    `  Literature ${config.literature.enabled ? `on (OpenAlex, Semantic Scholar, arXiv, Crossref${config.literature.mailto ? '; contact address set' : ''})` : 'off'}`,
    interrupted ? `  Recovered  ${interrupted} interrupted compile job(s)` : null,
    interruptedAi ? `  Recovered  ${interruptedAi} interrupted AI request(s)` : null,
    '',
    '  Open this URL to connect the web app (keep it private):',
    `  ${connectUrl}`,
    '',
  ].filter((l): l is string => l !== null);
  console.info(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
