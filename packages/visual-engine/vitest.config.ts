import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generator tests compile with the real TeX toolchain when it is installed
    // (a few seconds per standalone document, more on a first run).
    testTimeout: 120_000,
  },
});
