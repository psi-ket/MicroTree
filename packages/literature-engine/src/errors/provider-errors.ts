import { LITERATURE_PROVIDER_NAMES, type LiteratureProviderId } from '@research-studio/shared-types';

export const PROVIDER_ERROR_KINDS = [
  /** 429, or the provider's budget is exhausted. */
  'rate_limited',
  'timeout',
  /** The caller aborted the request. */
  'cancelled',
  /** DNS, connection or TLS failure. */
  'network',
  /** 5xx after retries. */
  'unavailable',
  /** 4xx other than 404/429: the request was wrong (never retried). */
  'bad_request',
  /** 401/403: the API key was rejected. */
  'unauthorized',
  /** The response did not match the documented format. */
  'invalid_response',
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export class LiteratureProviderError extends Error {
  override name = 'LiteratureProviderError';

  constructor(
    readonly provider: LiteratureProviderId,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Suggested wait before trying again, from `Retry-After` or the provider's reset header. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${LITERATURE_PROVIDER_NAMES[provider]}: ${message}`);
  }

  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout' || this.kind === 'network' || this.kind === 'unavailable';
  }
}

export function isProviderError(value: unknown): value is LiteratureProviderError {
  return value instanceof LiteratureProviderError;
}

/** True for an AbortError raised by fetch or by our own signals. */
export function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === 'AbortError' || (value as { code?: unknown }).code === 'ABORT_ERR');
}
