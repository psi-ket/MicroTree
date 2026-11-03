import { defineConfig } from 'drizzle-kit';

// Generated SQL is reviewed by hand: foreign keys to `projects` (owned by
// @research-studio/database) are added manually, since that table is not part
// of this schema.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
