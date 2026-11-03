import { describe, expect, it } from 'vitest';
import { isStaleAssetError } from '../src/lib/stale-assets';

describe('isStaleAssetError', () => {
  it('recognises failed loads of the app’s own modules and workers', () => {
    expect(
      isStaleAssetError(
        'Setting up fake worker failed: "Failed to fetch dynamically imported module: http://127.0.0.1:5173/assets/pdf.worker.min-CIqJB0yW.mjs".',
      ),
    ).toBe(true);
    expect(isStaleAssetError('error loading dynamically imported module')).toBe(true); // Firefox
    expect(isStaleAssetError('Importing a module script failed.')).toBe(true); // Safari
  });

  it('leaves other PDF errors alone', () => {
    expect(isStaleAssetError('Invalid PDF structure.')).toBe(false);
    expect(isStaleAssetError('Cannot reach the runtime at http://127.0.0.1:4317')).toBe(false);
  });
});
