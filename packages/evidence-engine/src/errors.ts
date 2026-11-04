export type EvidenceErrorCode = 'invalid-input' | 'invalid-output' | 'provider-error' | 'consent-required' | 'not-found' | 'cancelled' | 'conflict';

export class EvidenceError extends Error {
  override name = 'EvidenceError';
  constructor(
    readonly code: EvidenceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const isEvidenceError = (e: unknown): e is EvidenceError => e instanceof EvidenceError;
