/**
 * Apply pending migrations: `pnpm db:migrate` (honours RS_DB_PATH / RS_DATA_DIR).
 */
import { createDatabase, defaultDatabasePath } from '../client';

const file = process.argv[2] ?? defaultDatabasePath();
try {
  const handle = createDatabase(file);
  const rows = handle.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
  handle.close();
  console.info(`Database ready at ${file} (${rows.n} migration(s) applied)`);
} catch (err) {
  console.error(`Migration failed for ${file}:`, err);
  process.exitCode = 1;
}
