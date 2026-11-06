import { CLI_DEFAULT_MODEL, type ModelCapabilities, type ModelProviderKind } from '@research-studio/shared-types';

export interface ProviderKindInfo {
  kind: ModelProviderKind;
  label: string;
  /** `http`: an API reached by URL; `cli`: a command-line agent on this computer, signed in with its own login (no base URL, no API key). */
  transport: 'http' | 'cli';
  /** Used when the config has no base URL. `null` means a base URL is required. */
  defaultBaseUrl: string | null;
  /** Suggested model before the list has been fetched. */
  defaultModel: string | null;
  /** Environment variable the runtime falls back to for the API key. */
  envKey: string | null;
  capabilities: ModelCapabilities;
}

// Only what the adapters implement. Tool use and reasoning are not wired up
// in any adapter, so they are false even where the API supports them. Limits
// vary per model, so they are reported per model (`ModelInfo`), not here.
const HOSTED: Omit<ModelCapabilities, 'requiresApiKey'> = {
  streaming: true,
  structuredOutput: true,
  toolUse: false,
  vision: true,
  reasoning: false,
  maxContextTokens: null,
  maxOutputTokens: null,
  usageReporting: true,
  modelListing: true,
};

export const PROVIDER_KINDS: Record<ModelProviderKind, ProviderKindInfo> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    transport: 'http',
    defaultBaseUrl: null,
    defaultModel: 'claude-opus-5-5',
    envKey: 'ANTHROPIC_API_KEY',
    capabilities: { ...HOSTED, requiresApiKey: true },
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: null,
    defaultModel: null,
    envKey: 'OPENAI_API_KEY',
    capabilities: { ...HOSTED, requiresApiKey: true },
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    transport: 'http',
    defaultBaseUrl: null,
    defaultModel: null,
    envKey: 'GEMINI_API_KEY',
    capabilities: { ...HOSTED, requiresApiKey: true },
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    transport: 'http',
    defaultBaseUrl: null,
    defaultModel: null,
    envKey: null,
    // Endpoints vary (vLLM, LM Studio, OpenRouter, …): only the chat-completions basics are assumed.
    capabilities: {
      streaming: true,
      structuredOutput: false,
      toolUse: false,
      vision: false,
      reasoning: false,
      maxContextTokens: null,
      maxOutputTokens: null,
      usageReporting: true,
      modelListing: true,
      requiresApiKey: false,
    },
  },
  ollama: {
    kind: 'ollama',
    label: 'Ollama (local)',
    transport: 'http',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: null,
    envKey: null,
    capabilities: {
      streaming: true,
      structuredOutput: true,
      toolUse: false,
      // The adapter sends images; whether a model accepts them is reported per model (`describeModel`, /api/show).
      vision: true,
      reasoning: false,
      maxContextTokens: null,
      maxOutputTokens: null,
      usageReporting: true,
      modelListing: true,
      requiresApiKey: false,
    },
  },
  // The CLIs run as plain models: one answer per call, every tool disabled,
  // signed in with the user's own Claude or ChatGPT login.
  'claude-cli': {
    kind: 'claude-cli',
    label: 'Claude Code (your sign-in)',
    transport: 'cli',
    defaultBaseUrl: null,
    defaultModel: CLI_DEFAULT_MODEL,
    envKey: null,
    capabilities: { ...HOSTED, requiresApiKey: false },
  },
  'codex-cli': {
    kind: 'codex-cli',
    label: 'Codex CLI (your sign-in)',
    transport: 'cli',
    defaultBaseUrl: null,
    defaultModel: CLI_DEFAULT_MODEL,
    envKey: null,
    // Codex reports whole messages, not token deltas.
    capabilities: { ...HOSTED, streaming: false, requiresApiKey: false },
  },
};

/**
 * Credentials may only travel over HTTPS, or plain HTTP to this machine.
 * Returns a problem description, or null when the URL is acceptable.
 */
export function checkBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL, e.g. https://api.example.com/v1';
  }
  if (url.username || url.password) return 'The URL must not contain credentials.';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  if (url.protocol === 'http:') return 'Plain HTTP is only allowed for endpoints on this machine (127.0.0.1, localhost). Use HTTPS.';
  return 'The URL must use https:// (or http:// for this machine).';
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Where a provider runs, for privacy decisions: `local` only for Ollama on a
 * loopback address of this computer; every other provider or host is
 * `cloud`, and sending it project text needs the user's consent.
 */
export function privacyModeOf(kind: ModelProviderKind, baseUrl: string | null): 'local' | 'cloud' {
  if (kind !== 'ollama') return 'cloud';
  try {
    return isLoopbackHost(new URL(baseUrl ?? 'http://127.0.0.1:11434').hostname) ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}
