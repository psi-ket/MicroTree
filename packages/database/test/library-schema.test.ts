import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScholarlyWork } from '@research-studio/shared-types';
import { createDatabase, createRepositories, migrateDatabase, schema, type DatabaseHandle } from '../src';

// Constraint tests for the library tables (M3.2), written against the tables
// directly so they hold whatever the repositories above them do.

let handle: DatabaseHandle;
const ts = '2026-11-03T10:00:00.000Z';

beforeEach(() => {
  handle = createDatabase(':memory:');
});
afterEach(() => handle.close());

function work(title: string): ScholarlyWork {
  return {
    id: `local:${title}`,
    title,
    abstract: null,
    abstractSource: null,
    authors: [],
    publicationDate: null,
    publicationYear: null,
    dates: { published: null, publishedOnline: null, publishedPrint: null, submitted: null, updated: null },
    venue: null,
    publisher: null,
    publicationType: null,
    bibliographic: { volume: null, issue: null, pages: null, issn: [] },
    categories: [],
    identifiers: { doi: null, arxivId: null, openAlexId: null, semanticScholarId: null, pmid: null },
    urls: { landingPage: null, pdf: null, abstract: null },
    openAccess: { isOpenAccess: null, status: null, license: null, pdfUrl: null },
    citation: { citedByCount: null, citedBySource: null, referenceCount: null, observations: [] },
    conflicts: [],
    sourceRecords: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function addWork(id: string, opts: { doi?: string; arxivId?: string; canonicalId?: string } = {}) {
  handle.db
    .insert(schema.scholarlyWorks)
    .values({
      id,
      canonicalId: opts.canonicalId ?? null,
      origin: 'manual',
      work: work(id),
      doi: opts.doi ?? null,
      arxivId: opts.arxivId ?? null,
      titleKey: id,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
}

function addItem(id: string, workId: string, citationKey: string | null = null) {
  handle.db
    .insert(schema.libraryItems)
    .values({ id, scholarlyWorkId: workId, citationKey, metadataStatus: 'manual', addedAt: ts, updatedAt: ts })
    .run();
}

function addAttachment(id: string, itemId: string, sha: string) {
  handle.db
    .insert(schema.libraryAttachments)
    .values({
      id,
      libraryItemId: itemId,
      fileName: 'paper.pdf',
      originalFileName: 'Paper.pdf',
      storageKey: `objects/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`,
      mimeType: 'application/pdf',
      fileSize: 10,
      sha256: sha,
      attachmentType: 'pdf',
      source: 'upload',
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
}

const count = (table: string) => (handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('library schema', () => {
  it('creates a library item for a work, and only one per work', () => {
    addWork('w1');
    addItem('i1', 'w1');
    expect(count('library_items')).toBe(1);
    expect(() => addItem('i2', 'w1')).toThrow(/UNIQUE/);
  });

  it('refuses a second work with the same DOI, arXiv ID or canonical ID', () => {
    addWork('w1', { doi: '10.1103/physreva.52.r2493', arxivId: '1706.03762', canonicalId: 'doi:10.1103/physreva.52.r2493' });
    expect(() => addWork('w2', { doi: '10.1103/physreva.52.r2493' })).toThrow(/UNIQUE.*doi/);
    expect(() => addWork('w3', { arxivId: '1706.03762' })).toThrow(/UNIQUE.*arxiv_id/);
    expect(() => addWork('w4', { canonicalId: 'doi:10.1103/physreva.52.r2493' })).toThrow(/UNIQUE.*canonical_id/);
    // Works without identifiers can coexist.
    addWork('w5');
    addWork('w6');
    expect(count('scholarly_works')).toBe(3);
  });

  it('keeps citation keys unique regardless of case, and allows many items without a key', () => {
    addWork('w1');
    addWork('w2');
    addWork('w3');
    addWork('w4');
    addItem('i1', 'w1', 'shor1995scheme');
    expect(() => addItem('i2', 'w2', 'Shor1995Scheme')).toThrow(/UNIQUE/);
    addItem('i3', 'w3', null);
    addItem('i4', 'w4', null);
    expect(count('library_items')).toBe(3);
  });

  it('does not delete a work that a library item still uses', () => {
    addWork('w1');
    addItem('i1', 'w1');
    expect(() => handle.db.delete(schema.scholarlyWorks).where(eq(schema.scholarlyWorks.id, 'w1')).run()).toThrow(/FOREIGN KEY/);
  });

  it('puts one item in several collections; deleting a collection keeps the items', () => {
    addWork('w1');
    addItem('i1', 'w1');
    for (const [id, name] of [['c1', 'Bosonic codes'], ['c2', 'Papers to read']]) {
      handle.db.insert(schema.libraryCollections).values({ id: id!, name: name!, createdAt: ts, updatedAt: ts }).run();
      handle.db.insert(schema.libraryCollectionItems).values({ collectionId: id!, libraryItemId: 'i1', addedAt: ts }).run();
    }
    expect(count('library_collection_items')).toBe(2);
    // The same membership twice is refused.
    expect(() =>
      handle.db.insert(schema.libraryCollectionItems).values({ collectionId: 'c1', libraryItemId: 'i1', addedAt: ts }).run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    // Collection names are unique regardless of case.
    expect(() =>
      handle.db.insert(schema.libraryCollections).values({ id: 'c3', name: 'bosonic CODES', createdAt: ts, updatedAt: ts }).run(),
    ).toThrow(/UNIQUE/);

    handle.db.delete(schema.libraryCollections).where(eq(schema.libraryCollections.id, 'c1')).run();
    expect(count('library_collection_items')).toBe(1);
    expect(count('library_items')).toBe(1);
  });

  it('links tags to items; deleting an item removes its tag links but not the tags', () => {
    addWork('w1');
    addItem('i1', 'w1');
    handle.db.insert(schema.libraryTags).values({ id: 't1', name: 'surface-code', createdAt: ts }).run();
    handle.db.insert(schema.libraryItemTags).values({ libraryItemId: 'i1', tagId: 't1' }).run();
    expect(() => handle.db.insert(schema.libraryItemTags).values({ libraryItemId: 'i1', tagId: 't1' }).run()).toThrow();
    expect(() => handle.db.insert(schema.libraryTags).values({ id: 't2', name: 'Surface-Code', createdAt: ts }).run()).toThrow(/UNIQUE/);
    handle.db.delete(schema.libraryItems).where(eq(schema.libraryItems.id, 'i1')).run();
    expect(count('library_item_tags')).toBe(0);
    expect(count('library_tags')).toBe(1);
  });

  it('allows one file on several items but not twice on the same item', () => {
    const sha = 'a'.repeat(64);
    addWork('w1');
    addWork('w2');
    addItem('i1', 'w1');
    addItem('i2', 'w2');
    addAttachment('a1', 'i1', sha);
    addAttachment('a2', 'i2', sha);
    expect(() => addAttachment('a3', 'i1', sha)).toThrow(/UNIQUE/);
    const owners = handle.sqlite.prepare('SELECT count(*) AS n FROM library_attachments WHERE sha256 = ?').get(sha) as { n: number };
    expect(owners.n).toBe(2);
    // Removing one item leaves the other attachment row (the file stays owned).
    handle.db.delete(schema.libraryItems).where(eq(schema.libraryItems.id, 'i1')).run();
    expect(count('library_attachments')).toBe(1);
  });

  it('maps each external item to one library item per external library', () => {
    addWork('w1');
    addWork('w2');
    addItem('i1', 'w1');
    addItem('i2', 'w2');
    const link = (id: string, item: string, ext: string, lib = 'web:users/1') =>
      handle.db
        .insert(schema.libraryExternalLinks)
        .values({ id, libraryItemId: item, provider: 'zotero', externalLibraryId: lib, externalItemId: ext, syncStatus: 'synced' })
        .run();
    link('l1', 'i1', 'ABCD2345');
    expect(() => link('l2', 'i2', 'ABCD2345')).toThrow(/UNIQUE/); // same Zotero item twice
    expect(() => link('l3', 'i1', 'EFGH2345')).toThrow(/UNIQUE/); // same library item twice in one library
    link('l4', 'i1', 'ABCD2345', 'local:server-1:users/0'); // another Zotero library is separate
    expect(count('library_external_links')).toBe(2);
  });

  it('links items to projects once, and drops the links with the project', () => {
    const repos = createRepositories(handle.db);
    repos.projects.create({ id: 'p1', name: 'Paper', slug: 'paper', rootPath: '/w/paper', mainFile: 'main.tex', engine: 'pdflatex' });
    addWork('w1');
    addItem('i1', 'w1');
    handle.db.insert(schema.libraryProjectLinks).values({ id: 'pl1', projectId: 'p1', libraryItemId: 'i1', createdAt: ts }).run();
    expect(() =>
      handle.db.insert(schema.libraryProjectLinks).values({ id: 'pl2', projectId: 'p1', libraryItemId: 'i1', createdAt: ts }).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      handle.db.insert(schema.libraryProjectLinks).values({ id: 'pl3', projectId: 'nope', libraryItemId: 'i1', createdAt: ts }).run(),
    ).toThrow(/FOREIGN KEY/);
    repos.projects.delete('p1');
    expect(count('library_project_links')).toBe(0);
    expect(count('library_items')).toBe(1);
  });

  it('can be rolled back with the down script and applied again', () => {
    addWork('w1');
    // Later migrations depend on the library tables, so they are rolled back first (newest first).
    for (const name of ['0003_documents', '0002_library']) {
      const down = readFileSync(fileURLToPath(new URL(`../migrations/down/${name}.sql`, import.meta.url)), 'utf8');
      handle.sqlite.exec(down);
      // drizzle's bookkeeping table has no usable id in SQLite; the latest row is the one with the newest created_at.
      handle.sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)').run();
    }
    const tables = () =>
      (handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'library_%' OR name = 'scholarly_works')").all() as {
        name: string;
      }[]).length;
    expect(tables()).toBe(0);
    expect(count('projects')).toBe(0); // core tables untouched
    migrateDatabase(handle);
    expect(tables()).toBe(11);
  });
});
