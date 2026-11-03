import { randomUUID } from 'node:crypto';
import { normalizeDoi, parseArxivId, titleKey } from '@research-studio/literature-engine';
import {
  authorDisplayName,
  type BibField,
  type EditableField,
  type ExternalLinkSummary,
  type LibraryItem,
  type LibraryItemPage,
  type LibraryItemQuery,
  type LibraryItemSummary,
  type LibraryOverview,
  type LibraryPreferences,
  type MatchCandidate,
  type MetadataMatch,
  type MetadataStatus,
  type ReadingStatus,
  type ScholarlyWork,
  type WorkEdits,
  type WorkOrigin,
} from '@research-studio/shared-types';
import type { AttachmentService } from '../attachments/attachment-service';
import type { CollectionRepository } from '../collections/collection-repository';
import { LibraryDeduplicator, fingerprintOfReference, fingerprintOfWork, type DuplicateHit } from '../deduplication/library-deduplicator';
import { LibraryError, notFound } from '../errors/library-errors';
import { exportBibtex, type BibtexExportable } from '../exports/bibtex-exporter';
import { exportRis } from '../exports/ris-exporter';
import { applyEdits, derivedColumns, effectiveEdits, localWorkId, workFromReference } from '../metadata/metadata-merger';
import type { ResolveOutcome } from '../metadata/metadata-resolver';
import { generateCitationKey, uniqueCitationKey, validateCitationKey } from './citation-keys';
import { MAX_PAGE_SIZE, type ItemRow, type LibraryRepository, type WorkRow } from './library-repository';
import type { ImportedReference, ScholarlyLookup } from './library-types';

export const newLibraryId = (prefix: 'wrk' | 'lib' | 'col' | 'tag' | 'att' | 'ext' | 'plk' | 'job') => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export interface AddOptions {
  readingStatus?: ReadingStatus;
  isFavorite?: boolean;
  tags?: string[];
  collectionIds?: string[];
  notes?: string;
  /** A key the user or the source chose; used when free and valid, otherwise a key is generated. */
  citationKey?: string | null;
}

export interface AddResult {
  item: LibraryItem;
  /** False when the work was already in the library (the existing item is returned unchanged). */
  created: boolean;
  /** Why the existing item was considered the same work. */
  duplicateReason: string | null;
  /** Items that look like the same paper but share no identifier: shown to the user, never merged automatically. */
  likelyDuplicates: { libraryItemId: string; reason: string }[];
  /** Notes about the add (e.g. a requested citation key was taken). */
  notices: string[];
}

export interface ItemPatch {
  /** Corrections to merge into the item's edits. */
  edits?: WorkEdits;
  /** Corrections to drop (the field shows the source value again). */
  revertFields?: EditableField[];
  readingStatus?: ReadingStatus;
  isFavorite?: boolean;
  notes?: string;
  tags?: string[];
  bibtexType?: string | null;
  bibtexExtra?: BibField[];
  archived?: boolean;
}

export type BulkAction =
  | { kind: 'set-status'; readingStatus: ReadingStatus }
  | { kind: 'favorite'; value: boolean }
  | { kind: 'archive'; value: boolean }
  | { kind: 'add-tags'; tags: string[] }
  | { kind: 'remove-tags'; tags: string[] }
  | { kind: 'add-to-collection'; collectionId: string }
  | { kind: 'remove-from-collection'; collectionId: string };

export type ExportSelection = { itemIds: string[] } | { collectionId: string } | { projectId: string } | { all: true };

export interface DeletionImpact {
  items: number;
  attachments: number;
  /** Projects that reference the items (the links are removed; their `.bib` files are not touched). */
  projects: { id: string; name: string; items: number }[];
  /** Items linked to Zotero (the Zotero items are not deleted). */
  externalLinks: number;
}

export type LibraryChange = { kind: 'items' | 'collections'; ids: string[] };

export interface LibraryServiceDeps {
  repo: LibraryRepository;
  collections: CollectionRepository;
  attachments: AttachmentService;
  /** The M3.1 literature engine; null when unavailable (resolution is then refused, everything else works). */
  lookup: ScholarlyLookup | null;
  preferences: () => LibraryPreferences;
  now?: () => string;
  onChange?: (change: LibraryChange) => void;
}

const RECENT = 8;

/** Whether `key` is `base` or `base` plus a collision suffix (`a`…`zz`, `-N`): already a key of the current format. */
function isKeyFor(key: string, base: string): boolean {
  const k = key.toLowerCase();
  const b = base.toLowerCase();
  return k.startsWith(b) && /^([a-z]{1,2}|-\d+)?$/.test(k.slice(b.length));
}

export class LibraryService {
  readonly repo: LibraryRepository;
  readonly collections: CollectionRepository;
  readonly attachments: AttachmentService;
  readonly dedup: LibraryDeduplicator;
  private readonly now: () => string;

  constructor(private readonly deps: LibraryServiceDeps) {
    this.repo = deps.repo;
    this.collections = deps.collections;
    this.attachments = deps.attachments;
    this.dedup = new LibraryDeduplicator(deps.repo);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  get lookup(): ScholarlyLookup {
    if (!this.deps.lookup) throw new LibraryError('NOT_CONFIGURED', 'Scholarly search is not available, so metadata cannot be looked up');
    return this.deps.lookup;
  }

  get hasLookup(): boolean {
    return this.deps.lookup !== null;
  }

  private changed(kind: LibraryChange['kind'], ids: string[]) {
    if (ids.length) this.deps.onChange?.({ kind, ids });
  }

  // ------------------------------------------------------------- reads

  private effective(work: WorkRow): ScholarlyWork {
    return applyEdits(work.work, work.userEdits);
  }

  getItem(id: string): Promise<LibraryItem> {
    return this.items([id]).then((all) => {
      const item = all[0];
      if (!item) throw notFound('Library item', id);
      return item;
    });
  }

  async items(ids: readonly string[]): Promise<LibraryItem[]> {
    const rows = this.repo.withWorks(ids);
    const itemIds = rows.map((r) => r.item.id);
    const tags = this.repo.tagsForItems(itemIds);
    const cols = this.collections.collectionsForItems(itemIds);
    const projects = this.repo.projectsForItems(itemIds);
    const attachments = await this.attachments.list(itemIds);
    const links = this.repo.linksForItems(itemIds);
    const byId = new Map(
      rows.map(({ item, work }) => {
        const external: ExternalLinkSummary[] = links
          .filter((l) => l.libraryItemId === item.id)
          .map((l) => ({
            provider: l.provider,
            externalLibraryId: l.externalLibraryId,
            externalItemId: l.externalItemId,
            externalVersion: l.externalVersion,
            lastSyncedAt: l.lastSyncedAt,
            syncStatus: l.syncStatus,
            conflict: l.conflict,
          }));
        const full: LibraryItem = {
          id: item.id,
          workId: work.work.id,
          work: this.effective(work),
          origin: work.origin,
          edits: work.userEdits,
          localSource: work.localSource,
          citationKey: item.citationKey,
          readingStatus: item.readingStatus,
          isFavorite: item.isFavorite,
          notes: item.notes,
          metadataStatus: item.metadataStatus,
          match: item.match,
          bibtexType: item.bibtexType,
          bibtexExtra: item.bibtexExtra,
          tags: tags.get(item.id) ?? [],
          collections: cols.get(item.id) ?? [],
          attachments: attachments.filter((a) => a.libraryItemId === item.id),
          projects: projects.get(item.id) ?? [],
          external,
          addedAt: item.addedAt,
          updatedAt: item.updatedAt,
          lastOpenedAt: item.lastOpenedAt,
          archivedAt: item.archivedAt,
        };
        return [item.id, full] as const;
      }),
    );
    return ids.map((id) => byId.get(id)).filter((x): x is LibraryItem => !!x);
  }

  summaries(rows: { item: ItemRow; work: WorkRow }[]): LibraryItemSummary[] {
    const ids = rows.map((r) => r.item.id);
    const tags = this.repo.tagsForItems(ids);
    const cols = this.collections.collectionsForItems(ids);
    const pdfs = this.repo.pdfCounts(ids);
    return rows.map(({ item, work }) => {
      const w = this.effective(work);
      return {
        id: item.id,
        workId: w.id,
        title: w.title,
        authors: w.authors.slice(0, 3).map(authorDisplayName),
        authorCount: w.authors.length,
        year: w.publicationYear,
        venue: w.venue,
        publicationType: w.publicationType,
        doi: w.identifiers.doi,
        arxivId: w.identifiers.arxivId,
        citationKey: item.citationKey,
        readingStatus: item.readingStatus,
        isFavorite: item.isFavorite,
        metadataStatus: item.metadataStatus,
        origin: work.origin,
        pdfCount: pdfs.get(item.id) ?? 0,
        collectionIds: (cols.get(item.id) ?? []).map((c) => c.id),
        tags: tags.get(item.id) ?? [],
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        lastOpenedAt: item.lastOpenedAt,
        archivedAt: item.archivedAt,
      };
    });
  }

  query(q: LibraryItemQuery): LibraryItemPage {
    const { rows, total } = this.repo.queryItems(q);
    return { items: this.summaries(rows), total, offset: Math.max(q.offset ?? 0, 0), limit: Math.min(Math.max(q.limit ?? 50, 1), MAX_PAGE_SIZE) };
  }

  overview(): LibraryOverview {
    const counts = this.repo.countItems();
    const recentlyAdded = this.repo.queryItems({ sort: 'added-desc', limit: RECENT }).rows;
    const opened = this.repo.recentlyOpened(RECENT);
    return {
      total: counts.total,
      withPdf: counts.withPdf,
      byStatus: counts.byStatus,
      archived: counts.archived,
      favorites: counts.favorites,
      needsReview: counts.needsReview,
      collections: this.collections.list(),
      recentlyAdded: this.summaries(recentlyAdded),
      recentlyOpened: this.summaries(opened),
    };
  }

  // ------------------------------------------------------------ adding

  private existingItemForWork(workId: string): ItemRow {
    const item = this.repo.getItemByWork(workId);
    if (!item) throw new LibraryError('INTERNAL', 'A library work has no item');
    return item;
  }

  private likelyItems(hits: DuplicateHit[]): { libraryItemId: string; reason: string }[] {
    return hits
      .map((h) => ({ item: this.repo.getItemByWork(h.workId), reason: h.reason }))
      .filter((h) => h.item)
      .map((h) => ({ libraryItemId: h.item!.id, reason: h.reason }));
  }

  private chooseKey(work: ScholarlyWork, requested: string | null | undefined, notices: string[]): string {
    if (requested) {
      const problem = validateCitationKey(requested);
      if (!problem && !this.repo.citationKeyTaken(requested.toLowerCase())) return requested;
      notices.push(
        problem
          ? `The citation key "${requested}" is not usable (${problem}); a new key was generated`
          : `The citation key "${requested}" is already used by another library item; a new key was generated`,
      );
    }
    const prefs = this.deps.preferences();
    const base = generateCitationKey(work, prefs.citationKeyFormat, prefs.customKeyTemplate);
    return uniqueCitationKey(base, (k) => this.repo.citationKeyTaken(k));
  }

  /** Insert a work and its item (one transaction). */
  private insert(p: {
    work: ScholarlyWork;
    canonical: boolean;
    origin: WorkOrigin;
    localSource: Record<string, unknown> | null;
    metadataStatus: MetadataStatus;
    match: MetadataMatch | null;
    bibtexType: string | null;
    bibtexExtra: BibField[];
    opts: AddOptions;
    notices: string[];
  }): string {
    const now = this.now();
    const workId = newLibraryId('wrk');
    const work = p.canonical ? p.work : { ...p.work, id: localWorkId(workId) };
    for (const id of p.opts.collectionIds ?? []) if (!this.collections.getRow(id)) throw notFound('Collection', id);
    return this.repo.transaction(() => {
      this.repo.insertWork({
        id: workId,
        canonicalId: p.canonical ? work.id : null,
        origin: p.origin,
        work,
        localSource: p.localSource,
        userEdits: {},
        ...derivedColumns(work),
        createdAt: now,
        updatedAt: now,
      });
      const itemId = newLibraryId('lib');
      this.repo.insertItem({
        id: itemId,
        scholarlyWorkId: workId,
        citationKey: this.chooseKey(work, p.opts.citationKey, p.notices),
        readingStatus: p.opts.readingStatus ?? 'to-read',
        isFavorite: p.opts.isFavorite ?? false,
        notes: p.opts.notes ?? '',
        metadataStatus: p.metadataStatus,
        match: p.match,
        bibtexType: p.bibtexType,
        bibtexExtra: p.bibtexExtra,
        addedAt: now,
        updatedAt: now,
      });
      if (p.opts.tags?.length) this.repo.setItemTags(itemId, p.opts.tags, () => newLibraryId('tag'), now);
      for (const c of p.opts.collectionIds ?? []) this.collections.addItems(c, [itemId], now);
      return itemId;
    });
  }

  private async result(itemId: string, created: boolean, duplicateReason: string | null, likely: DuplicateHit[], notices: string[]): Promise<AddResult> {
    if (created) this.changed('items', [itemId]);
    return { item: await this.getItem(itemId), created, duplicateReason, likelyDuplicates: this.likelyItems(likely), notices };
  }

  /** Add a work found through literature search (an M3.1 `ScholarlyWork`). */
  async addWork(work: ScholarlyWork, opts: AddOptions = {}): Promise<AddResult> {
    if (work.id.startsWith('library:')) throw new LibraryError('BAD_REQUEST', 'This work is already a library work');
    const fp = fingerprintOfWork(work, true);
    const same = this.dedup.identical(fp);
    if (same) return this.result(this.existingItemForWork(same.workId).id, false, same.reason, [], []);
    const likely = this.dedup.likely(fp);
    const notices: string[] = [];
    const itemId = this.insert({
      work,
      canonical: true,
      origin: 'providers',
      localSource: null,
      metadataStatus: 'resolved',
      match: null,
      bibtexType: null,
      bibtexExtra: [],
      opts,
      notices,
    });
    return this.result(itemId, true, null, likely, notices);
  }

  /**
   * Add an imported record (BibTeX, RIS, Zotero, PDF metadata, manual entry).
   * With an exact identifier match in `resolution`, the provider work is used
   * and the record is kept as provenance; otherwise the record's own values
   * make the work, and any candidates wait for the user's decision.
   */
  async addReference(ref: ImportedReference, resolution: ResolveOutcome | null, opts: AddOptions = {}): Promise<AddResult> {
    const notices: string[] = [];
    const key = opts.citationKey ?? ref.citationKey;
    const match: MetadataMatch | null = resolution
      ? { confidence: resolution.confidence, candidates: resolution.candidates, extracted: resolution.extracted, decidedAt: resolution.automatic ? this.now() : null }
      : null;
    if (resolution?.automatic) {
      const work = resolution.automatic.work;
      const fp = fingerprintOfWork(work, true);
      const same = this.dedup.identical(fp);
      if (same) return this.result(this.existingItemForWork(same.workId).id, false, same.reason, [], []);
      const itemId = this.insert({
        work,
        canonical: true,
        origin: ref.origin,
        localSource: ref.localSource,
        metadataStatus: 'resolved',
        match,
        bibtexType: ref.bibtexType,
        bibtexExtra: ref.extraFields,
        opts: { ...opts, citationKey: key, notes: opts.notes ?? ref.notes ?? '' },
        notices,
      });
      return this.result(itemId, true, null, this.dedup.likely(fp, this.repo.getItem(itemId)!.scholarlyWorkId), notices);
    }

    if (!ref.title?.trim()) throw new LibraryError('VALIDATION_FAILED', 'A library item needs at least a title');
    const fp = fingerprintOfReference(ref);
    const same = this.dedup.identical(fp);
    if (same) return this.result(this.existingItemForWork(same.workId).id, false, same.reason, [], []);
    const likely = this.dedup.likely(fp);
    const status: MetadataStatus = !resolution
      ? ref.origin === 'pdf'
        ? 'unresolved'
        : 'manual'
      : resolution.candidates.length
        ? 'needs-review'
        : 'unresolved';
    const work = workFromReference(ref, 'pending', this.now());
    const itemId = this.insert({
      work,
      canonical: false,
      origin: ref.origin,
      localSource: ref.localSource,
      metadataStatus: status,
      match,
      bibtexType: ref.bibtexType,
      bibtexExtra: ref.extraFields,
      opts: { ...opts, citationKey: key, notes: opts.notes ?? ref.notes ?? '' },
      notices,
    });
    return this.result(itemId, true, null, likely, notices);
  }

  /** Add a paper by DOI or arXiv ID through the M3.1 engine. */
  async addByIdentifier(kind: 'doi' | 'arxiv', raw: string, opts: AddOptions = {}, signal?: AbortSignal): Promise<AddResult> {
    const value = kind === 'doi' ? normalizeDoi(raw) : (parseArxivId(raw)?.id ?? null);
    if (!value) throw new LibraryError('VALIDATION_FAILED', kind === 'doi' ? `"${raw}" is not a DOI` : `"${raw}" is not an arXiv identifier`);
    const fp = { canonicalId: null, doi: kind === 'doi' ? value : null, arxivId: kind === 'arxiv' ? value : null, title: '', firstAuthorKey: null, year: null };
    const same = this.dedup.identical(fp);
    if (same) return this.result(this.existingItemForWork(same.workId).id, false, same.reason, [], []);
    const res = kind === 'doi' ? await this.lookup.resolveDoi(value, signal) : await this.lookup.resolveArxiv(value, signal);
    const work = res.works[0];
    if (!work) throw new LibraryError('NOT_FOUND', kind === 'doi' ? `No provider knows the DOI ${value}` : `No provider knows the arXiv ID ${value}`);
    return this.addWork(work, opts);
  }

  // ----------------------------------------------------------- editing

  private requireRows(id: string): { item: ItemRow; work: WorkRow } {
    const item = this.repo.getItem(id);
    if (!item) throw notFound('Library item', id);
    const work = this.repo.getWork(item.scholarlyWorkId);
    if (!work) throw new LibraryError('INTERNAL', 'A library item has no work');
    return { item, work };
  }

  private normalizeEdits(edits: WorkEdits): WorkEdits {
    const out: WorkEdits = { ...edits };
    if (edits.doi !== undefined && edits.doi !== null) {
      const doi = normalizeDoi(edits.doi);
      if (!doi) throw new LibraryError('VALIDATION_FAILED', `"${edits.doi}" is not a DOI`);
      out.doi = doi;
    }
    if (edits.arxivId !== undefined && edits.arxivId !== null) {
      const id = parseArxivId(edits.arxivId)?.id;
      if (!id) throw new LibraryError('VALIDATION_FAILED', `"${edits.arxivId}" is not an arXiv identifier`);
      out.arxivId = id;
    }
    if (edits.title !== undefined && !edits.title?.trim()) throw new LibraryError('VALIDATION_FAILED', 'The title cannot be empty');
    if (edits.publicationYear !== undefined && edits.publicationYear !== null && (edits.publicationYear < 1000 || edits.publicationYear > 2200)) {
      throw new LibraryError('VALIDATION_FAILED', 'The year is out of range');
    }
    return out;
  }

  async update(id: string, patch: ItemPatch): Promise<LibraryItem> {
    const { item, work } = this.requireRows(id);
    const now = this.now();
    let edits = work.userEdits;
    if (patch.edits || patch.revertFields?.length) {
      const merged: WorkEdits = { ...edits, ...this.normalizeEdits(patch.edits ?? {}) };
      const revert = new Set<string>(patch.revertFields ?? []);
      const kept = Object.fromEntries(Object.entries(merged).filter(([f]) => !revert.has(f))) as WorkEdits;
      edits = effectiveEdits(work.work, kept);
    }
    const effective = applyEdits(work.work, edits);
    const derived = derivedColumns(effective);
    for (const [col, value, label] of [
      ['doi', derived.doi, 'DOI'],
      ['arxivId', derived.arxivId, 'arXiv ID'],
    ] as const) {
      if (!value || value === work[col]) continue;
      const other = col === 'doi' ? this.repo.findWorkByDoi(value) : this.repo.findWorkByArxiv(value);
      if (other && other.id !== work.id) {
        throw new LibraryError('ALREADY_EXISTS', `Another library item already has this ${label}`, { libraryItemId: this.repo.getItemByWork(other.id)?.id });
      }
    }
    this.repo.transaction(() => {
      if (edits !== work.userEdits) this.repo.updateWork(work.id, { userEdits: edits, ...derived, updatedAt: now });
      const itemPatch: Partial<ItemRow> = { updatedAt: now };
      if (patch.readingStatus) itemPatch.readingStatus = patch.readingStatus;
      if (patch.isFavorite !== undefined) itemPatch.isFavorite = patch.isFavorite;
      if (patch.notes !== undefined) itemPatch.notes = patch.notes.slice(0, 100_000);
      if (patch.bibtexType !== undefined) itemPatch.bibtexType = patch.bibtexType?.toLowerCase() || null;
      if (patch.bibtexExtra !== undefined) itemPatch.bibtexExtra = patch.bibtexExtra;
      if (patch.archived !== undefined) itemPatch.archivedAt = patch.archived ? (item.archivedAt ?? now) : null;
      // A user correction of an unresolved item makes it a manual entry.
      if (patch.edits && (item.metadataStatus === 'unresolved' || item.metadataStatus === 'needs-review')) itemPatch.metadataStatus = 'manual';
      this.repo.updateItem(id, itemPatch);
      if (patch.tags) this.repo.setItemTags(id, patch.tags, () => newLibraryId('tag'), now);
    });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  /** Record that the user opened the item (or its PDF). Reading status is the user's to set; it never changes here. */
  markOpened(id: string): void {
    this.requireRows(id);
    this.repo.updateItem(id, { lastOpenedAt: this.now() });
  }

  async bulk(ids: readonly string[], action: BulkAction): Promise<number> {
    const rows = this.repo.getItems(ids);
    if (rows.length !== new Set(ids).size) throw new LibraryError('NOT_FOUND', 'Some library items no longer exist');
    const now = this.now();
    const itemIds = rows.map((r) => r.id);
    this.repo.transaction(() => {
      switch (action.kind) {
        case 'set-status':
          for (const r of rows) this.repo.updateItem(r.id, { readingStatus: action.readingStatus, updatedAt: now });
          break;
        case 'favorite':
          for (const r of rows) this.repo.updateItem(r.id, { isFavorite: action.value, updatedAt: now });
          break;
        case 'archive':
          for (const r of rows) this.repo.updateItem(r.id, { archivedAt: action.value ? (r.archivedAt ?? now) : null, updatedAt: now });
          break;
        case 'add-tags':
          this.repo.addItemTags(itemIds, action.tags, () => newLibraryId('tag'), now);
          break;
        case 'remove-tags':
          this.repo.removeItemTags(itemIds, action.tags);
          break;
        case 'add-to-collection':
          if (!this.collections.getRow(action.collectionId)) throw notFound('Collection', action.collectionId);
          this.collections.addItems(action.collectionId, itemIds, now);
          break;
        case 'remove-from-collection':
          this.collections.removeItems(action.collectionId, itemIds);
          break;
      }
    });
    this.changed('items', itemIds);
    if (action.kind === 'add-to-collection' || action.kind === 'remove-from-collection') this.changed('collections', [action.collectionId]);
    return rows.length;
  }

  // ------------------------------------------------------ citation keys

  /** Keys proposed for an item (one per format), each free in the library. */
  suggestCitationKeys(id: string): string[] {
    const { item, work } = this.requireRows(id);
    const w = this.effective(work);
    const prefs = this.deps.preferences();
    const bases = [
      generateCitationKey(w, prefs.citationKeyFormat, prefs.customKeyTemplate),
      generateCitationKey(w, 'author-year'),
      generateCitationKey(w, 'author-year-keyword'),
      generateCitationKey(w, 'author-year-title'),
    ];
    const out: string[] = [];
    for (const b of bases) {
      const k = b.toLowerCase() === item.citationKey?.toLowerCase() ? b : uniqueCitationKey(b, (x) => this.repo.citationKeyTaken(x, id));
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  /**
   * Change an item's citation key. Keys must be valid and unique (case-insensitive).
   * When the item is linked to a project, its current key may be cited in a
   * manuscript, so the change needs `confirm` (the caller shows where it is used).
   */
  async setCitationKey(id: string, key: string, confirm = false): Promise<LibraryItem> {
    const { item } = this.requireRows(id);
    const problem = validateCitationKey(key);
    if (problem) throw new LibraryError('VALIDATION_FAILED', problem);
    if (item.citationKey === key) return this.getItem(id);
    if (this.repo.citationKeyTaken(key.toLowerCase(), id)) {
      throw new LibraryError('ALREADY_EXISTS', `The citation key "${key}" is already used by another library item`, {
        suggestion: uniqueCitationKey(key, (k) => this.repo.citationKeyTaken(k, id)),
      });
    }
    const projects = this.repo.projectsForItems([id]).get(id) ?? [];
    if (item.citationKey && projects.length && !confirm) {
      throw new LibraryError('CONFLICT', `"${item.citationKey}" may be cited in ${projects.map((p) => p.name).join(', ')}; confirm to change it`, {
        reason: 'KEY_IN_USE',
        projects,
      });
    }
    this.repo.updateItem(id, { citationKey: key, updatedAt: this.now() });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  /**
   * Generate keys for items in the current format. Items without a key always
   * get one; items that have a key are re-keyed only when `replaceExisting`,
   * and never when they are linked to a project (those are reported in `kept`).
   */
  regenerateCitationKeys(ids: readonly string[], replaceExisting: boolean): { changed: { id: string; from: string | null; to: string }[]; kept: string[] } {
    const rows = this.repo.withWorks(ids);
    const linked = this.repo.projectsForItems(rows.map((r) => r.item.id));
    const prefs = this.deps.preferences();
    const changed: { id: string; from: string | null; to: string }[] = [];
    const kept: string[] = [];
    const now = this.now();
    this.repo.transaction(() => {
      for (const { item, work } of rows) {
        if (item.citationKey && (!replaceExisting || linked.get(item.id)?.length)) {
          if (replaceExisting) kept.push(item.id);
          continue;
        }
        const base = generateCitationKey(this.effective(work), prefs.citationKeyFormat, prefs.customKeyTemplate);
        if (item.citationKey && isKeyFor(item.citationKey, base)) continue;
        const key = uniqueCitationKey(base, (k) => this.repo.citationKeyTaken(k, item.id));
        if (key === item.citationKey) continue;
        this.repo.updateItem(item.id, { citationKey: key, updatedAt: now });
        changed.push({ id: item.id, from: item.citationKey, to: key });
      }
    });
    this.changed('items', changed.map((c) => c.id));
    return { changed, kept };
  }

  // ---------------------------------------------------------- matching

  /** Store a resolution for an item; an exact match is applied at once. */
  async recordResolution(id: string, outcome: ResolveOutcome): Promise<LibraryItem> {
    const { item } = this.requireRows(id);
    const match: MetadataMatch = { confidence: outcome.confidence, candidates: outcome.candidates, extracted: outcome.extracted, decidedAt: null };
    if (outcome.automatic) return this.applyWork(id, outcome.automatic.work, match);
    const status: MetadataStatus = item.metadataStatus === 'resolved' ? 'resolved' : outcome.candidates.length ? 'needs-review' : item.metadataStatus === 'manual' ? 'manual' : 'unresolved';
    this.repo.updateItem(id, { match, metadataStatus: status, updatedAt: this.now() });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  /** Accept one of the item's stored candidates (by work ID). The candidate comes from the runtime's own record, never from the request body. */
  async acceptCandidate(id: string, candidateWorkId: string): Promise<LibraryItem> {
    const { item } = this.requireRows(id);
    const candidate = item.match?.candidates.find((c: MatchCandidate) => c.work.id === candidateWorkId);
    if (!candidate) throw new LibraryError('NOT_FOUND', 'That candidate is not among the matches found for this item');
    return this.applyWork(id, candidate.work, item.match);
  }

  /** Link the item to a work the user found by searching (fetched fresh through M3.1). */
  async linkToWork(id: string, canonicalId: string, signal?: AbortSignal): Promise<LibraryItem> {
    this.requireRows(id);
    const work = await this.lookup.work(canonicalId, signal);
    return this.applyWork(id, work, this.repo.getItem(id)?.match ?? null);
  }

  /** The user looked at the candidates and keeps the item's own metadata. */
  async keepUnresolved(id: string): Promise<LibraryItem> {
    const { item } = this.requireRows(id);
    this.repo.updateItem(id, {
      metadataStatus: 'manual',
      match: item.match ? { ...item.match, decidedAt: this.now() } : null,
      updatedAt: this.now(),
    });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  private async applyWork(id: string, work: ScholarlyWork, match: MetadataMatch | null): Promise<LibraryItem> {
    const { work: row } = this.requireRows(id);
    const same = this.dedup.identical(fingerprintOfWork(work, true));
    if (same && same.workId !== row.id) {
      throw new LibraryError('ALREADY_EXISTS', `This paper is already in the library (${same.reason.toLowerCase()}); merge the two items instead`, {
        libraryItemId: this.repo.getItemByWork(same.workId)?.id,
      });
    }
    const now = this.now();
    // The provider work replaces the record's values; the record stays as `local_source`. Earlier corrections are dropped
    // because they corrected the record, not the provider's metadata.
    this.repo.transaction(() => {
      this.repo.updateWork(row.id, { canonicalId: work.id, work, userEdits: {}, ...derivedColumns(work), updatedAt: now });
      this.repo.updateItem(id, {
        metadataStatus: 'resolved',
        match: match ? { ...match, decidedAt: now } : null,
        updatedAt: now,
      });
    });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  /** Fetch the latest provider metadata for a resolved item; the user's corrections are kept. */
  async refresh(id: string, signal?: AbortSignal): Promise<LibraryItem> {
    const { work: row } = this.requireRows(id);
    if (!row.canonicalId) throw new LibraryError('BAD_REQUEST', 'This item is not linked to a scholarly record; resolve it first');
    const work = await this.lookup.work(row.canonicalId, signal);
    const effective = applyEdits(work, row.userEdits);
    this.repo.updateWork(row.id, { work, ...derivedColumns(effective), updatedAt: this.now() });
    this.changed('items', [id]);
    return this.getItem(id);
  }

  /**
   * The source record of an item changed (a linked Zotero item was edited).
   * A work built from the record is rebuilt from the new record; a work
   * linked to a scholarly record keeps its provider metadata and only the
   * stored record is replaced. The user's corrections stay either way.
   */
  replaceSourceRecord(id: string, ref: ImportedReference): void {
    const { work } = this.requireRows(id);
    const now = this.now();
    if (work.canonicalId) {
      this.repo.updateWork(work.id, { localSource: ref.localSource, updatedAt: now });
    } else {
      if (!ref.title?.trim()) throw new LibraryError('VALIDATION_FAILED', 'The updated record has no title');
      const base = { ...workFromReference(ref, 'pending', now), id: work.work.id, createdAt: work.work.createdAt };
      this.repo.updateWork(work.id, { work: base, localSource: ref.localSource, ...derivedColumns(applyEdits(base, work.userEdits)), updatedAt: now });
    }
    this.repo.updateItem(id, { updatedAt: now });
    this.changed('items', [id]);
  }

  /** The imported record of an item as a reference (for re-resolving). */
  referenceOf(id: string): ImportedReference | null {
    const { work } = this.requireRows(id);
    if (work.canonicalId) return null;
    const w = this.effective(work);
    return {
      origin: work.origin === 'providers' ? 'manual' : work.origin,
      title: w.title,
      authors: w.authors.map((a) => ({ givenName: a.givenName, familyName: a.familyName, name: a.givenName || a.familyName ? null : a.name })),
      publicationYear: w.publicationYear,
      publicationDate: w.publicationDate,
      venue: w.venue,
      publisher: w.publisher,
      publicationType: w.publicationType,
      volume: w.bibliographic.volume,
      issue: w.bibliographic.issue,
      pages: w.bibliographic.pages,
      abstract: w.abstract,
      doi: w.identifiers.doi,
      arxivId: w.identifiers.arxivId,
      url: w.urls.landingPage,
      issn: w.bibliographic.issn,
      keywords: [],
      citationKey: null,
      bibtexType: null,
      extraFields: [],
      localSource: work.localSource ?? {},
      notes: null,
    };
  }

  // ------------------------------------------------------- duplicates

  duplicateGroups(): { items: LibraryItemSummary[]; reason: string }[] {
    return this.dedup.scan().map((g) => {
      const rows = g.workIds.map((w) => this.repo.getItemByWork(w)).filter((x): x is ItemRow => !!x);
      return { items: this.summaries(this.repo.withWorks(rows.map((r) => r.id))), reason: g.reason };
    });
  }

  /**
   * Merge `dropId` into `keepId`: tags, collections, project links, attachments
   * and notes move to the kept item; the dropped item and its work are deleted.
   * Returns the dropped key so callers can tell the user which citations to update.
   */
  async merge(keepId: string, dropId: string): Promise<{ item: LibraryItem; droppedKey: string | null }> {
    if (keepId === dropId) throw new LibraryError('BAD_REQUEST', 'Choose two different items');
    const keep = this.requireRows(keepId);
    const drop = this.requireRows(dropId);
    const now = this.now();
    const tags = [...new Set([...(this.repo.tagsForItems([keepId]).get(keepId) ?? []), ...(this.repo.tagsForItems([dropId]).get(dropId) ?? [])])];
    const cols = (this.collections.collectionsForItems([dropId]).get(dropId) ?? []).map((c) => c.id);
    const projects = this.repo.projectIdsForItem(dropId);
    this.repo.transaction(() => {
      this.repo.setItemTags(keepId, tags, () => newLibraryId('tag'), now);
      for (const c of cols) this.collections.addItems(c, [keepId], now);
      for (const p of projects) this.repo.linkProject(p, [keepId], () => newLibraryId('plk'), now);
      for (const a of this.repo.attachmentsForItems([dropId])) {
        if (this.repo.attachmentByItemAndHash(keepId, a.sha256)) this.repo.deleteAttachment(a.id);
        else this.repo.updateAttachment(a.id, { libraryItemId: keepId, updatedAt: now });
      }
      const notes = [keep.item.notes, drop.item.notes].filter((n) => n.trim()).join('\n\n');
      this.repo.updateItem(keepId, {
        notes,
        isFavorite: keep.item.isFavorite || drop.item.isFavorite,
        readingStatus: keep.item.readingStatus,
        updatedAt: now,
      });
      this.repo.deleteItem(dropId);
      this.repo.deleteWork(drop.work.id);
    });
    this.changed('items', [keepId, dropId]);
    return { item: await this.getItem(keepId), droppedKey: drop.item.citationKey };
  }

  // ---------------------------------------------------------- deletion

  deletionImpact(ids: readonly string[]): DeletionImpact {
    const rows = this.repo.getItems(ids);
    const itemIds = rows.map((r) => r.id);
    const projects = new Map<string, { id: string; name: string; items: number }>();
    for (const list of this.repo.projectsForItems(itemIds).values()) {
      for (const p of list) projects.set(p.id, { ...p, items: (projects.get(p.id)?.items ?? 0) + 1 });
    }
    return {
      items: rows.length,
      attachments: this.repo.attachmentsForItems(itemIds).length,
      projects: [...projects.values()],
      externalLinks: this.repo.linksForItems(itemIds).length,
    };
  }

  /** Delete items with their attachments (stored files go when nothing else uses them). Project `.bib` files are not changed. */
  async deleteItems(ids: readonly string[]): Promise<number> {
    const rows = this.repo.getItems(ids);
    if (!rows.length) return 0;
    const itemIds = rows.map((r) => r.id);
    const objects = this.repo.attachmentsForItems(itemIds).map((a) => ({ storageKey: a.storageKey, sha256: a.sha256 }));
    this.repo.transaction(() => {
      for (const r of rows) {
        this.repo.deleteItem(r.id);
        this.repo.deleteWork(r.scholarlyWorkId);
      }
      this.repo.deleteUnusedTags();
    });
    await this.attachments.releaseObjects(objects);
    this.changed('items', itemIds);
    return rows.length;
  }

  // ------------------------------------------------------------ export

  selectionIds(sel: ExportSelection): string[] {
    if ('itemIds' in sel) return sel.itemIds;
    if ('collectionId' in sel) {
      if (!this.collections.getRow(sel.collectionId)) throw notFound('Collection', sel.collectionId);
      return this.collections.itemIds(sel.collectionId);
    }
    if ('projectId' in sel) return this.repo.projectItemIds(sel.projectId);
    return this.repo.allItemIds();
  }

  exportables(ids: readonly string[]): (BibtexExportable & { tags: string[]; itemId: string })[] {
    const rows = this.repo.withWorks(ids);
    const tags = this.repo.tagsForItems(rows.map((r) => r.item.id));
    const byId = new Map(rows.map((r) => [r.item.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is { item: ItemRow; work: WorkRow } => !!r)
      .map(({ item, work }) => ({
        itemId: item.id,
        work: this.effective(work),
        citationKey: item.citationKey ?? 'ref',
        bibtexType: item.bibtexType,
        bibtexExtra: item.bibtexExtra,
        tags: tags.get(item.id) ?? [],
      }));
  }

  exportBibtex(sel: ExportSelection): { text: string; count: number } {
    const items = this.exportables(this.selectionIds(sel)).sort((a, b) => a.citationKey.localeCompare(b.citationKey));
    return { text: exportBibtex(items, `Exported from Research Studio (${items.length} ${items.length === 1 ? 'entry' : 'entries'})`), count: items.length };
  }

  exportRis(sel: ExportSelection): { text: string; count: number } {
    const items = this.exportables(this.selectionIds(sel));
    return { text: exportRis(items), count: items.length };
  }

  /** Title folding used by search (exposed for repository construction). */
  static fold = titleKey;
}
