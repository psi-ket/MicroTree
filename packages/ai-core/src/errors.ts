export const PROVIDER_ERROR_CODES = [
  'auth',
  'permission',
  'rate-limit',
  'invalid-request',
  /** The request contains content (e.g. images) the provider or adapter cannot take. */
  'unsupported-modality',
  'not-found',
  'overloaded',
  'network',
  'timeout',
  'cancelled',
  'bad-response',
  'unknown',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['rate-limit', 'overloaded', 'network', 'timeout']);

/**
 * Normalized failure from a model provider or agent. Messages are written for
 * the user and must never contain credentials.
 */
export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly retryable: boolean;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(redactSecrets(message));
    this.retryable = RETRYABLE.has(code);
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export function providerErrorFromStatus(status: number, message: string): ProviderError {
  const code: ProviderErrorCode =
    status === 401
      ? 'auth'
      : status === 403
        ? 'permission'
        : status === 404
          ? 'not-found'
          : status === 408
            ? 'timeout'
            : status === 429
              ? 'rate-limit'
              : status === 529 || status === 503
                ? 'overloaded'
                : status >= 400 && status < 500
                  ? 'invalid-request'
                  : 'unknown';
  return new ProviderError(code, message, status);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:api[_-]?key|x-api-key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',&]{8,}/gi,
  /([?&]key=)[^&\s"']+/gi,
];

/** Remove anything that looks like an API key from a message. */
export function redactSecrets(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const secret of extra) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_m, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/** Replace every occurrence of the given literal values (at least 6 characters). */
export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value.length >= 6) out = out.split(value).join('[redacted]');
  return out;
}

/**
 * Redacts literal values from text that arrives in chunks. A value split
 * across chunks is still caught: the last `longest - 1` characters are held
 * back until the next chunk (or `flush`).
 */
export function createStreamRedactor(values: readonly string[]): { push(text: string): string; flush(): string } {
  const secrets = values.filter((v) => v.length >= 6);
  const hold = Math.max(0, ...secrets.map((v) => v.length - 1));
  let pending = '';
  return {
    push(text) {
      if (!secrets.length) return text;
      const redacted = redactValues(pending + text, secrets);
      const cut = Math.max(0, redacted.length - hold);
      pending = redacted.slice(cut);
      return redacted.slice(0, cut);
    },
    flush() {
      const out = redactValues(pending, secrets);
      pending = '';
      return out;
    },
  };
}
