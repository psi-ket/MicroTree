import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src';

// Constraint tests for the M5 evidence tables.
let handle: DatabaseHandle;
const ts = '2026-11-04T10:00:00.000Z';
const count = (t: string) => (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

beforeEach(() => {
  handle = createDatabase(':memory:');
  handle.sqlite.prepare("INSERT INTO projects (id, name, slug, root_path, created_at, updated_at) VALUES ('p1', 'P', 'p', '/tmp/p', ?, ?)").run(ts, ts);
  handle.sqlite
    .prepare("INSERT INTO scholarly_works (id, origin, work, title_key, created_at, updated_at) VALUES ('w1', 'manual', '{}', 'w1', ?, ?)")
    .run(ts, ts);
  handle.sqlite.prepare("INSERT INTO library_items (id, scholarly_work_id, metadata_status, added_at, updated_at) VALUES ('i1', 'w1', 'manual', ?, ?)").run(ts, ts);
});
afterEach(() => handle.close());

function claim(id: string) {
  handle.db
    .insert(schema.scientificClaims)
    .values({
      id,
      projectId: 'p1',
      documentId: 'main.tex',
      documentBlockId: 'mbk_1',
      originalText: 'Surface codes are local.',
      claimText: 'Surface codes are local.',
      normalizedText: 'surface codes are local',
      claimType: 'theoretical',
      atomicity: 'atomic',
      textHash: 'h',
      documentRevision: 'r1',
      status: 'unchecked',
      reviewState: 'proposed',
      requiresEvidence: true,
      extractedBy: 'heuristic',
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
}
function source(id: string, hash: string) {
  handle.db
    .insert(schema.evidenceSources)
    .values({ id, snapshotHash: hash, level: 'full_text', scholarlyWorkId: 'w1', libraryItemId: 'i1', passageId: 'dex_1_p0', title: 'A paper', text: 'Surface codes need only local checks.', createdAt: ts })
    .run();
}
function record(id: string, claimId: string, sourceId: string) {
  handle.db.insert(schema.evidenceRecords).values({ id, claimId, sourceId, retrievalMethod: 'hybrid', claimTextHash: 'h', status: 'active', retrievedAt: ts }).run();
}
function assessment(id: string, recordId: string, status: 'current' | 'superseded') {
  handle.db
    .insert(schema.evidenceAssessments)
    .values({
      id,
      claimId: 'c1',
      evidenceRecordId: recordId,
      assessment: 'direct_support',
      explanation: 'x',
      excerptVerified: true,
      uncertainty: 'low',
      modelProvider: 'ollama',
      modelId: 'm',
      promptVersion: '1',
      assessmentVersion: '1',
      claimTextHash: 'h',
      sourceSnapshotHash: 's1',
      status,
      createdAt: ts,
    })
    .run();
}

describe('evidence schema', () => {
  it('links one source to many claims once each, and keeps assessment history', () => {
    claim('c1');
    claim('c2');
    source('s1', 'snap1');
    expect(() => source('s2', 'snap1')).toThrow(/UNIQUE/);
    record('r1', 'c1', 's1');
    record('r2', 'c2', 's1');
    expect(() => record('r3', 'c1', 's1')).toThrow(/UNIQUE/);
    assessment('a1', 'r1', 'superseded');
    assessment('a2', 'r1', 'current');
    expect(count('evidence_assessments')).toBe(2);
  });

  it('keeps source provenance when the paper leaves the library or a claim is removed', () => {
    claim('c1');
    source('s1', 'snap1');
    record('r1', 'c1', 's1');
    handle.sqlite.prepare("DELETE FROM library_items WHERE id = 'i1'").run();
    handle.sqlite.prepare("DELETE FROM scholarly_works WHERE id = 'w1'").run();
    expect(handle.sqlite.prepare("SELECT scholarly_work_id, library_item_id, text FROM evidence_sources WHERE id = 's1'").get()).toEqual({ scholarly_work_id: null, library_item_id: null, text: 'Surface codes need only local checks.' });
    handle.sqlite.prepare("DELETE FROM scientific_claims WHERE id = 'c1'").run();
    expect([count('evidence_records'), count('evidence_sources')]).toEqual([0, 1]);
  });

  it('removes a project’s analysis with the project, but not the sources', () => {
    claim('c1');
    source('s1', 'snap1');
    record('r1', 'c1', 's1');
    handle.db.insert(schema.evidenceJobs).values({ id: 'j1', projectId: 'p1', kind: 'extract', status: 'queued', input: {}, progress: { done: 0, total: 0, message: null }, createdAt: ts, updatedAt: ts }).run();
    handle.sqlite.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect([count('scientific_claims'), count('evidence_records'), count('evidence_jobs'), count('evidence_sources')]).toEqual([0, 0, 0, 1]);
  });

  it('can be rolled back with the down script and applied again', () => {
    claim('c1');
    handle.sqlite.exec(readFileSync(fileURLToPath(new URL('../migrations/down/0005_evidence.sql', import.meta.url)), 'utf8'));
    handle.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)').run();
    const tables = () =>
      (handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'evidence_%' OR name LIKE 'manuscript_%' OR name IN ('scientific_claims','claim_anchors','conflict_analyses','citation_recommendations','writing_suggestions'))").all() as unknown[]).length;
    expect(tables()).toBe(0);
    expect(count('library_items')).toBe(1);
    migrateDatabase(handle);
    expect(tables()).toBe(14);
  });
});
