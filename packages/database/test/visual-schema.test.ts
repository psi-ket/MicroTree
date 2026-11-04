import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src';

// Constraint tests for the M4 visual tables.
let handle: DatabaseHandle;
const ts = '2026-11-03T10:00:00.000Z';
beforeEach(() => {
  handle = createDatabase(':memory:');
});
afterEach(() => handle.close());

function artifact(id: string) {
  handle.db.insert(schema.visualArtifacts).values({ id, artifactType: 'equation', title: 'E', currentVersion: 1, createdAt: ts, updatedAt: ts }).run();
}
function version(id: string, artifactId: string, n: number) {
  handle.db.insert(schema.visualArtifactVersions).values({ id, artifactId, versionNumber: n, sourceCode: 'x', origin: 'model', changeDescription: 'first', createdAt: ts }).run();
}
const count = (t: string) => (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('visual schema', () => {
  it('numbers versions uniquely per artifact and drops them with it', () => {
    artifact('a1');
    artifact('a2');
    version('v1', 'a1', 1);
    version('v2', 'a1', 2);
    version('v3', 'a2', 1);
    expect(() => version('v4', 'a1', 2)).toThrow(/UNIQUE/);
    handle.sqlite.prepare("DELETE FROM visual_artifacts WHERE id = 'a1'").run();
    expect(count('visual_artifact_versions')).toBe(1);
  });

  it('keeps assets, artifacts and tasks when their project goes, and drops insertions', () => {
    handle.sqlite.prepare("INSERT INTO projects (id, name, slug, root_path, created_at, updated_at) VALUES ('p1', 'P', 'p', '/tmp/p', ?, ?)").run(ts, ts);
    handle.db
      .insert(schema.visualAssets)
      .values({ id: 'as1', kind: 'original', originalAssetId: 'as1', storageKey: 'k', mimeType: 'image/png', fileSize: 1, sha256: 's', provenance: { source: 'upload', fileName: 'a.png' }, label: 'a.png', projectId: 'p1', createdAt: ts })
      .run();
    handle.db.insert(schema.visualArtifacts).values({ id: 'a1', artifactType: 'plot', title: 'P', currentVersion: 1, projectId: 'p1', createdAt: ts, updatedAt: ts }).run();
    handle.db.insert(schema.visualTasks).values({ id: 't1', taskType: 'plot', privacyMode: 'local', promptVersion: '1', config: {}, status: 'completed', projectId: 'p1', createdAt: ts, updatedAt: ts }).run();
    handle.db.insert(schema.visualInsertions).values({ id: 'i1', projectId: 'p1', artifactId: 'a1', versionNumber: 1, createdFiles: [], modifiedFiles: [], status: 'applied', createdAt: ts }).run();
    handle.sqlite.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect([count('visual_assets'), count('visual_artifacts'), count('visual_tasks'), count('visual_insertions')]).toEqual([1, 1, 1, 0]);
    expect(handle.sqlite.prepare("SELECT project_id FROM visual_assets").get()).toEqual({ project_id: null });
  });

  it('can be rolled back with the down script and applied again', () => {
    artifact('a1');
    handle.sqlite.exec(readFileSync(fileURLToPath(new URL('../migrations/down/0004_visual.sql', import.meta.url)), 'utf8'));
    handle.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)').run();
    const tables = () => (handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'visual_%'").all() as unknown[]).length;
    expect(tables()).toBe(0);
    expect(count('document_extractions')).toBe(0);
    migrateDatabase(handle);
    expect(tables()).toBe(5);
  });
});
