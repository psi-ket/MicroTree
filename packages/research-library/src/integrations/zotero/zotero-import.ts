import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportItemResult, LibraryItem, ZoteroCollectionInfo, ZoteroImportPreview, ZoteroImportPreviewItem } from '@research-studio/shared-types';
import type { CollectionService } from '../../collections/collection-service';
import { fingerprintOfReference } from '../../deduplication/library-deduplicator';
import { LibraryCancelledError, LibraryError } from '../../errors/library-errors';
import type { JobContext } from '../../imports/import-jobs';
import type { ExternalLinkRow } from '../../library/library-repository';
import { newLibraryId, type LibraryService } from '../../library/library-service';
import { resolveReference } from '../../metadata/metadata-resolver';
import type { ZoteroClient, ZoteroCollection } from './zotero-client';
import { comparable, differences, fingerprint, isImportableType, referenceFromZotero, zoteroDataFromWork, type ZoteroItem } from './zotero-mapper';

export interface ZoteroContext {
  library: LibraryService;
  collections: CollectionService;
  client: ZoteroClient;
  /** Zotero user ID (`0` for the local API). */
  userId: string;
  /** Where links are recorded: `users/<id>` for the web API, `local` for the desktop API (their versions are unrelated). */
  libraryId: string;
}

export interface ZoteroImportOptions {
  collectionKey?: string;
  /** Item keys chosen in the preview; all importable items when omitted. */
  itemKeys?: string[];
  importCollections: boolean;
  importPdfs: boolean;
  /** Look DOIs/arXiv IDs up through the literature engine (exact matches only). */
  resolveIdentifiers: boolean;
}

const PDF_LINK_MODES = new Set(['imported_file', 'imported_url']);

/** The current state of a library item, in Zotero's comparable form. */
export function localComparable(item: LibraryItem): Record<string, string> {
  return comparable(zoteroDataFromWork(item.work, { citationKey: item.citationKey, tags: [], collections: [] }));
}

function remoteChanged(link: ExternalLinkRow, remote: ZoteroItem): boolean {
  if (link.externalVersion !== null && remote.version <= link.externalVersion) return false;
  return fingerprint(comparable(remote.data)) !== fingerprint((link.remoteSnapshot as Record<string, string> | null) ?? {});
}

async function localChanged(ctx: ZoteroContext, link: ExternalLinkRow): Promise<boolean> {
  const item = await ctx.library.getItem(link.libraryItemId);
  return fingerprint(localComparable(item)) !== link.localFingerprint;
}

function collectionPaths(collections: ZoteroCollection[]): Map<string, string> {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const out = new Map<string, string>();
  const nameOf = (key: string, depth = 0): string => {
    const c = byKey.get(key);
    if (!c) return key;
    const parent = c.data.parentCollection;
    return parent && depth < 10 ? `${nameOf(parent, depth + 1)} › ${c.data.name}` : c.data.name;
  };
  for (const c of collections) out.set(c.key, nameOf(c.key));
  return out;
}

async function fetchAll(ctx: ZoteroContext, collectionKey: string | undefined, signal?: AbortSignal) {
  const [{ items, version }, { items: cols }] = await Promise.all([
    ctx.client.items(ctx.userId, collectionKey ? { collectionKey } : {}, signal),
    ctx.client.collections(ctx.userId, signal),
  ]);
  const top = items.filter((i) => isImportableType(i.data.itemType) && !i.data.parentItem);
  const pdfs = new Map<string, ZoteroItem[]>();
  for (const i of items) {
    if (i.data.itemType === 'attachment' && i.data.parentItem && i.data.contentType === 'application/pdf' && PDF_LINK_MODES.has(i.data.linkMode ?? '')) {
      pdfs.set(i.data.parentItem, [...(pdfs.get(i.data.parentItem) ?? []), i]);
    }
  }
  return { top, pdfs, collections: cols, version, skipped: items.length - top.length - [...pdfs.values()].flat().length };
}

/** What importing from Zotero would do. Nothing is written. */
export async function previewZoteroImport(ctx: ZoteroContext, options: { collectionKey?: string } = {}, signal?: AbortSignal): Promise<ZoteroImportPreview> {
  const { top, pdfs, collections, version, skipped } = await fetchAll(ctx, options.collectionKey, signal);
  const paths = collectionPaths(collections);
  const items: ZoteroImportPreviewItem[] = [];
  for (const z of top) {
    const { reference } = referenceFromZotero(z, ctx.libraryId);
    const link = ctx.library.repo.linkByExternal('zotero', ctx.libraryId, z.key);
    let state: ZoteroImportPreviewItem['state'] = 'new';
    let libraryItemId: string | null = null;
    if (link) {
      libraryItemId = link.libraryItemId;
      state = remoteChanged(link, z) ? ((await localChanged(ctx, link)) ? 'conflict' : 'remote-changes') : link.syncStatus === 'conflict' ? 'conflict' : 'linked';
    } else {
      const same = ctx.library.dedup.identical(fingerprintOfReference(reference));
      if (same) {
        state = 'duplicate';
        libraryItemId = ctx.library.repo.getItemByWork(same.workId)?.id ?? null;
      }
    }
    items.push({
      externalItemId: z.key,
      version: z.version,
      title: reference.title ?? '(untitled)',
      itemType: z.data.itemType,
      creators: reference.authors.map((a) => a.name ?? [a.givenName, a.familyName].filter(Boolean).join(' ')).slice(0, 5),
      year: reference.publicationYear,
      doi: reference.doi,
      hasPdf: pdfs.has(z.key),
      state,
      libraryItemId,
    });
  }
  const counts = new Map<string, number>();
  for (const z of top) for (const c of z.data.collections ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  const collectionInfo: ZoteroCollectionInfo[] = collections.map((c) => ({
    key: c.key,
    name: paths.get(c.key) ?? c.data.name,
    parentKey: c.data.parentCollection || null,
    itemCount: c.meta?.numItems ?? counts.get(c.key) ?? null,
  }));
  return { mode: ctx.client.mode, libraryVersion: version, collections: collectionInfo, items, skipped };
}

async function mapCollection(ctx: ZoteroContext, zc: ZoteroCollection, name: string): Promise<string> {
  const repo = ctx.library.repo;
  const mapped = repo.externalCollection('zotero', ctx.libraryId, zc.key);
  if (mapped && ctx.library.collections.getRow(mapped.collectionId)) return mapped.collectionId;
  const existing = ctx.library.collections.byName(name);
  const collectionId = existing?.id ?? ctx.collections.create({ name: name.slice(0, 120) }).id;
  repo.upsertExternalCollection({
    id: newLibraryId('ext'),
    collectionId,
    provider: 'zotero',
    externalLibraryId: ctx.libraryId,
    externalCollectionId: zc.key,
    externalVersion: zc.version,
    lastSyncedAt: new Date().toISOString(),
  });
  return collectionId;
}

/** Local API files: only PDFs inside a Zotero data folder's `storage` (next to `zotero.sqlite`), never through a link. */
async function localZoteroFile(fileUrl: string): Promise<string> {
  const p = fileURLToPath(fileUrl);
  const storage = path.dirname(path.dirname(p));
  if (path.basename(storage) !== 'storage' || !p.toLowerCase().endsWith('.pdf')) throw new LibraryError('FORBIDDEN', 'The attachment is not in Zotero\'s storage folder');
  await stat(path.join(path.dirname(storage), 'zotero.sqlite')).catch(() => {
    throw new LibraryError('FORBIDDEN', 'The attachment is not in a Zotero data folder');
  });
  const st = await lstat(p);
  if (!st.isFile()) throw new LibraryError('FORBIDDEN', 'The attachment is not a regular file');
  return p;
}

async function importPdfs(ctx: ZoteroContext, itemId: string, children: ZoteroItem[], signal: AbortSignal): Promise<string[]> {
  const problems: string[] = [];
  const existing = ctx.library.repo.attachmentsForItems([itemId]).map((a) => a.sourceUrl);
  for (const child of children) {
    const source = `zotero:${ctx.libraryId}/items/${child.key}`;
    if (existing.includes(source)) continue;
    try {
      const file = await ctx.client.file(ctx.userId, child.key, signal);
      const stream = 'localPath' in file ? createReadStream(await localZoteroFile(file.localPath)) : file.body;
      const received = await ctx.library.attachments.receive(stream, { originalFileName: child.data.filename ?? `${child.key}.pdf`, declaredType: 'application/pdf', attachmentType: 'pdf' }, signal);
      const expectedMd5 = 'md5' in file ? (file.md5 ?? child.data.md5 ?? null) : (child.data.md5 ?? null);
      if (expectedMd5) {
        const md5 = createHash('md5').update(await ctx.library.attachments.storage.readTemp(received.temp)).digest('hex');
        if (md5 !== expectedMd5.toLowerCase()) {
          await ctx.library.attachments.discard(received);
          problems.push(`${child.data.filename ?? child.key}: the download does not match Zotero's checksum`);
          continue;
        }
      }
      await ctx.library.attachments.attach(itemId, received, { attachmentType: 'pdf', source: 'zotero', sourceUrl: source });
    } catch (err) {
      if (signal.aborted) throw new LibraryCancelledError();
      problems.push(`${child.data.filename ?? child.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

async function recordLink(ctx: ZoteroContext, itemId: string, z: ZoteroItem, existing: ExternalLinkRow | null): Promise<void> {
  const item = await ctx.library.getItem(itemId);
  const values = {
    externalVersion: z.version,
    lastSyncedAt: new Date().toISOString(),
    syncStatus: 'synced' as const,
    remoteSnapshot: comparable(z.data),
    localFingerprint: fingerprint(localComparable(item)),
    conflict: null,
  };
  if (existing) ctx.library.repo.updateLink(existing.id, values);
  else ctx.library.repo.insertLink({ id: newLibraryId('ext'), libraryItemId: itemId, provider: 'zotero', externalLibraryId: ctx.libraryId, externalItemId: z.key, ...values });
}

/** Apply a remote Zotero item to its linked library item. */
export async function applyRemote(ctx: ZoteroContext, link: ExternalLinkRow, z: ZoteroItem): Promise<void> {
  const { reference, tags } = referenceFromZotero(z, ctx.libraryId);
  ctx.library.replaceSourceRecord(link.libraryItemId, reference);
  if (tags.length) await ctx.library.bulk([link.libraryItemId], { kind: 'add-tags', tags });
  await recordLink(ctx, link.libraryItemId, z, link);
}

/** Import (or refresh) items from Zotero inside a job. */
export async function runZoteroImport(ctx: ZoteroContext, options: ZoteroImportOptions, job: JobContext): Promise<void> {
  const { top, pdfs, collections } = await fetchAll(ctx, options.collectionKey, job.signal);
  const chosen = options.itemKeys ? top.filter((z) => options.itemKeys!.includes(z.key)) : top;
  job.setTotal(chosen.length);
  const paths = collectionPaths(collections);
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const repo = ctx.library.repo;

  for (const z of chosen) {
    if (job.signal.aborted) throw new LibraryCancelledError();
    const { reference, tags, collections: zcols } = referenceFromZotero(z, ctx.libraryId);
    const label = reference.title ?? z.key;
    try {
      const link = repo.linkByExternal('zotero', ctx.libraryId, z.key);
      let result: ImportItemResult;
      let itemId: string;
      if (link) {
        itemId = link.libraryItemId;
        if (!remoteChanged(link, z)) {
          result = { label, outcome: 'skipped', libraryItemId: itemId, confidence: null, message: 'Already imported and unchanged' };
        } else if (await localChanged(ctx, link)) {
          const item = await ctx.library.getItem(itemId);
          repo.updateLink(link.id, {
            syncStatus: 'conflict',
            conflict: { fields: differences(localComparable(item), comparable(z.data)), detectedAt: new Date().toISOString() },
          });
          result = { label, outcome: 'conflict', libraryItemId: itemId, confidence: null, message: 'Changed both here and in Zotero; choose which version to keep' };
        } else {
          await applyRemote(ctx, link, z);
          result = { label, outcome: 'updated', libraryItemId: itemId, confidence: null, message: 'Updated from Zotero' };
        }
      } else {
        if (!reference.title?.trim()) {
          job.record({ label: z.key, outcome: 'failed', libraryItemId: null, confidence: null, message: 'The Zotero item has no title' });
          continue;
        }
        const outcome =
          options.resolveIdentifiers && ctx.library.hasLookup && (reference.doi || reference.arxivId)
            ? await resolveReference(reference, ctx.library.lookup, { searchTitle: false }, job.signal)
            : null;
        const added = await ctx.library.addReference(reference, outcome, { tags });
        itemId = added.item.id;
        if (repo.linksForItems([itemId]).some((l) => l.provider === 'zotero' && l.externalLibraryId === ctx.libraryId)) {
          job.record({ label, outcome: 'duplicate', libraryItemId: itemId, confidence: null, message: 'The library item is already linked to another Zotero item' });
          continue;
        }
        if (!added.created && tags.length) await ctx.library.bulk([itemId], { kind: 'add-tags', tags });
        await recordLink(ctx, itemId, z, null);
        result = added.created
          ? { label, outcome: 'added', libraryItemId: itemId, confidence: outcome?.confidence ?? null, message: null }
          : { label, outcome: 'duplicate', libraryItemId: itemId, confidence: null, message: `Linked to the paper already in the library (${added.duplicateReason})` };
      }

      const notes: string[] = [];
      if (options.importCollections) {
        for (const key of zcols) {
          const zc = byKey.get(key);
          if (!zc) continue;
          const collectionId = await mapCollection(ctx, zc, paths.get(key) ?? zc.data.name);
          ctx.collections.addItems(collectionId, [itemId]);
        }
      }
      if (options.importPdfs && pdfs.has(z.key)) notes.push(...(await importPdfs(ctx, itemId, pdfs.get(z.key)!, job.signal)));
      if (notes.length) result = { ...result, message: [result.message, ...notes].filter(Boolean).join('; ') };
      job.record(result);
    } catch (err) {
      if (job.signal.aborted) throw new LibraryCancelledError();
      job.record({ label, outcome: 'failed', libraryItemId: null, confidence: null, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Settle a conflict. `remote`: take Zotero's version. `local`: keep the
 * library's version; the next export writes it to Zotero.
 */
export async function resolveZoteroConflict(ctx: ZoteroContext, libraryItemId: string, keep: 'local' | 'remote', signal?: AbortSignal): Promise<void> {
  const link = ctx.library.repo.linkByItem('zotero', ctx.libraryId, libraryItemId);
  if (!link) throw new LibraryError('NOT_FOUND', 'This item is not linked to Zotero');
  const [remote] = await ctx.client.itemsByKey(ctx.userId, [link.externalItemId], signal);
  if (!remote) throw new LibraryError('NOT_FOUND', 'The Zotero item no longer exists');
  if (keep === 'remote') {
    await applyRemote(ctx, link, remote);
    return;
  }
  ctx.library.repo.updateLink(link.id, {
    externalVersion: remote.version,
    remoteSnapshot: comparable(remote.data),
    syncStatus: 'local-changes',
    conflict: null,
  });
}
