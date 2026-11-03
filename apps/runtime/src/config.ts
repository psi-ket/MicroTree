import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { defaultDataDir } from '@research-studio/database';
import type { LiteratureProviderId } from '@research-studio/shared-types';

export const RUNTIME_VERSION = '0.1.0';

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  RS_HOST: z.enum(LOOPBACK_HOSTS).default('127.0.0.1'),
  RS_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  RS_DATA_DIR: z.string().optional(),
  RS_DB_PATH: z.string().optional(),
  RS_WORKSPACE_ROOT: z.string().optional(),
  RS_ALLOWED_ORIGINS: csv.default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  RS_WEB_URL: z.url().default('http://127.0.0.1:5173'),
  RS_PAIRING_TOKEN: z.string().min(32).max(256).optional(),
  RS_LATEXMK_PATH: z.string().optional(),
  RS_SYNCTEX_PATH: z.string().optional(),
  RS_COMPILE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(30 * 60_000).default(180_000),
  RS_MAX_CONCURRENT_COMPILES: z.coerce.number().int().min(1).max(16).default(2),
  RS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(512 * 1024 * 1024).default(25 * 1024 * 1024),
  RS_SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(12 * 60 * 60 * 1000),
  RS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // AI (M2)
  RS_SECRET_STORE: z.enum(['auto', 'keyring', 'file', 'memory']).default('auto'),
  RS_AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(30 * 60_000).default(180_000),
  RS_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_192),
  RS_AGENTS: z.enum(['on', 'off']).default('on'),
  RS_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(2 * 60 * 60_000).default(15 * 60_000),
  /** Total size of all agent staging copies in use at the same time. */
  RS_AGENT_STAGING_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(1024 ** 4).default(2 * 1024 ** 3),
  RS_CLAUDE_PATH: z.string().optional(),
  RS_CODEX_PATH: z.string().optional(),
  RS_CODEX_WINDOWS_SANDBOX: z.enum(['unelevated', 'elevated']).default('unelevated'),
  RS_AGENTS_FILE: z.string().optional(),
  // Literature search (M3.1)
  RS_LITERATURE: z.enum(['on', 'off']).default('on'),
  /** Contact address sent to OpenAlex and Crossref (Crossref's "polite pool"). Optional; nothing is sent by default. */
  RS_LITERATURE_MAILTO: z.email().optional(),
  /** Deadline for one search across all providers. */
  RS_LITERATURE_TIMEOUT_MS: z.coerce.number().int().min(3_000).max(120_000).default(25_000),
  RS_OPENALEX_URL: z.url({ protocol: /^https?$/ }).optional(),
  RS_SEMANTIC_SCHOLAR_URL: z.url({ protocol: /^https?$/ }).optional(),
  RS_ARXIV_URL: z.url({ protocol: /^https?$/ }).optional(),
  RS_CROSSREF_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Research library (M3.2)
  /** Where library PDFs are stored (default: `<data dir>/library`). */
  RS_LIBRARY_DIR: z.string().optional(),
  RS_LIBRARY_MAX_PDF_BYTES: z.coerce.number().int().min(1024 * 1024).max(2 * 1024 ** 3).default(100 * 1024 * 1024),
  RS_ZOTERO_URL: z.url({ protocol: /^https?$/ }).default('https://api.zotero.org'),
  /** Zotero desktop's local API; must be on this computer. */
  RS_ZOTERO_LOCAL_URL: z.url({ protocol: /^http$/ }).default('http://localhost:23119/api'),
  // Document intelligence and retrieval (M3.3)
  RS_GROBID: z.enum(['on', 'off']).default('on'),
  /** GROBID service; a host other than this computer needs RS_GROBID_ALLOW_REMOTE=1. */
  RS_GROBID_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8070'),
  RS_GROBID_ALLOW_REMOTE: z.enum(['0', '1']).default('0'),
  RS_GROBID_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(60 * 60_000).default(180_000),
  /** GROBID consolidation calls external metadata services from the GROBID server. Off by default. */
  RS_GROBID_CONSOLIDATION: z.enum(['0', '1']).default('0'),
  RS_PYMUPDF: z.enum(['auto', 'off']).default('auto'),
  /** Python with PyMuPDF installed (`pip install pymupdf`). */
  RS_PYTHON: z.string().min(1).max(500).optional(),
  RS_INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  RS_INGESTION_MAX_PAGES: z.coerce.number().int().min(1).max(5000).default(500),
  /** Default embedding endpoint (Ollama). Changing it in the app is limited to this computer unless remote is allowed. */
  RS_OLLAMA_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:11434'),
  RS_EMBEDDINGS_ALLOW_REMOTE: z.enum(['0', '1']).default('0'),
});

export interface RuntimeConfig {
  host: (typeof LOOPBACK_HOSTS)[number];
  port: number;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  allowedOrigins: string[];
  webUrl: string;
  fixedPairingToken: string | null;
  latexmkPath: string | undefined;
  synctexPath: string | undefined;
  compileTimeoutMs: number;
  maxConcurrentCompiles: number;
  maxUploadBytes: number;
  sessionTtlMs: number;
  logLevel: z.infer<typeof EnvSchema>['RS_LOG_LEVEL'];
  ai: {
    secretStore: z.infer<typeof EnvSchema>['RS_SECRET_STORE'];
    requestTimeoutMs: number;
    maxOutputTokens: number;
    agentsEnabled: boolean;
    agentTimeoutMs: number;
    stagingMaxBytes: number;
    claudePath: string | undefined;
    codexPath: string | undefined;
    codexWindowsSandbox: 'unelevated' | 'elevated';
    /** JSON file declaring custom CLI agents (default: `<dataDir>/agents.json`). */
    agentsFile: string;
  };
  literature: {
    enabled: boolean;
    mailto: string | null;
    timeoutMs: number;
    /** API base URL overrides (tests, mirrors); unset providers use their public endpoints. */
    baseUrls: Partial<Record<LiteratureProviderId, string>>;
  };
  library: {
    storageDir: string;
    maxPdfBytes: number;
    zoteroUrl: string;
    zoteroLocalUrl: string;
  };
  documents: {
    grobidEnabled: boolean;
    grobidUrl: string;
    grobidAllowRemote: boolean;
    grobidTimeoutMs: number;
    grobidConsolidation: boolean;
    pymupdfEnabled: boolean;
    python: string;
    concurrency: number;
    maxPages: number;
    ollamaUrl: string;
    embeddingsAllowRemote: boolean;
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`RS_ALLOWED_ORIGINS contains an invalid origin: "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`Origin must use http or https: "${value}"`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid runtime configuration:\n${details}`);
  }
  const e = parsed.data;
  const dataDir = e.RS_DATA_DIR ? path.resolve(e.RS_DATA_DIR) : defaultDataDir(env);
  return {
    host: e.RS_HOST,
    port: e.RS_PORT,
    dataDir,
    dbPath: e.RS_DB_PATH ? path.resolve(e.RS_DB_PATH) : path.join(dataDir, 'studio.db'),
    workspaceRoot: path.resolve(e.RS_WORKSPACE_ROOT ?? path.join(os.homedir(), 'ResearchStudio', 'Projects')),
    allowedOrigins: [...new Set(e.RS_ALLOWED_ORIGINS.map(normalizeOrigin))],
    webUrl: e.RS_WEB_URL.replace(/\/+$/, ''),
    fixedPairingToken: e.RS_PAIRING_TOKEN ?? null,
    latexmkPath: e.RS_LATEXMK_PATH,
    synctexPath: e.RS_SYNCTEX_PATH,
    compileTimeoutMs: e.RS_COMPILE_TIMEOUT_MS,
    maxConcurrentCompiles: e.RS_MAX_CONCURRENT_COMPILES,
    maxUploadBytes: e.RS_MAX_UPLOAD_BYTES,
    sessionTtlMs: e.RS_SESSION_TTL_MS,
    logLevel: e.RS_LOG_LEVEL,
    ai: {
      secretStore: e.RS_SECRET_STORE,
      requestTimeoutMs: e.RS_AI_TIMEOUT_MS,
      maxOutputTokens: e.RS_AI_MAX_OUTPUT_TOKENS,
      agentsEnabled: e.RS_AGENTS === 'on',
      agentTimeoutMs: e.RS_AGENT_TIMEOUT_MS,
      stagingMaxBytes: e.RS_AGENT_STAGING_MAX_BYTES,
      claudePath: e.RS_CLAUDE_PATH,
      codexPath: e.RS_CODEX_PATH,
      codexWindowsSandbox: e.RS_CODEX_WINDOWS_SANDBOX,
      agentsFile: path.resolve(e.RS_AGENTS_FILE ?? path.join(dataDir, 'agents.json')),
    },
    literature: {
      enabled: e.RS_LITERATURE === 'on',
      mailto: e.RS_LITERATURE_MAILTO ?? null,
      timeoutMs: e.RS_LITERATURE_TIMEOUT_MS,
      baseUrls: Object.fromEntries(
        (
          [
            ['openalex', e.RS_OPENALEX_URL],
            ['semantic-scholar', e.RS_SEMANTIC_SCHOLAR_URL],
            ['arxiv', e.RS_ARXIV_URL],
            ['crossref', e.RS_CROSSREF_URL],
          ] as const
        ).filter(([, url]) => url !== undefined),
      ),
    },
    library: {
      storageDir: path.resolve(e.RS_LIBRARY_DIR ?? path.join(dataDir, 'library')),
      maxPdfBytes: e.RS_LIBRARY_MAX_PDF_BYTES,
      zoteroUrl: e.RS_ZOTERO_URL.replace(/\/+$/, ''),
      zoteroLocalUrl: e.RS_ZOTERO_LOCAL_URL.replace(/\/+$/, ''),
    },
    documents: {
      grobidEnabled: e.RS_GROBID === 'on',
      grobidUrl: e.RS_GROBID_URL.replace(/\/+$/, ''),
      grobidAllowRemote: e.RS_GROBID_ALLOW_REMOTE === '1',
      grobidTimeoutMs: e.RS_GROBID_TIMEOUT_MS,
      grobidConsolidation: e.RS_GROBID_CONSOLIDATION === '1',
      pymupdfEnabled: e.RS_PYMUPDF === 'auto',
      python: e.RS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      concurrency: e.RS_INGESTION_CONCURRENCY,
      maxPages: e.RS_INGESTION_MAX_PAGES,
      ollamaUrl: e.RS_OLLAMA_URL.replace(/\/+$/, ''),
      embeddingsAllowRemote: e.RS_EMBEDDINGS_ALLOW_REMOTE === '1',
    },
  };
}
