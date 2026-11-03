import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real runtime (with the real TeX toolchain) and the
 * web dev server on dedicated ports, against a throwaway data directory.
 */
const RUNTIME_PORT = 4399;
const WEB_PORT = 5199;
export const E2E_PAIRING_TOKEN = 'e2e-pairing-token-0123456789abcdef0123456789';
export const E2E_RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;
export const E2E_WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MOCK_AI_PORT = 4499;
export const E2E_MOCK_AI_URL = `http://127.0.0.1:${MOCK_AI_PORT}/v1`;
export const E2E_MOCK_AI_KEY = 'e2e-mock-key-0123456789';
const MOCK_LITERATURE_PORT = 4498;
export const E2E_MOCK_LITERATURE_URL = `http://127.0.0.1:${MOCK_LITERATURE_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node e2e/reset-data.mjs && pnpm --filter @research-studio/runtime start:dev',
      url: `${E2E_RUNTIME_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        RS_PORT: String(RUNTIME_PORT),
        RS_DATA_DIR: '.e2e-data/data',
        RS_WORKSPACE_ROOT: '.e2e-data/projects',
        RS_PAIRING_TOKEN: E2E_PAIRING_TOKEN,
        RS_ALLOWED_ORIGINS: E2E_WEB_URL,
        RS_WEB_URL: E2E_WEB_URL,
        RS_LOG_LEVEL: 'warn',
        // Never touch the OS credential store or the user's own agents.
        RS_SECRET_STORE: 'memory',
        RS_AGENTS: 'off',
        // Literature providers answer from recorded responses; no real scholarly API is called.
        RS_OPENALEX_URL: `${E2E_MOCK_LITERATURE_URL}/openalex`,
        RS_SEMANTIC_SCHOLAR_URL: `${E2E_MOCK_LITERATURE_URL}/s2`,
        RS_ARXIV_URL: `${E2E_MOCK_LITERATURE_URL}/arxiv/api/query`,
        RS_CROSSREF_URL: `${E2E_MOCK_LITERATURE_URL}/crossref`,
        RS_LITERATURE_TIMEOUT_MS: '8000',
      },
    },
    {
      command: 'node e2e/mock-literature-server.mjs',
      url: `${E2E_MOCK_LITERATURE_URL}/__stats`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { MOCK_LITERATURE_PORT: String(MOCK_LITERATURE_PORT) },
    },
    {
      command: 'node e2e/mock-ai-server.mjs',
      url: `${E2E_MOCK_AI_URL}/models`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { MOCK_AI_PORT: String(MOCK_AI_PORT), MOCK_AI_KEY: E2E_MOCK_AI_KEY },
    },
    {
      command: 'pnpm --filter @research-studio/web dev',
      url: E2E_WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RS_WEB_PORT: String(WEB_PORT) },
    },
  ],
});
