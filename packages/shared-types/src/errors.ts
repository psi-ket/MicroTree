export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'ORIGIN_REJECTED',
  'HOST_REJECTED',
  'NOT_FOUND',
  'CONFLICT',
  'ALREADY_EXISTS',
  'PATH_VIOLATION',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'TOOLCHAIN_MISSING',
  /** A required setting (e.g. an API key) is missing. */
  'NOT_CONFIGURED',
  'PROVIDER_ERROR',
  'AGENT_UNAVAILABLE',
  'STALE_PROPOSAL',
  'TIMEOUT',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Error type thrown inside the runtime and packages; mapped to HTTP by the runtime. */
export class StudioError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.details = details;
  }
}

export function isStudioError(value: unknown): value is StudioError {
  return value instanceof StudioError;
}

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ORIGIN_REJECTED: 403,
  HOST_REJECTED: 421,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  PATH_VIOLATION: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 409,
  TOOLCHAIN_MISSING: 503,
  PROVIDER_ERROR: 502,
  AGENT_UNAVAILABLE: 503,
  STALE_PROPOSAL: 409,
  TIMEOUT: 504,
  INTERNAL: 500,
};
