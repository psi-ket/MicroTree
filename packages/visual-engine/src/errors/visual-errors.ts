export type VisualErrorCode =
  | 'invalid-image'
  | 'unsupported-type'
  | 'too-large'
  | 'too-many-pixels'
  | 'unsafe-svg'
  | 'invalid-operation'
  | 'no-vision'
  | 'no-structured-output'
  | 'consent-required'
  | 'provider-error'
  | 'invalid-output'
  | 'invalid-structure'
  | 'unsafe-latex'
  | 'compile-unavailable'
  | 'cancelled';

/** A failure in visual processing with a stable code; messages are shown to the user. */
export class VisualError extends Error {
  override name = 'VisualError';
  constructor(
    readonly code: VisualErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const isVisualError = (e: unknown): e is VisualError => e instanceof VisualError;
