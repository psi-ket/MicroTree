import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';
import type { LibraryCollection } from '@research-studio/shared-types';

const { libraryCollections, libraryCollectionItems, libraryItems } = schema;

export type CollectionRow = typeof libraryCollections.$inferSelect;

export class CollectionRepository {
  constructor(private readonly db: StudioDb) {}

  list(): LibraryCollection[] {
    return this.db
      .select({
        id: libraryCollections.id,
        name: libraryCollections.name,
        description: libraryCollections.description,
        color: libraryCollections.color,
        createdAt: libraryCollections.createdAt,
        updatedAt: libraryCollections.updatedAt,
        // Archived items still belong to the collection but are not counted.
        itemCount: sql<number>`count(${libraryItems.id})`,
      })
      .from(libraryCollections)
      .leftJoin(libraryCollectionItems, eq(libraryCollectionItems.collectionId, libraryCollections.id))
      .leftJoin(libraryItems, and(eq(libraryItems.id, libraryCollectionItems.libraryItemId), isNull(libraryItems.archivedAt)))
      .groupBy(libraryCollections.id)
      .orderBy(asc(sql`lower(${libraryCollections.name})`))
      .all();
  }

  get(id: string): LibraryCollection | null {
    return this.list().find((c) => c.id === id) ?? null;
  }

  getRow(id: string): CollectionRow | null {
    return this.db.select().from(libraryCollections).where(eq(libraryCollections.id, id)).get() ?? null;
  }

  byName(name: string): CollectionRow | null {
    return this.db.select().from(libraryCollections).where(sql`lower(${libraryCollections.name}) = ${name.trim().toLowerCase()}`).get() ?? null;
  }

  insert(row: typeof libraryCollections.$inferInsert): CollectionRow {
    return this.db.insert(libraryCollections).values(row).returning().get();
  }

  update(id: string, patch: Partial<typeof libraryCollections.$inferInsert>): void {
    this.db.update(libraryCollections).set(patch).where(eq(libraryCollections.id, id)).run();
  }

  /** Deletes the collection and its memberships; the papers stay in the library. */
  delete(id: string): boolean {
    return this.db.delete(libraryCollections).where(eq(libraryCollections.id, id)).run().changes > 0;
  }

  addItems(collectionId: string, itemIds: readonly string[], now: string): number {
    let added = 0;
    for (const libraryItemId of itemIds) {
      added += this.db.insert(libraryCollectionItems).values({ collectionId, libraryItemId, addedAt: now }).onConflictDoNothing().run().changes;
    }
    return added;
  }

  removeItems(collectionId: string, itemIds: readonly string[]): number {
    if (!itemIds.length) return 0;
    return this.db
      .delete(libraryCollectionItems)
      .where(and(eq(libraryCollectionItems.collectionId, collectionId), inArray(libraryCollectionItems.libraryItemId, [...itemIds])))
      .run().changes;
  }

  itemIds(collectionId: string): string[] {
    return this.db
      .select({ id: libraryCollectionItems.libraryItemId })
      .from(libraryCollectionItems)
      .where(eq(libraryCollectionItems.collectionId, collectionId))
      .orderBy(asc(libraryCollectionItems.addedAt))
      .all()
      .map((r) => r.id);
  }

  collectionsForItems(itemIds: readonly string[]): Map<string, { id: string; name: string; color: string | null }[]> {
    const out = new Map<string, { id: string; name: string; color: string | null }[]>();
    if (!itemIds.length) return out;
    for (const r of this.db
      .select({ itemId: libraryCollectionItems.libraryItemId, id: libraryCollections.id, name: libraryCollections.name, color: libraryCollections.color })
      .from(libraryCollectionItems)
      .innerJoin(libraryCollections, eq(libraryCollectionItems.collectionId, libraryCollections.id))
      .where(inArray(libraryCollectionItems.libraryItemId, [...itemIds]))
      .orderBy(asc(sql`lower(${libraryCollections.name})`))
      .all()) {
      out.set(r.itemId, [...(out.get(r.itemId) ?? []), { id: r.id, name: r.name, color: r.color }]);
    }
    return out;
  }
}
