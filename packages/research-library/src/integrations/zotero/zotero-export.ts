import type { ZoteroExportPreviewItem } from '@research-studio/shared-types';
import { LibraryCancelledError } from '../../errors/library-errors';
import type { JobContext } from '../../imports/import-jobs';
import type { ExternalLinkRow } from '../../library/library-repository';
import { newLibraryId } from '../../library/library-service';
import { ZoteroHttpError } from './zotero-client';
import { localComparable, type ZoteroContext } from './zotero-import';
import { comparable, differences, fingerprint, zoteroDataFromWork, type ZoteroItem } from './zotero-mapper';

interface Planned {
  libraryItemId: string;
  title: string;
  action: ZoteroExportPreviewItem['action'];
  link: ExternalLinkRow | null;
  remote: ZoteroItem | null;
}

async function plan(ctx: ZoteroContext, itemIds: readonly string[], signal?: AbortSignal): Promise<Planned[]> {
  const items = await ctx.library.items(itemIds);
  const links = new Map(items.map((i) => [i.id, ctx.library.repo.linkByItem('zotero', ctx.libraryId, i.id)]));
  const linkedKeys = [...links.values()].filter((l): l is ExternalLinkRow => !!l).map((l) => l.externalItemId);
  const remote = new Map((await ctx.client.itemsByKey(ctx.userId, linkedKeys, signal)).map((r) => [r.key, r]));
  return items.map((item) => {
    const link = links.get(item.id) ?? null;
    if (!link) return { libraryItemId: item.id, title: item.work.title, action: 'create', link, remote: null };
    const r = remote.get(link.externalItemId) ?? null;
    if (!r) return { libraryItemId: item.id, title: item.work.title, action: 'create', link, remote: null }; // deleted in Zotero
    const localChanged = link.syncStatus === 'local-changes' || fingerprint(localComparable(item)) !== link.localFingerprint;
    const remoteChanged = r.version > (link.externalVersion ?? 0) && fingerprint(comparable(r.data)) !== fingerprint((link.remoteSnapshot as Record<string, string> | null) ?? {});
    const action: Planned['action'] = link.syncStatus === 'conflict' || (localChanged && remoteChanged) ? 'conflict' : localChanged ? 'update' : 'unchanged';
    return { libraryItemId: item.id, title: item.work.title, action, link, remote: r };
  });
}

/** What exporting these items to Zotero would do. Nothing is written. */
export async function previewZoteroExport(ctx: ZoteroContext, itemIds: readonly string[], signal?: AbortSignal): Promise<ZoteroExportPreviewItem[]> {
  return (await plan(ctx, itemIds, signal)).map((p) => ({
    libraryItemId: p.libraryItemId,
    title: p.title,
    action: p.action,
    externalItemId: p.link?.externalItemId ?? null,
  }));
}

/**
 * Export items to the Zotero web library: new items are created, linked items
 * changed here are updated if Zotero still has the version they were synced
 * from; items changed on both sides are left alone and marked as conflicts.
 * PDFs are not uploaded.
 */
export async function runZoteroExport(ctx: ZoteroContext, itemIds: readonly string[], job: JobContext): Promise<void> {
  const planned = await plan(ctx, itemIds, job.signal);
  job.setTotal(planned.length);
  const repo = ctx.library.repo;
  const now = () => new Date().toISOString();
  const dataFor = async (id: string) => {
    const item = await ctx.library.getItem(id);
    return { item, data: zoteroDataFromWork(item.work, { citationKey: item.citationKey, tags: item.tags, collections: [] }) };
  };

  const creates = planned.filter((p) => p.action === 'create');
  if (creates.length) {
    const prepared = await Promise.all(creates.map((p) => dataFor(p.libraryItemId)));
    const res = await ctx.client.createItems(ctx.userId, prepared.map((p) => p.data), job.signal);
    prepared.forEach(({ item, data }, i) => {
      const ok = res.successful[String(i)];
      if (!ok) {
        const failed = res.failed[String(i)];
        job.record({ label: item.work.title, outcome: 'failed', libraryItemId: item.id, confidence: null, message: failed ? `Zotero refused the item: ${failed.message}` : 'Zotero did not create the item' });
        return;
      }
      const values = {
        externalItemId: ok.key,
        externalVersion: ok.version,
        lastSyncedAt: now(),
        syncStatus: 'synced' as const,
        remoteSnapshot: comparable(data),
        localFingerprint: fingerprint(localComparable(item)),
        conflict: null,
      };
      const old = creates[i]!.link;
      if (old) repo.updateLink(old.id, values);
      else repo.insertLink({ id: newLibraryId('ext'), libraryItemId: item.id, provider: 'zotero', externalLibraryId: ctx.libraryId, ...values });
      job.record({ label: item.work.title, outcome: 'added', libraryItemId: item.id, confidence: null, message: 'Created in Zotero' });
    });
  }

  for (const p of planned.filter((x) => x.action !== 'create')) {
    if (job.signal.aborted) throw new LibraryCancelledError();
    if (p.action === 'unchanged') {
      job.record({ label: p.title, outcome: 'skipped', libraryItemId: p.libraryItemId, confidence: null, message: 'No changes to send' });
      continue;
    }
    const { item, data } = await dataFor(p.libraryItemId);
    if (p.action === 'conflict') {
      repo.updateLink(p.link!.id, {
        syncStatus: 'conflict',
        conflict: { fields: differences(localComparable(item), comparable(p.remote!.data)), detectedAt: now() },
      });
      job.record({ label: p.title, outcome: 'conflict', libraryItemId: p.libraryItemId, confidence: null, message: 'Changed both here and in Zotero; choose which version to keep' });
      continue;
    }
    try {
      // Keep the item's Zotero collections and tags; send only the fields the library manages.
      const { collections: _c, tags: _t, ...fields } = data;
      const version = await ctx.client.updateItem(ctx.userId, p.link!.externalItemId, fields, p.link!.externalVersion ?? p.remote!.version, job.signal);
      repo.updateLink(p.link!.id, {
        externalVersion: version,
        lastSyncedAt: now(),
        syncStatus: 'synced',
        remoteSnapshot: comparable({ ...p.remote!.data, ...fields }),
        localFingerprint: fingerprint(localComparable(item)),
        conflict: null,
      });
      job.record({ label: p.title, outcome: 'updated', libraryItemId: p.libraryItemId, confidence: null, message: 'Updated in Zotero' });
    } catch (err) {
      if (job.signal.aborted) throw new LibraryCancelledError();
      if (err instanceof ZoteroHttpError && err.status === 412) {
        repo.updateLink(p.link!.id, { syncStatus: 'conflict', conflict: { fields: differences(localComparable(item), comparable(p.remote!.data)), detectedAt: now() } });
        job.record({ label: p.title, outcome: 'conflict', libraryItemId: p.libraryItemId, confidence: null, message: 'Changed in Zotero during the export' });
      } else {
        job.record({ label: p.title, outcome: 'failed', libraryItemId: p.libraryItemId, confidence: null, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
