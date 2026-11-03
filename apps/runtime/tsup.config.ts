import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'rotate-token': 'src/cli/rotate-token.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle workspace packages (they ship TypeScript source); keep npm dependencies external.
  noExternal: [/^@research-studio\//],
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    await cp('../../packages/database/migrations', 'dist/migrations', { recursive: true });
    await cp('../../packages/ai-storage/migrations', 'dist/ai-migrations', { recursive: true });
  },
  env: {},
});
