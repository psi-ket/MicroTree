import { and, asc, count, desc, eq, exists, gte, inArray, isNotNull, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';
import type {
  ExternalLibraryProvider,
  ImportJob,
  LibraryAttachment,
  LibraryItemQuery,
  LibraryTag,
  ReadingStatus,
} from '@research-studio/shared-types';

const {
  scholarlyWorks,
  libraryItems,
  libraryTags,
  libraryItemTags,
  libraryAttachments,
  libraryCollectionItems,
  libraryExternalLinks,
  libraryExternalCollections,
  libraryProjectLinks,
  libraryImportJobs,
  projects,
} = schema;

export type WorkRow = typeof scholarlyWorks.$inferSelect;
export type NewWorkRow = typeof scholarlyWorks.$inferInsert;
export type ItemRow = typeof libraryItems.$inferSelect;
export type NewItemRow = typeof libraryItems.$inferInsert;
export type AttachmentRow = typeof libraryAttachments.$inferSelect;
export type ExternalLinkRow = typeof libraryExternalLinks.$inferSelect;
export type ExternalCollectionRow = typeof libraryExternalCollections.$inferSelect;
export type JobRow = typeof libraryImportJobs.$inferSelect;

/** Lower-case letters and digits separated by single spaces: the same folding as `titleKey`. */
export type FoldFn = (text: string) => string;

export const MAX_PAGE_SIZE = 200;

// Correlated subqueries: Drizzle writes columns of a single-table subquery unqualified, so an outer
// `"id"` would bind to the subquery's own `id` column. The outer item ID is therefore written in full.
const OUTER_ITEM_ID = sql.raw('"library_items"."id"');

export function toAttachment(row: AttachmentRow, available = true): LibraryAttachment {
  return {
    id: row.id,
    libraryItemId: row.libraryItemId,
    fileName: row.fileName,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    sha256: row.sha256,
    attachmentType: row.attachmentType,
    source: row.source,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    available,
  };
}

export function toJob(row: JobRow): ImportJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    processed: row.processed,
    items: row.items,
    warnings: row.warnings,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

/** All SQL for the library tables. Synchronous (better-sqlite3); callers group writes with `transaction`. */
export class LibraryRepository {
  constructor(
    readonly db: StudioDb,
    private readonly fold: FoldFn,
  ) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => fn());
  }

  // ------------------------------------------------------------- works

  insertWork(row: NewWorkRow): WorkRow {
    return this.db.insert(scholarlyWorks).values(row).returning().get();
  }

  updateWork(id: string, patch: Partial<NewWorkRow>): void {
    this.db.update(scholarlyWorks).set(patch).where(eq(scholarlyWorks.id, id)).run();
  }

  getWork(id: string): WorkRow | null {
    return this.db.select().from(scholarlyWorks).where(eq(scholarlyWorks.id, id)).get() ?? null;
  }

  deleteWork(id: string): void {
    this.db.delete(scholarlyWorks).where(eq(scholarlyWorks.id, id)).run();
  }

  findWorkByDoi(doi: string): WorkRow | null {
    return this.db.select().from(scholarlyWorks).where(eq(scholarlyWorks.doi, doi)).get() ?? null;
  }

  findWorkByArxiv(arxivId: string): WorkRow | null {
    return this.db.select().from(scholarlyWorks).where(eq(scholarlyWorks.arxivId, arxivId)).get() ?? null;
  }

  findWorkByCanonical(canonicalId: string): WorkRow | null {
    return this.db.select().from(scholarlyWorks).where(eq(scholarlyWorks.canonicalId, canonicalId)).get() ?? null;
  }

  /** Matching columns of every work that has a library item (for duplicate scans). */
  workKeys(): Pick<WorkRow, 'id' | 'titleKey' | 'firstAuthorKey' | 'year' | 'doi' | 'arxivId'>[] {
    return this.db
      .select({
        id: scholarlyWorks.id,
        titleKey: scholarlyWorks.titleKey,
        firstAuthorKey: scholarlyWorks.firstAuthorKey,
        year: scholarlyWorks.year,
        doi: scholarlyWorks.doi,
        arxivId: scholarlyWorks.arxivId,
      })
      .from(scholarlyWorks)
      .innerJoin(libraryItems, eq(libraryItems.scholarlyWorkId, scholarlyWorks.id))
      .all();
  }

  /** Works whose title key equals `titleKey` (candidates for metadata matching). */
  findWorksByTitleKey(titleKey: string): WorkRow[] {
    if (!titleKey) return [];
    return this.db.select().from(scholarlyWorks).where(eq(scholarlyWorks.titleKey, titleKey)).limit(20).all();
  }

  /** Works whose title key starts with the same first words (cheap pre-filter for near-duplicates). */
  findWorksByTitlePrefix(prefix: string, limit = 50): WorkRow[] {
    if (prefix.length < 8) return [];
    return this.db
      .select()
      .from(scholarlyWorks)
      .where(like(scholarlyWorks.titleKey, `${escapeLike(prefix)}%`))
      .limit(limit)
      .all();
  }

  // ------------------------------------------------------------- items

  insertItem(row: NewItemRow): ItemRow {
    return this.db.insert(libraryItems).values(row).returning().get();
  }

  updateItem(id: string, patch: Partial<NewItemRow>): void {
    this.db.update(libraryItems).set(patch).where(eq(libraryItems.id, id)).run();
  }

  getItem(id: string): ItemRow | null {
    return this.db.select().from(libraryItems).where(eq(libraryItems.id, id)).get() ?? null;
  }

  getItems(ids: readonly string[]): ItemRow[] {
    if (!ids.length) return [];
    return this.db.select().from(libraryItems).where(inArray(libraryItems.id, [...ids])).all();
  }

  getItemByWork(workId: string): ItemRow | null {
    return this.db.select().from(libraryItems).where(eq(libraryItems.scholarlyWorkId, workId)).get() ?? null;
  }

  getItemByCitationKey(key: string): ItemRow | null {
    return this.db.select().from(libraryItems).where(sql`lower(${libraryItems.citationKey}) = ${key.toLowerCase()}`).get() ?? null;
  }

  citationKeyTaken(keyLower: string, exceptItemId?: string): boolean {
    const row = this.db
      .select({ id: libraryItems.id })
      .from(libraryItems)
      .where(sql`lower(${libraryItems.citationKey}) = ${keyLower}`)
      .get();
    return !!row && row.id !== exceptItemId;
  }

  deleteItem(id: string): void {
    this.db.delete(libraryItems).where(eq(libraryItems.id, id)).run();
  }

  withWorks(itemIds: readonly string[]): { item: ItemRow; work: WorkRow }[] {
    if (!itemIds.length) return [];
    return this.db
      .select({ item: libraryItems, work: scholarlyWorks })
      .from(libraryItems)
      .innerJoin(scholarlyWorks, eq(libraryItems.scholarlyWorkId, scholarlyWorks.id))
      .where(inArray(libraryItems.id, [...itemIds]))
      .all();
  }

  allItemIds(): string[] {
    return this.db.select({ id: libraryItems.id }).from(libraryItems).all().map((r) => r.id);
  }

  /** Filtered, sorted page of items with their works. */
  queryItems(q: LibraryItemQuery): { rows: { item: ItemRow; work: WorkRow }[]; total: number } {
    const where: SQL[] = [];
    const archived = q.archived ?? 'active';
    if (archived === 'active') where.push(isNull(libraryItems.archivedAt));
    else if (archived === 'archived') where.push(isNotNull(libraryItems.archivedAt));
    if (q.readingStatus) where.push(eq(libraryItems.readingStatus, q.readingStatus));
    if (q.metadataStatus) where.push(eq(libraryItems.metadataStatus, q.metadataStatus));
    if (q.favorite !== undefined) where.push(eq(libraryItems.isFavorite, q.favorite));
    if (q.yearFrom !== undefined) where.push(gte(scholarlyWorks.year, q.yearFrom));
    if (q.yearTo !== undefined) where.push(lte(scholarlyWorks.year, q.yearTo));
    if (q.author) {
      const a = this.fold(q.author);
      if (a) where.push(like(scholarlyWorks.authorsKey, `%${escapeLike(a)}%`));
    }
    if (q.collectionId) {
      where.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(libraryCollectionItems)
            .where(and(sql`${libraryCollectionItems.libraryItemId} = ${OUTER_ITEM_ID}`, eq(libraryCollectionItems.collectionId, q.collectionId))),
        ),
      );
    }
    if (q.tag) {
      where.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(libraryItemTags)
            .innerJoin(libraryTags, eq(libraryItemTags.tagId, libraryTags.id))
            .where(and(sql`${libraryItemTags.libraryItemId} = ${OUTER_ITEM_ID}`, sql`lower(${libraryTags.name}) = ${q.tag.toLowerCase()}`)),
        ),
      );
    }
    if (q.projectId) {
      where.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(libraryProjectLinks)
            .where(and(sql`${libraryProjectLinks.libraryItemId} = ${OUTER_ITEM_ID}`, eq(libraryProjectLinks.projectId, q.projectId))),
        ),
      );
    }
    if (q.hasPdf !== undefined) {
      const pdf = exists(
        this.db
          .select({ one: sql`1` })
          .from(libraryAttachments)
          .where(and(sql`${libraryAttachments.libraryItemId} = ${OUTER_ITEM_ID}`, eq(libraryAttachments.attachmentType, 'pdf'))),
      );
      where.push(q.hasPdf ? pdf : sql`not ${pdf}`);
    }
    if (q.q?.trim()) {
      const raw = q.q.trim();
      const tokens = this.fold(raw).split(' ').filter(Boolean).slice(0, 8);
      const tokenConds = tokens.map((t) => {
        const pattern = `%${escapeLike(t)}%`;
        return or(
          sql`${scholarlyWorks.titleKey} like ${pattern} escape '\\'`,
          sql`${scholarlyWorks.authorsKey} like ${pattern} escape '\\'`,
          sql`lower(coalesce(${libraryItems.citationKey}, '')) like ${pattern} escape '\\'`,
        )!;
      });
      const lowered = raw.toLowerCase();
      const exact = or(eq(scholarlyWorks.doi, lowered), eq(scholarlyWorks.arxivId, lowered), sql`lower(${libraryItems.citationKey}) = ${lowered}`)!;
      where.push(tokenConds.length ? or(exact, and(...tokenConds)!)! : exact);
    }

    const cond = where.length ? and(...where) : undefined;
    const total =
      this.db
        .select({ n: count() })
        .from(libraryItems)
        .innerJoin(scholarlyWorks, eq(libraryItems.scholarlyWorkId, scholarlyWorks.id))
        .where(cond)
        .get()?.n ?? 0;

    const order = {
      'added-desc': [desc(libraryItems.addedAt), desc(libraryItems.id)],
      'added-asc': [asc(libraryItems.addedAt), asc(libraryItems.id)],
      // Unknown years last in both directions.
      'year-desc': [sql`${scholarlyWorks.year} is null`, desc(scholarlyWorks.year), asc(scholarlyWorks.titleKey)],
      'year-asc': [sql`${scholarlyWorks.year} is null`, asc(scholarlyWorks.year), asc(scholarlyWorks.titleKey)],
      'title-asc': [asc(scholarlyWorks.titleKey), asc(libraryItems.id)],
      'title-desc': [desc(scholarlyWorks.titleKey), desc(libraryItems.id)],
    }[q.sort ?? 'added-desc'];

    const limit = Math.min(Math.max(q.limit ?? 50, 1), MAX_PAGE_SIZE);
    const rows = this.db
      .select({ item: libraryItems, work: scholarlyWorks })
      .from(libraryItems)
      .innerJoin(scholarlyWorks, eq(libraryItems.scholarlyWorkId, scholarlyWorks.id))
      .where(cond)
      .orderBy(...order)
      .limit(limit)
      .offset(Math.max(q.offset ?? 0, 0))
      .all();
    return { rows, total };
  }

  recentlyOpened(limit: number): { item: ItemRow; work: WorkRow }[] {
    return this.db
      .select({ item: libraryItems, work: scholarlyWorks })
      .from(libraryItems)
      .innerJoin(scholarlyWorks, eq(libraryItems.scholarlyWorkId, scholarlyWorks.id))
      .where(and(isNotNull(libraryItems.lastOpenedAt), isNull(libraryItems.archivedAt)))
      .orderBy(desc(libraryItems.lastOpenedAt))
      .limit(limit)
      .all();
  }

  countItems(): { total: number; archived: number; favorites: number; needsReview: number; byStatus: Record<ReadingStatus, number>; withPdf: number } {
    const active = isNull(libraryItems.archivedAt);
    const total = this.db.select({ n: count() }).from(libraryItems).where(active).get()?.n ?? 0;
    const archived = this.db.select({ n: count() }).from(libraryItems).where(isNotNull(libraryItems.archivedAt)).get()?.n ?? 0;
    const favorites = this.db.select({ n: count() }).from(libraryItems).where(and(active, eq(libraryItems.isFavorite, true))).get()?.n ?? 0;
    const needsReview =
      this.db.select({ n: count() }).from(libraryItems).where(and(active, eq(libraryItems.metadataStatus, 'needs-review'))).get()?.n ?? 0;
    const byStatus = { 'to-read': 0, reading: 0, read: 0, important: 0 } as Record<ReadingStatus, number>;
    for (const r of this.db
      .select({ status: libraryItems.readingStatus, n: count() })
      .from(libraryItems)
      .where(active)
      .groupBy(libraryItems.readingStatus)
      .all()) {
      byStatus[r.status] = r.n;
    }
    const withPdf =
      this.db
        .select({ n: sql<number>`count(distinct ${libraryAttachments.libraryItemId})` })
        .from(libraryAttachments)
        .innerJoin(libraryItems, eq(libraryAttachments.libraryItemId, libraryItems.id))
        .where(and(active, eq(libraryAttachments.attachmentType, 'pdf')))
        .get()?.n ?? 0;
    return { total, archived, favorites, needsReview, byStatus, withPdf };
  }

  // -------------------------------------------------------------- tags

  /** Replace an item's tags (tags are created as needed; names compare case-insensitively). */
  setItemTags(itemId: string, names: readonly string[], newId: () => string, now: string): void {
    const clean = [...new Map(names.map((n) => n.trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    this.db.delete(libraryItemTags).where(eq(libraryItemTags.libraryItemId, itemId)).run();
    for (const name of clean) {
      const tagId = this.ensureTag(name, newId, now);
      this.db.insert(libraryItemTags).values({ libraryItemId: itemId, tagId }).onConflictDoNothing().run();
    }
  }

  addItemTags(itemIds: readonly string[], names: readonly string[], newId: () => string, now: string): void {
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const tagId = this.ensureTag(name, newId, now);
      for (const itemId of itemIds) this.db.insert(libraryItemTags).values({ libraryItemId: itemId, tagId }).onConflictDoNothing().run();
    }
  }

  removeItemTags(itemIds: readonly string[], names: readonly string[]): void {
    const lowered = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (!lowered.length || !itemIds.length) return;
    const tagIds = this.db
      .select({ id: libraryTags.id })
      .from(libraryTags)
      .where(inArray(sql`lower(${libraryTags.name})`, lowered))
      .all()
      .map((r) => r.id);
    if (!tagIds.length) return;
    this.db
      .delete(libraryItemTags)
      .where(and(inArray(libraryItemTags.libraryItemId, [...itemIds]), inArray(libraryItemTags.tagId, tagIds)))
      .run();
  }

  private ensureTag(name: string, newId: () => string, now: string): string {
    const existing = this.db.select({ id: libraryTags.id }).from(libraryTags).where(sql`lower(${libraryTags.name}) = ${name.toLowerCase()}`).get();
    if (existing) return existing.id;
    return this.db.insert(libraryTags).values({ id: newId(), name: name.slice(0, 80), createdAt: now }).returning().get().id;
  }

  tagsForItems(itemIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!itemIds.length) return out;
    for (const r of this.db
      .select({ itemId: libraryItemTags.libraryItemId, name: libraryTags.name })
      .from(libraryItemTags)
      .innerJoin(libraryTags, eq(libraryItemTags.tagId, libraryTags.id))
      .where(inArray(libraryItemTags.libraryItemId, [...itemIds]))
      .orderBy(asc(sql`lower(${libraryTags.name})`))
      .all()) {
      out.set(r.itemId, [...(out.get(r.itemId) ?? []), r.name]);
    }
    return out;
  }

  listTags(): LibraryTag[] {
    return this.db
      .select({ id: libraryTags.id, name: libraryTags.name, itemCount: sql<number>`count(${libraryItemTags.libraryItemId})` })
      .from(libraryTags)
      .leftJoin(libraryItemTags, eq(libraryItemTags.tagId, libraryTags.id))
      .groupBy(libraryTags.id)
      .orderBy(asc(sql`lower(${libraryTags.name})`))
      .all();
  }

  deleteUnusedTags(): number {
    return this.db
      .delete(libraryTags)
      .where(sql`not exists (select 1 from "library_item_tags" t where t."tag_id" = "library_tags"."id")`)
      .run().changes;
  }

  // ------------------------------------------------------- attachments

  insertAttachment(row: typeof libraryAttachments.$inferInsert): AttachmentRow {
    return this.db.insert(libraryAttachments).values(row).returning().get();
  }

  getAttachment(id: string): AttachmentRow | null {
    return this.db.select().from(libraryAttachments).where(eq(libraryAttachments.id, id)).get() ?? null;
  }

  attachmentByItemAndHash(itemId: string, sha256: string): AttachmentRow | null {
    return (
      this.db
        .select()
        .from(libraryAttachments)
        .where(and(eq(libraryAttachments.libraryItemId, itemId), eq(libraryAttachments.sha256, sha256)))
        .get() ?? null
    );
  }

  /** Any attachment row with this content (another item already has the same file). */
  attachmentsByHash(sha256: string): AttachmentRow[] {
    return this.db.select().from(libraryAttachments).where(eq(libraryAttachments.sha256, sha256)).all();
  }

  attachmentsForItems(itemIds: readonly string[]): AttachmentRow[] {
    if (!itemIds.length) return [];
    return this.db
      .select()
      .from(libraryAttachments)
      .where(inArray(libraryAttachments.libraryItemId, [...itemIds]))
      .orderBy(asc(libraryAttachments.createdAt))
      .all();
  }

  pdfCounts(itemIds: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!itemIds.length) return out;
    for (const r of this.db
      .select({ itemId: libraryAttachments.libraryItemId, n: count() })
      .from(libraryAttachments)
      .where(and(inArray(libraryAttachments.libraryItemId, [...itemIds]), eq(libraryAttachments.attachmentType, 'pdf')))
      .groupBy(libraryAttachments.libraryItemId)
      .all()) {
      out.set(r.itemId, r.n);
    }
    return out;
  }

  deleteAttachment(id: string): void {
    this.db.delete(libraryAttachments).where(eq(libraryAttachments.id, id)).run();
  }

  updateAttachment(id: string, patch: Partial<typeof libraryAttachments.$inferInsert>): void {
    this.db.update(libraryAttachments).set(patch).where(eq(libraryAttachments.id, id)).run();
  }

  countAttachmentsByStorageKey(storageKey: string): number {
    return this.db.select({ n: count() }).from(libraryAttachments).where(eq(libraryAttachments.storageKey, storageKey)).get()?.n ?? 0;
  }

  allStorageKeys(): Set<string> {
    return new Set(this.db.selectDistinct({ k: libraryAttachments.storageKey }).from(libraryAttachments).all().map((r) => r.k));
  }

  // ---------------------------------------------------- external links

  linksForItems(itemIds: readonly string[]): ExternalLinkRow[] {
    if (!itemIds.length) return [];
    return this.db.select().from(libraryExternalLinks).where(inArray(libraryExternalLinks.libraryItemId, [...itemIds])).all();
  }

  linkByExternal(provider: ExternalLibraryProvider, libraryId: string, externalItemId: string): ExternalLinkRow | null {
    return (
      this.db
        .select()
        .from(libraryExternalLinks)
        .where(
          and(
            eq(libraryExternalLinks.provider, provider),
            eq(libraryExternalLinks.externalLibraryId, libraryId),
            eq(libraryExternalLinks.externalItemId, externalItemId),
          ),
        )
        .get() ?? null
    );
  }

  linkByItem(provider: ExternalLibraryProvider, libraryId: string, itemId: string): ExternalLinkRow | null {
    return (
      this.db
        .select()
        .from(libraryExternalLinks)
        .where(
          and(
            eq(libraryExternalLinks.provider, provider),
            eq(libraryExternalLinks.externalLibraryId, libraryId),
            eq(libraryExternalLinks.libraryItemId, itemId),
          ),
        )
        .get() ?? null
    );
  }

  linksForLibrary(provider: ExternalLibraryProvider, libraryId: string): ExternalLinkRow[] {
    return this.db
      .select()
      .from(libraryExternalLinks)
      .where(and(eq(libraryExternalLinks.provider, provider), eq(libraryExternalLinks.externalLibraryId, libraryId)))
      .all();
  }

  insertLink(row: typeof libraryExternalLinks.$inferInsert): ExternalLinkRow {
    return this.db.insert(libraryExternalLinks).values(row).returning().get();
  }

  updateLink(id: string, patch: Partial<typeof libraryExternalLinks.$inferInsert>): void {
    this.db.update(libraryExternalLinks).set(patch).where(eq(libraryExternalLinks.id, id)).run();
  }

  countLinks(provider: ExternalLibraryProvider): { linked: number; conflicts: number } {
    const linked = this.db.select({ n: count() }).from(libraryExternalLinks).where(eq(libraryExternalLinks.provider, provider)).get()?.n ?? 0;
    const conflicts =
      this.db
        .select({ n: count() })
        .from(libraryExternalLinks)
        .where(and(eq(libraryExternalLinks.provider, provider), eq(libraryExternalLinks.syncStatus, 'conflict')))
        .get()?.n ?? 0;
    return { linked, conflicts };
  }

  externalCollection(provider: ExternalLibraryProvider, libraryId: string, externalId: string): ExternalCollectionRow | null {
    return (
      this.db
        .select()
        .from(libraryExternalCollections)
        .where(
          and(
            eq(libraryExternalCollections.provider, provider),
            eq(libraryExternalCollections.externalLibraryId, libraryId),
            eq(libraryExternalCollections.externalCollectionId, externalId),
          ),
        )
        .get() ?? null
    );
  }

  upsertExternalCollection(row: typeof libraryExternalCollections.$inferInsert): void {
    this.db
      .insert(libraryExternalCollections)
      .values(row)
      .onConflictDoUpdate({
        target: [libraryExternalCollections.provider, libraryExternalCollections.externalLibraryId, libraryExternalCollections.externalCollectionId],
        set: { collectionId: row.collectionId, externalVersion: row.externalVersion, lastSyncedAt: row.lastSyncedAt },
      })
      .run();
  }

  // ----------------------------------------------------- project links

  linkProject(projectId: string, itemIds: readonly string[], newId: () => string, now: string): number {
    let added = 0;
    for (const itemId of itemIds) {
      added += this.db
        .insert(libraryProjectLinks)
        .values({ id: newId(), projectId, libraryItemId: itemId, createdAt: now })
        .onConflictDoNothing()
        .run().changes;
    }
    return added;
  }

  unlinkProject(projectId: string, itemIds: readonly string[]): number {
    if (!itemIds.length) return 0;
    return this.db
      .delete(libraryProjectLinks)
      .where(and(eq(libraryProjectLinks.projectId, projectId), inArray(libraryProjectLinks.libraryItemId, [...itemIds])))
      .run().changes;
  }

  projectItemIds(projectId: string): string[] {
    return this.db
      .select({ id: libraryProjectLinks.libraryItemId })
      .from(libraryProjectLinks)
      .where(eq(libraryProjectLinks.projectId, projectId))
      .orderBy(asc(libraryProjectLinks.createdAt))
      .all()
      .map((r) => r.id);
  }

  projectIdsForItem(itemId: string): string[] {
    return this.db
      .select({ id: libraryProjectLinks.projectId })
      .from(libraryProjectLinks)
      .where(eq(libraryProjectLinks.libraryItemId, itemId))
      .all()
      .map((r) => r.id);
  }

  projectsForItems(itemIds: readonly string[]): Map<string, { id: string; name: string }[]> {
    const out = new Map<string, { id: string; name: string }[]>();
    if (!itemIds.length) return out;
    for (const r of this.db
      .select({ itemId: libraryProjectLinks.libraryItemId, id: projects.id, name: projects.name })
      .from(libraryProjectLinks)
      .innerJoin(projects, eq(libraryProjectLinks.projectId, projects.id))
      .where(inArray(libraryProjectLinks.libraryItemId, [...itemIds]))
      .orderBy(asc(projects.name))
      .all()) {
      out.set(r.itemId, [...(out.get(r.itemId) ?? []), { id: r.id, name: r.name }]);
    }
    return out;
  }

  // -------------------------------------------------------------- jobs

  insertJob(row: typeof libraryImportJobs.$inferInsert): JobRow {
    return this.db.insert(libraryImportJobs).values(row).returning().get();
  }

  updateJob(id: string, patch: Partial<typeof libraryImportJobs.$inferInsert>): void {
    this.db.update(libraryImportJobs).set(patch).where(eq(libraryImportJobs.id, id)).run();
  }

  getJob(id: string): JobRow | null {
    return this.db.select().from(libraryImportJobs).where(eq(libraryImportJobs.id, id)).get() ?? null;
  }

  recentJobs(limit = 20): JobRow[] {
    return this.db.select().from(libraryImportJobs).orderBy(desc(libraryImportJobs.createdAt)).limit(limit).all();
  }

  /** Jobs left `queued`/`running` by a previous process become `interrupted`. */
  markInterruptedJobs(now: string): number {
    return this.db
      .update(libraryImportJobs)
      .set({ status: 'interrupted', finishedAt: now, error: 'The runtime stopped before this import finished' })
      .where(inArray(libraryImportJobs.status, ['queued', 'running']))
      .run().changes;
  }

  pruneJobs(keep = 100): void {
    this.db
      .delete(libraryImportJobs)
      .where(
        sql`${libraryImportJobs.id} not in (select ${libraryImportJobs.id} from ${libraryImportJobs} order by ${libraryImportJobs.createdAt} desc limit ${keep})`,
      )
      .run();
  }
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
