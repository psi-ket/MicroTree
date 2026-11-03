// Removes the throwaway E2E data directory before the runtime starts.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../apps/runtime/.e2e-data', import.meta.url)), { recursive: true, force: true });
