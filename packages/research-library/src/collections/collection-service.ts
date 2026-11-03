import type { LibraryCollection } from '@research-studio/shared-types';
import { LibraryError, notFound } from '../errors/library-errors';
import type { LibraryChange } from '../library/library-service';
import { newLibraryId } from '../library/library-service';
import type { LibraryRepository } from '../library/library-repository';
import type { CollectionRepository } from './collection-repository';

const COLOR = /^#[0-9a-f]{6}$/i;

export interface CollectionInput {
  name: string;
  description?: string | null;
  color?: string | null;
}

/** Collections group papers; a paper can be in any number of them. Deleting a collection never deletes its papers. */
export class CollectionService {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly repo: LibraryRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onChange?: (change: LibraryChange) => void,
  ) {}

  list(): LibraryCollection[] {
    return this.collections.list();
  }

  get(id: string): LibraryCollection {
    const c = this.collections.get(id);
    if (!c) throw notFound('Collection', id);
    return c;
  }

  private clean(input: Partial<CollectionInput>): Partial<CollectionInput> {
    const out: Partial<CollectionInput> = {};
    if (input.name !== undefined) {
      const name = input.name.replace(/\s+/g, ' ').trim();
      if (!name) throw new LibraryError('VALIDATION_FAILED', 'A collection needs a name');
      if (name.length > 120) throw new LibraryError('VALIDATION_FAILED', 'Collection names are at most 120 characters');
      out.name = name;
    }
    if (input.description !== undefined) out.description = input.description?.trim().slice(0, 2000) || null;
    if (input.color !== undefined) {
      if (input.color !== null && !COLOR.test(input.color)) throw new LibraryError('VALIDATION_FAILED', 'Colors are written as #rrggbb');
      out.color = input.color;
    }
    return out;
  }

  private assertNameFree(name: string, exceptId?: string) {
    const other = this.collections.byName(name);
    if (other && other.id !== exceptId) throw new LibraryError('ALREADY_EXISTS', `A collection named "${other.name}" already exists`, { collectionId: other.id });
  }

  create(input: CollectionInput): LibraryCollection {
    const clean = this.clean(input);
    this.assertNameFree(clean.name!);
    const now = this.now();
    const row = this.collections.insert({
      id: newLibraryId('col'),
      name: clean.name!,
      description: clean.description ?? null,
      color: clean.color ?? null,
      createdAt: now,
      updatedAt: now,
    });
    this.onChange?.({ kind: 'collections', ids: [row.id] });
    return this.get(row.id);
  }

  update(id: string, input: Partial<CollectionInput>): LibraryCollection {
    if (!this.collections.getRow(id)) throw notFound('Collection', id);
    const clean = this.clean(input);
    if (clean.name) this.assertNameFree(clean.name, id);
    this.collections.update(id, { ...clean, updatedAt: this.now() });
    this.onChange?.({ kind: 'collections', ids: [id] });
    return this.get(id);
  }

  /** Delete the collection; its papers stay in the library (and in other collections). */
  delete(id: string): void {
    if (!this.collections.delete(id)) throw notFound('Collection', id);
    this.onChange?.({ kind: 'collections', ids: [id] });
  }

  private checkItems(itemIds: readonly string[]) {
    const found = this.repo.getItems(itemIds);
    if (found.length !== new Set(itemIds).size) throw new LibraryError('NOT_FOUND', 'Some library items no longer exist');
  }

  addItems(id: string, itemIds: readonly string[]): number {
    if (!this.collections.getRow(id)) throw notFound('Collection', id);
    this.checkItems(itemIds);
    const n = this.collections.addItems(id, itemIds, this.now());
    this.onChange?.({ kind: 'collections', ids: [id] });
    return n;
  }

  removeItems(id: string, itemIds: readonly string[]): number {
    if (!this.collections.getRow(id)) throw notFound('Collection', id);
    const n = this.collections.removeItems(id, itemIds);
    this.onChange?.({ kind: 'collections', ids: [id] });
    return n;
  }

  /** Move items from one collection to another (drag and drop between collections). */
  moveItems(fromId: string, toId: string, itemIds: readonly string[]): number {
    if (fromId === toId) return 0;
    if (!this.collections.getRow(fromId)) throw notFound('Collection', fromId);
    if (!this.collections.getRow(toId)) throw notFound('Collection', toId);
    this.checkItems(itemIds);
    const now = this.now();
    this.repo.transaction(() => {
      this.collections.addItems(toId, itemIds, now);
      this.collections.removeItems(fromId, itemIds);
    });
    this.onChange?.({ kind: 'collections', ids: [fromId, toId] });
    return itemIds.length;
  }
}
