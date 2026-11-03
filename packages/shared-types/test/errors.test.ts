import { describe, expect, it } from 'vitest';
import { ERROR_CODES, HTTP_STATUS_BY_CODE, StudioError, isStudioError } from '../src';

describe('StudioError', () => {
  it('carries a code and details', () => {
    const err = new StudioError('NOT_FOUND', 'missing', { id: 'x' });
    expect(isStudioError(err)).toBe(true);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ id: 'x' });
    expect(isStudioError(new Error('plain'))).toBe(false);
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      const status = HTTP_STATUS_BY_CODE[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
