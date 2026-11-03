import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AttachmentDocumentParams,
  JobsQuery,
  PageQuery,
  PassageParams,
  ReindexRequest,
  ResearchSearchRequest,
  SimilarPassagesRequest,
  UpdateRetrievalSettingsRequest,
} from '@research-studio/api-contracts';
import { actorOf, parse } from './http';
import { clientSignal } from './routes-literature';
import type { DocumentRuntime } from './services/document-runtime';

const ProbeQuery = z.object({ probe: z.enum(['1', '0']).optional() });

/**
 * Document intelligence and retrieval routes (M3.3), inside the
 * authenticated `/api/v1` scope. Documents are addressed by library
 * attachment ID; no response contains a file-system path.
 */
export function registerDocumentRoutes(api: FastifyInstance, docs: DocumentRuntime): void {
  // ------------------------------------------------------------ documents
  api.post('/documents/:attachmentId/process', async (request, reply) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    const r = docs.process(attachmentId, 'process', actorOf(request));
    return reply.code(r.created ? 202 : 200).send(r);
  });

  api.post('/documents/:attachmentId/reprocess', async (request, reply) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    const r = docs.process(attachmentId, 'reprocess', actorOf(request));
    return reply.code(r.created ? 202 : 200).send(r);
  });

  api.post('/documents/:attachmentId/cancel', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.cancel(attachmentId, actorOf(request));
  });

  api.get('/documents/:attachmentId/status', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.documentStatus(attachmentId);
  });

  api.get('/documents/:attachmentId/structure', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.structure(attachmentId);
  });

  api.get('/documents/:attachmentId/sections', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.sectionsOf(attachmentId);
  });

  api.get('/documents/:attachmentId/passages', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    const { offset, limit } = parse(PageQuery, request.query);
    return docs.passagesOf(attachmentId, offset, limit);
  });

  api.get('/documents/:attachmentId/references', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.referencesOf(attachmentId);
  });

  api.get('/documents/:attachmentId/elements', async (request) => {
    const { attachmentId } = parse(AttachmentDocumentParams, request.params);
    return docs.elementsOf(attachmentId);
  });

  api.get('/documents/jobs', async (request) => {
    const { status, limit } = parse(JobsQuery, request.query);
    return { jobs: docs.jobs(status, limit) };
  });

  api.post('/documents/process-all', async (request) => docs.processAll(actorOf(request)));

  // ------------------------------------------------------------- research
  api.post('/research/search', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const input = parse(ResearchSearchRequest, request.body);
    return docs.search(input, clientSignal(reply));
  });

  api.post('/research/search/passage', { bodyLimit: 32 * 1024 }, async (request) => {
    const input = parse(SimilarPassagesRequest, request.body);
    return docs.similar(input);
  });

  api.get('/research/passages/:passageId', async (request) => {
    const { passageId } = parse(PassageParams, request.params);
    return docs.passageDetail(passageId);
  });

  api.get('/research/passages/:passageId/location', async (request) => {
    const { passageId } = parse(PassageParams, request.params);
    return docs.passageLocation(passageId);
  });

  // ------------------------------------------------------------ retrieval
  api.get('/retrieval/providers', async (request) => {
    const { probe } = parse(ProbeQuery, request.query);
    return docs.providers(probe === '1');
  });

  api.patch('/retrieval/settings', async (request) => {
    const patch = parse(UpdateRetrievalSettingsRequest, request.body);
    return docs.updateSettings(patch, actorOf(request));
  });

  api.get('/retrieval/index/status', async () => docs.indexStatus());

  api.post('/retrieval/reindex', async (request, reply) => {
    const { rebuild } = parse(ReindexRequest, request.body ?? {});
    return reply.code(202).send(docs.startReindex(rebuild, actorOf(request)));
  });

  api.post('/retrieval/reindex/cancel', async () => docs.cancelReindex());
}
