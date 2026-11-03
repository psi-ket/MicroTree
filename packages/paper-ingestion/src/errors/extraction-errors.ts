import type { ExtractionErrorCode, JobError } from '@research-studio/document-intelligence';

const RETRYABLE: ReadonlySet<ExtractionErrorCode> = new Set(['unavailable', 'overloaded', 'timeout', 'embedding-failed', 'internal']);

/**
 * A failure in extraction or indexing with a stable code. `retryable` errors
 * (service down, busy, timeout) may succeed later; permanent ones (malformed
 * PDF, nothing extractable, unsupported) are not retried.
 */
export class ExtractionError extends Error {
  override name = 'ExtractionError';
  readonly retryable: boolean;

  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
    readonly source: string | null = null,
    retryable?: boolean,
  ) {
    super(message);
    this.retryable = retryable ?? RETRYABLE.has(code);
  }

  toJobError(): JobError {
    return { code: this.code, message: this.message, retryable: this.retryable, source: this.source };
  }
}

export class ExtractionCancelledError extends ExtractionError {
  override name = 'ExtractionCancelledError';
  constructor(source: string | null = null) {
    super('cancelled', 'Processing was cancelled', source, false);
  }
}

export function isExtractionError(err: unknown): err is ExtractionError {
  return err instanceof ExtractionError;
}

/** Any thrown value as a job error, without leaking stack traces or local paths. */
export function toJobError(err: unknown, source: string | null = null): JobError {
  if (err instanceof ExtractionError) return err.toJobError();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message: redactPaths(message).slice(0, 500), retryable: false, source };
}

/** Remove absolute file-system paths from messages shown to the user. */
export function redactPaths(message: string): string {
  return message.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"]+[\\/])+[^\s:'"]*/g, '[path]');
}
