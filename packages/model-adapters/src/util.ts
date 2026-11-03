import { ProviderError, providerErrorFromStatus, redactSecrets } from '@research-studio/ai-core';

export interface ProviderConnection {
  /** API key; `null` for endpoints that need none. Never logged or echoed. */
  apiKey: string | null;
  /** Overrides the provider's default endpoint. */
  baseUrl: string | null;
  /** Per-request timeout for the connection and first byte (ms). */
  timeoutMs: number;
  /** Retries for transient failures before the first token (SDK-managed). */
  maxRetries: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_CONNECTION: Omit<ProviderConnection, 'apiKey' | 'baseUrl'> = {
  timeoutMs: 120_000,
  maxRetries: 2,
};

export function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * Normalize an error thrown by an SDK or fetch. `status` and `message` are read
 * duck-typed so this works for every SDK's error classes.
 */
export function toProviderError(err: unknown, signal: AbortSignal | undefined, secret: string | null): ProviderError {
  if (err instanceof ProviderError) return err;
  if (isAbort(err, signal)) return new ProviderError('cancelled', 'The request was cancelled.');
  const e = err as { status?: unknown; message?: unknown; name?: unknown; cause?: unknown } | null;
  const raw = typeof e?.message === 'string' ? e.message : String(err);
  const message = redactSecrets(raw, secret ? [secret] : []);
  const name = typeof e?.name === 'string' ? e.name : '';
  if (/Timeout/i.test(name)) return new ProviderError('timeout', 'The provider did not respond in time.');
  if (typeof e?.status === 'number' && e.status >= 400) return providerErrorFromStatus(e.status, message);
  if (/Connection|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(`${name} ${message} ${String(e?.cause ?? '')}`)) {
    return new ProviderError('network', `Cannot reach the provider: ${message}`);
  }
  return new ProviderError('unknown', message);
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
