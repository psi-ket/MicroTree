import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test files share the TeX toolchain; run them one at a time to keep timings stable.
    fileParallelism: false,
  },
});
