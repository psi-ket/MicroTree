import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyMetadata, type ExtractionQuality } from '@research-studio/document-intelligence';
import { createDatabase, migrateDatabase, schema, type DatabaseHandle } from '../src';

// Constraint tests for the M3.3 document tables, written against the tables directly.

let handle: DatabaseHandle;
const ts = '2026-11-03T10:00:00.000Z';
const sha = 'a'.repeat(64);
const quality: ExtractionQuality = {
  textCoverage: null,
  hasTitle: false,
  hasAbstract: false,
  sectionCount: 0,
  paragraphCount: 0,
  referenceCount: 0,
  coordinateCoverage: 0,
  emptyPages: [],
  structure: 'structured',
};

beforeEach(() => {
  handle = createDatabase(':memory:');
  const s = handle.sqlite;
  s.prepare(
    `INSERT INTO scholarly_works (id, origin, work, title_key, created_at, updated_at) VALUES ('w1', 'manual', '{}', 'w1', ?, ?)`,
  ).run(ts, ts);
  s.prepare(`INSERT INTO library_items (id, scholarly_work_id, metadata_status, added_at, updated_at) VALUES ('li1', 'w1', 'manual', ?, ?)`).run(ts, ts);
  s.prepare(
    `INSERT INTO library_attachments (id, library_item_id, file_name, original_file_name, storage_key, mime_type, file_size, sha256, attachment_type, source, created_at, updated_at)
     VALUES ('att1', 'li1', 'p.pdf', 'p.pdf', ?, 'application/pdf', 10, ?, 'pdf', 'upload', ?, ?)`,
  ).run(`objects/aa/aa/${sha}.pdf`, sha, ts, ts);
});
afterEach(() => handle.close());

function addExtraction(id: string, active: boolean) {
  handle.db
    .insert(schema.documentExtractions)
    .values({
      id,
      attachmentId: 'att1',
      libraryItemId: 'li1',
      scholarlyWorkId: 'w1',
      sourceSha256: sha,
      extractor: 'grobid',
      extractorVersion: '0.8.2',
      parserVersion: '1.0.0',
      segmenterVersion: '1.0.0',
      config: {},
      configHash: 'cfg',
      status: 'completed',
      isActive: active,
      metadata: emptyMetadata(),
      quality,
      processingStartedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
}

function addPassage(id: string, extractionId: string, order: number, text: string) {
  handle.db
    .insert(schema.documentPassages)
    .values({
      id,
      extractionId,
      passageOrder: order,
      kind: 'body',
      sectionPath: 'Introduction',
      sectionType: 'introduction',
      text,
      normalizedText: text.toLowerCase(),
      textHash: `h-${id}`,
      stableKey: `k-${id}`,
      tokenCount: 3,
      createdAt: ts,
    })
    .run();
  handle.sqlite
    .prepare('INSERT INTO passage_fts (body, heading, passage_id, extraction_id, kind, section_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(text.toLowerCase(), 'introduction', id, extractionId, 'body', 'introduction');
}

const count = (table: string) => (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('document schema', () => {
  it('allows many extractions of an attachment but only one active', () => {
    addExtraction('x1', true);
    addExtraction('x2', false);
    expect(() => addExtraction('x3', true)).toThrow(/UNIQUE/);
    handle.sqlite.prepare('UPDATE document_extractions SET is_active = 0 WHERE id = ?').run('x1');
    handle.sqlite.prepare('UPDATE document_extractions SET is_active = 1 WHERE id = ?').run('x2');
    expect(count('document_extractions')).toBe(2);
  });

  it('keeps one unfinished job per attachment and configuration', () => {
    const job = (id: string, status: 'queued' | 'completed' | 'extracting', configHash = 'cfg') =>
      handle.db
        .insert(schema.documentJobs)
        .values({ id, kind: 'process', attachmentId: 'att1', libraryItemId: 'li1', configHash, status, createdAt: ts, updatedAt: ts })
        .run();
    job('j1', 'completed');
    job('j2', 'queued');
    expect(() => job('j3', 'extracting')).toThrow(/UNIQUE/);
    job('j4', 'queued', 'other-config');
    expect(count('document_jobs')).toBe(3);
  });

  it('removes passages, their keyword rows and vector links with the extraction', () => {
    addExtraction('x1', true);
    addPassage('p1', 'x1', 0, 'Lindblad master equation');
    addPassage('p2', 'x1', 1, 'Bosonic codes');
    handle.db.insert(schema.embeddingSpaces).values({ id: 'sp1', provider: 'ollama', model: 'm', dimensions: 2, createdAt: ts }).run();
    handle.db.insert(schema.embeddingVectors).values({ spaceId: 'sp1', textHash: 'h-p1', vector: Buffer.alloc(8), createdAt: ts }).run();
    handle.db.insert(schema.passageEmbeddings).values({ spaceId: 'sp1', passageId: 'p1', extractionId: 'x1', textHash: 'h-p1', embeddedAt: ts }).run();
    expect(handle.sqlite.prepare("SELECT passage_id FROM passage_fts WHERE passage_fts MATCH 'lindblad'").all()).toEqual([{ passage_id: 'p1' }]);

    handle.db.delete(schema.documentExtractions).where(eq(schema.documentExtractions.id, 'x1')).run();
    expect(count('document_passages')).toBe(0);
    expect(count('passage_fts')).toBe(0);
    expect(count('passage_embeddings')).toBe(0);
    // The cached vector stays for reuse until a sweep removes unreferenced ones.
    expect(count('embedding_vectors')).toBe(1);
  });

  it('drops extractions and jobs when the attachment or the item goes, keeping works', () => {
    addExtraction('x1', true);
    addPassage('p1', 'x1', 0, 'tensor networks');
    handle.db
      .insert(schema.documentJobs)
      .values({ id: 'j1', kind: 'process', attachmentId: 'att1', libraryItemId: 'li1', configHash: 'c', status: 'queued', createdAt: ts, updatedAt: ts })
      .run();
    handle.sqlite.prepare("DELETE FROM library_items WHERE id = 'li1'").run();
    expect(count('document_extractions')).toBe(0);
    expect(count('document_jobs')).toBe(0);
    expect(count('passage_fts')).toBe(0);
    expect(count('scholarly_works')).toBe(1);
  });

  it('unlinks extracted references when the linked work is deleted', () => {
    addExtraction('x1', true);
    handle.sqlite.prepare(
      `INSERT INTO scholarly_works (id, origin, work, title_key, created_at, updated_at) VALUES ('w2', 'manual', '{}', 'w2', ?, ?)`,
    ).run(ts, ts);
    handle.db
      .insert(schema.documentReferences)
      .values({ id: 'r1', extractionId: 'x1', referenceOrder: 0, parsedMetadata: { title: null, authors: [], venue: null, year: null, volume: null, pages: null, publisher: null }, linkedScholarlyWorkId: 'w2', resolutionStatus: 'matched-doi' })
      .run();
    handle.sqlite.prepare("DELETE FROM scholarly_works WHERE id = 'w2'").run();
    expect(handle.sqlite.prepare("SELECT linked_scholarly_work_id AS w FROM document_references WHERE id = 'r1'").get()).toEqual({ w: null });
  });

  it('keeps embedding spaces apart by provider, model, dimensions and version', () => {
    const space = (id: string, dimensions: number, modelVersion = '') =>
      handle.db.insert(schema.embeddingSpaces).values({ id, provider: 'ollama', model: 'nomic-embed-text', dimensions, modelVersion, createdAt: ts }).run();
    space('a', 768);
    space('b', 768, 'sha256:2');
    space('c', 384);
    expect(() => space('d', 768)).toThrow(/UNIQUE/);
  });

  it('can be rolled back with the down script and applied again', () => {
    addExtraction('x1', true);
    const down = readFileSync(fileURLToPath(new URL('../migrations/down/0003_documents.sql', import.meta.url)), 'utf8');
    handle.sqlite.exec(down);
    handle.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)').run();
    const tables = () =>
      (handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'document_%' OR name LIKE 'passage_%' OR name LIKE 'embedding_%')")
        .all() as unknown[]).length;
    expect(tables()).toBe(0);
    expect(count('library_attachments')).toBe(1);
    migrateDatabase(handle);
    expect(tables()).toBe(18); // 12 tables, the FTS table and its 5 shadow tables
  });
});
