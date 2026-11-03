import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AddLibraryItemRequest,
  AttachmentParams,
  BibApplyRequest,
  BibPreviewRequest,
  BulkLibraryRequest,
  CollectionParams,
  CreateCollectionRequest,
  ExportRequest,
  IdentifierImportRequest,
  ImportJobParams,
  ItemIdsRequest,
  LibraryItemParams,
  LibraryItemQuerySchema,
  MAX_REFERENCE_TEXT,
  MatchRequest,
  MergeRequest,
  MoveItemsRequest,
  ProjectParams,
  ReferenceImportRequest,
  ReferencePreviewRequest,
  RegenerateKeysRequest,
  RenameAttachmentRequest,
  SetCitationKeyRequest,
  UpdateCollectionRequest,
  UpdateLibraryItemRequest,
  UpdateLibraryPreferencesRequest,
  UpdateProjectReferenceSettingsRequest,
  ZoteroConflictRequest,
  ZoteroImportPreviewRequest,
  ZoteroImportRequest,
  ZoteroLocalRequest,
  ZoteroWebKeyRequest,
} from '@research-studio/api-contracts';
import { LibraryError, previewReferences } from '@research-studio/research-library';
import { StudioError } from '@research-studio/shared-types';
import { actorOf, parse, RAW_CSP } from './http';
import { clientSignal } from './routes-literature';
import type { LibraryRuntime, ReceivedUpload } from './services/library-runtime';
import type { ProjectService } from './services/project-service';

/** Files in one PDF upload request. */
const MAX_UPLOAD_FILES = 50;

const UploadQuery = z.object({ collectionId: z.string().min(3).max(80).regex(/^[A-Za-z0-9_:-]+$/).optional() });
const DownloadQuery = z.object({ download: z.enum(['1', '0']).optional() });
const ZoteroStatusQuery = z.object({ probe: z.enum(['1', '0']).optional() });

/** `inline`/`attachment` disposition with an ASCII fallback and the UTF-8 name (RFC 6266/8187). */
function disposition(kind: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Stream the request's PDF parts into temporary storage. Names and types from
 * the browser are only labels; where the bytes go is decided by the storage.
 */
async function receiveUploads(request: FastifyRequest, lib: LibraryRuntime, maxFiles: number): Promise<ReceivedUpload[]> {
  if (!request.isMultipart()) throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data');
  const received: ReceivedUpload[] = [];
  try {
    const parts = request.parts({ limits: { fileSize: lib.maxPdfBytes, files: maxFiles, fields: 0, parts: maxFiles } });
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const meta = { originalFileName: part.filename, declaredType: part.mimetype, attachmentType: 'pdf' as const };
      try {
        received.push({ temp: await lib.attachments.receiveRaw(part.file, meta), meta });
      } catch (err) {
        part.file.resume();
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new LibraryError('PAYLOAD_TOO_LARGE', `${part.filename} is larger than the limit for library files`);
        }
        throw err;
      }
    }
  } catch (err) {
    await lib.discardUploads(received);
    throw err;
  }
  if (!received.length) throw new StudioError('BAD_REQUEST', 'No file was uploaded');
  return received;
}

/** Library routes, registered inside the authenticated `/api/v1` scope. */
export function registerLibraryRoutes(api: FastifyInstance, lib: LibraryRuntime, projects: ProjectService): void {
  const { library, collections, jobs } = lib;

  // ------------------------------------------------------------ overview

  api.get('/library/overview', async () => ({ overview: library.overview() }));

  api.get('/library/preferences', async () => ({ preferences: lib.preferences() }));
  api.patch('/library/preferences', async (request) => {
    const patch = parse(UpdateLibraryPreferencesRequest, request.body);
    return { preferences: lib.updatePreferences(patch) };
  });

  api.get('/library/tags', async () => ({ tags: library.repo.listTags() }));

  // --------------------------------------------------------------- items

  api.get('/library/items', async (request) => library.query(parse(LibraryItemQuerySchema, request.query)));

  api.post('/library/items', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const input = parse(AddLibraryItemRequest, request.body);
    const result = await lib.add(input, clientSignal(reply));
    return reply.code(result.created ? 201 : 200).send(result);
  });

  api.get('/library/items/:itemId', async (request) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    return { item: await library.getItem(itemId) };
  });

  api.patch('/library/items/:itemId', { bodyLimit: 512 * 1024 }, async (request) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    const patch = parse(UpdateLibraryItemRequest, request.body);
    return { item: await library.update(itemId, patch) };
  });

  /** Opening a paper records when it was opened; it never changes the reading status. */
  api.post('/library/items/:itemId/opened', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    library.markOpened(itemId);
    return reply.code(204).send();
  });

  api.post('/library/items/bulk', async (request) => {
    const { itemIds, action } = parse(BulkLibraryRequest, request.body);
    return { updated: await library.bulk(itemIds, action) };
  });

  api.post('/library/items/deletion-impact', async (request) => {
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return library.deletionImpact(itemIds);
  });

  api.post('/library/items/delete', async (request) => {
    const { itemIds } = parse(ItemIdsRequest, request.body);
    const impact = library.deletionImpact(itemIds);
    const deleted = await library.deleteItems(itemIds);
    lib.audit.record({
      action: 'library.items.delete',
      outcome: 'success',
      actor: actorOf(request).sessionId,
      details: { items: deleted, attachments: impact.attachments, projects: impact.projects.map((p) => p.id) },
    });
    return { deleted };
  });

  api.get('/library/items/:itemId/citation-keys', async (request) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    return { suggestions: library.suggestCitationKeys(itemId) };
  });

  api.put('/library/items/:itemId/citation-key', async (request) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    const { key, confirm } = parse(SetCitationKeyRequest, request.body);
    const before = (await library.getItem(itemId)).citationKey;
    const item = await library.setCitationKey(itemId, key, confirm ?? false);
    if (before !== item.citationKey) {
      lib.audit.record({ action: 'library.citation-key', outcome: 'success', actor: actorOf(request).sessionId, target: itemId, details: { from: before, to: item.citationKey } });
    }
    return { item };
  });

  api.post('/library/citation-keys/regenerate', async (request) => {
    const { itemIds, replaceExisting } = parse(RegenerateKeysRequest, request.body);
    return library.regenerateCitationKeys(itemIds, replaceExisting);
  });

  api.post('/library/items/:itemId/match', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    const input = parse(MatchRequest, request.body);
    if (input.action === 'accept-candidate') return { item: await library.acceptCandidate(itemId, input.candidateWorkId) };
    if (input.action === 'link-work') return { item: await library.linkToWork(itemId, input.workId, clientSignal(reply)) };
    return { item: await library.keepUnresolved(itemId) };
  });

  api.post('/library/items/:itemId/refresh', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    return { item: await library.refresh(itemId, clientSignal(reply)) };
  });

  api.get('/library/duplicates', async () => ({ groups: library.duplicateGroups() }));

  api.post('/library/merge', async (request) => {
    const { keepId, dropId } = parse(MergeRequest, request.body);
    const result = await library.merge(keepId, dropId);
    lib.audit.record({ action: 'library.items.merge', outcome: 'success', actor: actorOf(request).sessionId, target: keepId, details: { dropped: dropId } });
    return result;
  });

  // --------------------------------------------------------- attachments

  api.post('/library/items/:itemId/attachments', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    await library.getItem(itemId);
    const uploads = await receiveUploads(request, lib, 1);
    return reply.code(202).send({ job: lib.importUploads(uploads, { targetItemId: itemId }, actorOf(request)) });
  });

  /** Download the open-access PDF listed in the paper's record (the runtime picks the URL). */
  api.post('/library/items/:itemId/fetch-pdf', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    return reply.code(202).send({ job: lib.fetchPdfFor(itemId, await library.getItem(itemId)) });
  });

  api.get('/library/attachments/:attachmentId/content', async (request, reply) => {
    const { attachmentId } = parse(AttachmentParams, request.params);
    const { download } = parse(DownloadQuery, request.query);
    const { attachment, stream, size } = await lib.attachments.open(attachmentId);
    return reply
      .type(attachment.mimeType)
      .header('content-length', size)
      .header('content-security-policy', RAW_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', disposition(download === '1' ? 'attachment' : 'inline', attachment.fileName))
      .send(stream);
  });

  api.patch('/library/attachments/:attachmentId', async (request) => {
    const { attachmentId } = parse(AttachmentParams, request.params);
    const { fileName } = parse(RenameAttachmentRequest, request.body);
    return { attachment: lib.attachments.rename(attachmentId, fileName) };
  });

  api.delete('/library/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = parse(AttachmentParams, request.params);
    await lib.attachments.remove(attachmentId);
    lib.audit.record({ action: 'library.attachment.delete', outcome: 'success', actor: actorOf(request).sessionId, target: attachmentId });
    return reply.code(204).send();
  });

  api.post('/library/storage/sweep', async (request) => lib.sweepStorage(actorOf(request)));

  // ------------------------------------------------------------- imports

  api.post('/library/imports/pdf', async (request, reply) => {
    const { collectionId } = parse(UploadQuery, request.query);
    if (collectionId) collections.get(collectionId);
    const uploads = await receiveUploads(request, lib, MAX_UPLOAD_FILES);
    const job = lib.importUploads(uploads, collectionId ? { add: { collectionIds: [collectionId] } } : {}, actorOf(request));
    return reply.code(202).send({ job });
  });

  api.post('/library/imports/references/preview', { bodyLimit: MAX_REFERENCE_TEXT * 2 }, async (request) => {
    const { format, text } = parse(ReferencePreviewRequest, request.body);
    return previewReferences(library, format, text);
  });

  api.post('/library/imports/references', { bodyLimit: MAX_REFERENCE_TEXT * 2 }, async (request, reply) => {
    const input = parse(ReferenceImportRequest, request.body);
    return reply.code(202).send({ job: lib.importReferences(input, actorOf(request)) });
  });

  api.post('/library/imports/identifiers', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const input = parse(IdentifierImportRequest, request.body);
    return reply.code(202).send({ job: lib.importIdentifiers(input, actorOf(request)) });
  });

  api.get('/library/jobs', async () => ({ jobs: jobs.recent(30) }));

  api.get('/library/jobs/:jobId', async (request) => {
    const { jobId } = parse(ImportJobParams, request.params);
    return { job: jobs.get(jobId) };
  });

  api.post('/library/jobs/:jobId/cancel', async (request) => {
    const { jobId } = parse(ImportJobParams, request.params);
    jobs.cancel(jobId);
    return { job: jobs.get(jobId) };
  });

  // -------------------------------------------------------------- export

  api.post('/library/export', async (request) => {
    const { format, selection } = parse(ExportRequest, request.body);
    if ('projectId' in selection) projects.get(selection.projectId);
    const { text, count } = format === 'bibtex' ? library.exportBibtex(selection) : library.exportRis(selection);
    return { format, text, count, fileName: format === 'bibtex' ? 'library.bib' : 'library.ris' };
  });

  // --------------------------------------------------------- collections

  api.get('/library/collections', async () => ({ collections: collections.list() }));

  api.post('/library/collections', async (request, reply) => {
    const input = parse(CreateCollectionRequest, request.body);
    return reply.code(201).send({ collection: collections.create(input) });
  });

  api.patch('/library/collections/:collectionId', async (request) => {
    const { collectionId } = parse(CollectionParams, request.params);
    const patch = parse(UpdateCollectionRequest, request.body);
    return { collection: collections.update(collectionId, patch) };
  });

  /** Deleting a collection keeps its papers. */
  api.delete('/library/collections/:collectionId', async (request, reply) => {
    const { collectionId } = parse(CollectionParams, request.params);
    collections.delete(collectionId);
    return reply.code(204).send();
  });

  api.post('/library/collections/:collectionId/items', async (request) => {
    const { collectionId } = parse(CollectionParams, request.params);
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return { count: collections.addItems(collectionId, itemIds) };
  });

  api.post('/library/collections/:collectionId/items/remove', async (request) => {
    const { collectionId } = parse(CollectionParams, request.params);
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return { count: collections.removeItems(collectionId, itemIds) };
  });

  api.post('/library/collections/move', async (request) => {
    const { fromId, toId, itemIds } = parse(MoveItemsRequest, request.body);
    return { count: collections.moveItems(fromId, toId, itemIds) };
  });

  // -------------------------------------------------- project references

  api.get('/projects/:projectId/references', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    return lib.projectReferences(actorOf(request)).references(projectId);
  });

  api.patch('/projects/:projectId/references/settings', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    const patch = parse(UpdateProjectReferenceSettingsRequest, request.body);
    return { settings: await lib.projectReferences(actorOf(request)).updateSettings(projectId, patch) };
  });

  api.post('/projects/:projectId/references/items', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return { count: lib.projectReferences(actorOf(request)).link(projectId, itemIds) };
  });

  api.post('/projects/:projectId/references/items/remove', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return { count: lib.projectReferences(actorOf(request)).unlink(projectId, itemIds) };
  });

  /** The proposed `.bib` change. Nothing is written until the reviewed changes are applied. */
  api.post('/projects/:projectId/references/bib/preview', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    const input = parse(BibPreviewRequest, request.body);
    return lib.projectReferences(actorOf(request)).preview(projectId, input);
  });

  api.post('/projects/:projectId/references/bib/apply', async (request) => {
    const { projectId } = parse(ProjectParams, request.params);
    projects.get(projectId);
    const input = parse(BibApplyRequest, request.body);
    const result = await lib.projectReferences(actorOf(request)).apply(projectId, input);
    lib.audit.record({
      action: 'library.bib.apply',
      outcome: 'success',
      actor: actorOf(request).sessionId,
      projectId,
      target: result.path,
      details: { changes: result.applied.map((c) => c.kind) },
    });
    return result;
  });

  // -------------------------------------------------------------- Zotero

  api.get('/library/zotero', async (request) => {
    const { probe } = parse(ZoteroStatusQuery, request.query);
    return { status: await lib.zoteroStatus(probe === '1') };
  });

  api.put('/library/zotero/web-key', { bodyLimit: 4096 }, async (request) => {
    const { apiKey } = parse(ZoteroWebKeyRequest, request.body);
    return { status: await lib.setZoteroKey(apiKey, actorOf(request)) };
  });

  api.delete('/library/zotero/web-key', async (request) => ({ status: await lib.deleteZoteroKey(actorOf(request)) }));

  api.put('/library/zotero/local', async (request) => {
    const { enabled } = parse(ZoteroLocalRequest, request.body);
    return { status: await lib.setZoteroLocal(enabled) };
  });

  api.post('/library/zotero/import/preview', async (request, reply) => {
    const { mode, collectionKey } = parse(ZoteroImportPreviewRequest, request.body);
    return lib.previewZoteroImport(mode, collectionKey, clientSignal(reply));
  });

  api.post('/library/zotero/import', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const input = parse(ZoteroImportRequest, request.body);
    return reply.code(202).send({ job: await lib.importZotero(input, actorOf(request)) });
  });

  api.post('/library/zotero/export/preview', async (request, reply) => {
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return { items: await lib.previewZoteroExport(itemIds, clientSignal(reply)) };
  });

  api.post('/library/zotero/export', async (request, reply) => {
    const { itemIds } = parse(ItemIdsRequest, request.body);
    return reply.code(202).send({ job: await lib.exportZotero(itemIds, actorOf(request)) });
  });

  api.post('/library/items/:itemId/zotero-conflict', async (request, reply) => {
    const { itemId } = parse(LibraryItemParams, request.params);
    const { keep } = parse(ZoteroConflictRequest, request.body);
    return { item: await lib.resolveZoteroConflict(itemId, keep, clientSignal(reply)) };
  });
}
