import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type DatabaseHandle } from '@research-studio/database';
import { titleKey } from '@research-studio/literature-engine';
import { DEFAULT_LIBRARY_PREFERENCES, StudioError, type LibraryPreferences, type ScholarlyWork } from '@research-studio/shared-types';
import { AttachmentService } from '../../src/attachments/attachment-service';
import { AttachmentStorage } from '../../src/attachments/attachment-storage';
import { CollectionRepository } from '../../src/collections/collection-repository';
import { CollectionService } from '../../src/collections/collection-service';
import { LibraryRepository } from '../../src/library/library-repository';
import { LibraryService, type LibraryChange } from '../../src/library/library-service';
import type { ScholarlyLookup } from '../../src/library/library-types';

/** An M3.1 stand-in: answers from a fixed set of works and records the calls. */
export class FakeLookup implements ScholarlyLookup {
  calls: string[] = [];
  failWith: Error | null = null;

  constructor(public works: ScholarlyWork[] = []) {}

  private answer(works: ScholarlyWork[]) {
    if (this.failWith) throw this.failWith;
    return { works, providerStatus: [] };
  }

  async resolveDoi(doi: string) {
    this.calls.push(`doi:${doi}`);
    const w = this.works.find((x) => x.identifiers.doi === doi);
    if (!w && !this.failWith) throw new StudioError('NOT_FOUND', 'No such DOI');
    return this.answer(w ? [w] : []);
  }

  async resolveArxiv(id: string) {
    this.calls.push(`arxiv:${id}`);
    const w = this.works.find((x) => x.identifiers.arxivId === id);
    if (!w && !this.failWith) throw new StudioError('NOT_FOUND', 'No such arXiv ID');
    return this.answer(w ? [w] : []);
  }

  async search(query: string, options: { limit: number }) {
    this.calls.push(`search:${query}`);
    const words = titleKey(query).split(' ').filter((w) => w.length > 3);
    return this.answer(this.works.filter((w) => words.some((x) => titleKey(w.title).includes(x))).slice(0, options.limit));
  }

  async work(id: string) {
    this.calls.push(`work:${id}`);
    if (this.failWith) throw this.failWith;
    const w = this.works.find((x) => x.id === id);
    if (!w) throw new StudioError('NOT_FOUND', 'No such work');
    return w;
  }
}

export interface TestLibrary {
  handle: DatabaseHandle;
  dir: string;
  storage: AttachmentStorage;
  repo: LibraryRepository;
  attachments: AttachmentService;
  library: LibraryService;
  collections: CollectionService;
  lookup: FakeLookup;
  prefs: LibraryPreferences;
  changes: LibraryChange[];
  /** Adds a project row (for project links). */
  addProject(name: string): string;
  close(): Promise<void>;
}

export async function createTestLibrary(works: ScholarlyWork[] = [], opts: { maxBytes?: number; withLookup?: boolean } = {}): Promise<TestLibrary> {
  const handle = createDatabase(':memory:');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rs-library-'));
  const storage = new AttachmentStorage(path.join(dir, 'library'));
  await storage.init();
  const repo = new LibraryRepository(handle.db, titleKey);
  const attachments = new AttachmentService(storage, repo, { maxBytes: opts.maxBytes ?? 5 * 1024 * 1024 });
  const collectionRepo = new CollectionRepository(handle.db);
  const lookup = new FakeLookup(works);
  const prefs = { ...DEFAULT_LIBRARY_PREFERENCES };
  const changes: LibraryChange[] = [];
  const library = new LibraryService({
    repo,
    collections: collectionRepo,
    attachments,
    lookup: opts.withLookup === false ? null : lookup,
    preferences: () => prefs,
    onChange: (c) => changes.push(c),
  });
  const collections = new CollectionService(collectionRepo, repo, undefined, (c) => changes.push(c));
  let n = 0;
  return {
    handle,
    dir,
    storage,
    repo,
    attachments,
    library,
    collections,
    lookup,
    prefs,
    changes,
    addProject(name) {
      const id = `p${++n}`;
      handle.sqlite
        .prepare('insert into projects (id, name, slug, root_path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
        .run(id, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${n}`, path.join(dir, 'projects', id), '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z');
      return id;
    },
    async close() {
      handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
