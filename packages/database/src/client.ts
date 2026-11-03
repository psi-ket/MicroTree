import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type StudioDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: StudioDb;
  sqlite: Database.Database;
  close(): void;
}

/** Default data directory shared by the runtime and the migration CLI. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RS_DATA_DIR ? path.resolve(env.RS_DATA_DIR) : path.join(os.homedir(), '.research-studio');
}

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RS_DB_PATH ? path.resolve(env.RS_DB_PATH) : path.join(defaultDataDir(env), 'studio.db');
}

/** Location of the committed SQL migrations (overridable for bundled builds). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export function openDatabase(file: string): DatabaseHandle {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export function migrateDatabase(handle: DatabaseHandle, migrationsFolder = DEFAULT_MIGRATIONS_DIR): void {
  migrate(handle.db, { migrationsFolder });
}

/** Open and migrate in one step. */
export function createDatabase(file: string, migrationsFolder?: string): DatabaseHandle {
  const handle = openDatabase(file);
  try {
    migrateDatabase(handle, migrationsFolder);
  } catch (err) {
    handle.close();
    throw err;
  }
  return handle;
}
