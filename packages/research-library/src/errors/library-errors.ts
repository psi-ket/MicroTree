import { StudioError, type ErrorCode } from '@research-studio/shared-types';

/** Library errors are `StudioError`s, so the runtime maps them to HTTP like every other error. */
export class LibraryError extends StudioError {
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'LibraryError';
  }
}

export const notFound = (what: string, id: string) => new LibraryError('NOT_FOUND', `${what} not found`, { id });

/** An operation was cancelled by the user (import job, download). */
export class LibraryCancelledError extends Error {
  override name = 'LibraryCancelledError';
  constructor() {
    super('Cancelled');
  }
}
