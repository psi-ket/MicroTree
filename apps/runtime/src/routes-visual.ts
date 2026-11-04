import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApplyInsertionRequest,
  ApproveRequest,
  ArtifactParams,
  ArtifactsQuery,
  AssetParams,
  AssetsQuery,
  ChooseTaskTypeRequest,
  CircuitReconstructRequest,
  CompareQuery,
  CompileRequestBody,
  CreateVisualTaskRequest,
  ExportQuery,
  InsertionOptionsSchema,
  InsertionParams,
  InsertionsQuery,
  ManualEditRequest,
  PdfRegionFields,
  PlotUpdateRequest,
  ProjectImageRequest,
  ProviderCheckQuery,
  ReconstructRequest,
  RefineRequest,
  RestoreRequest,
  RetryTaskRequest,
  TaskParams,
  TasksQuery,
  ValidateRequest,
  VariantRequest,
  VersionParams,
} from '@research-studio/api-contracts';
import { StudioError, type VisualTaskType } from '@research-studio/shared-types';
import { actorOf, parse, RAW_CSP } from './http';
import { clientSignal } from './routes-literature';
import type { VisualRuntime } from './services/visual-runtime';

const ProviderParams = z.object({ providerId: z.string().regex(/^[a-z0-9-]{2,64}$/) });
const ImageFields = z.object({ source: z.enum(['upload', 'clipboard']).default('upload'), projectId: z.string().max(80).optional() });

/** One image part plus its text fields; the browser's name and type are only labels. */
async function receiveImage(request: FastifyRequest, maxBytes: number): Promise<{ bytes: Buffer; fileName: string | null; mimeType: string | null; fields: Record<string, string> }> {
  if (!request.isMultipart()) throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data');
  const part = await request.file({ limits: { fileSize: maxBytes, files: 1, fields: 12 } });
  if (!part) throw new StudioError('BAD_REQUEST', 'No image was uploaded');
  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new StudioError('PAYLOAD_TOO_LARGE', 'The image is larger than the limit for images');
    throw err;
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(part.fields)) if (v && !Array.isArray(v) && v.type === 'field') fields[k] = String(v.value ?? '');
  return { bytes, fileName: part.filename ? part.filename.slice(0, 200) : null, mimeType: part.mimetype || null, fields };
}

/**
 * Visual intelligence routes (M4), inside the authenticated `/api/v1` scope.
 * Images, tasks, artifacts and insertions are addressed by ID; no response
 * contains a file-system path, and stored images are served inert.
 */
export function registerVisualRoutes(api: FastifyInstance, visual: VisualRuntime, maxImageBytes: number): void {
  const imageLimit = { bodyLimit: maxImageBytes + 64 * 1024 };

  // ------------------------------------------------------------- assets
  api.post('/visual/assets', imageLimit, async (request, reply) => {
    const img = await receiveImage(request, maxImageBytes);
    const f = parse(ImageFields, img.fields);
    return reply.code(201).send(await visual.addUpload(img.bytes, { fileName: img.fileName, declaredType: img.mimeType, source: f.source, projectId: f.projectId ?? null }, actorOf(request)));
  });

  api.post('/visual/assets/from-project', async (request, reply) => {
    const { projectId, path } = parse(ProjectImageRequest, request.body);
    return reply.code(201).send(await visual.addFromProject(projectId, path, actorOf(request)));
  });

  api.post('/visual/assets/pdf-region', imageLimit, async (request, reply) => {
    const img = await receiveImage(request, maxImageBytes);
    const region = parse(PdfRegionFields, img.fields);
    return reply.code(201).send(await visual.addPdfRegion(img.bytes, region, actorOf(request)));
  });

  api.get('/visual/assets', async (request) => {
    const { projectId, limit } = parse(AssetsQuery, request.query);
    return { assets: visual.assets.listOriginals({ ...(projectId ? { projectId } : {}), limit }) };
  });

  api.get('/visual/assets/:assetId', async (request) => {
    const { assetId } = parse(AssetParams, request.params);
    return visual.assetDetail(assetId);
  });

  api.get('/visual/assets/:assetId/content', async (request, reply) => {
    const { assetId } = parse(AssetParams, request.params);
    const asset = visual.assetDetail(assetId).asset;
    // SVG sources are never served (their sanitised raster is); PDFs only as attachments of previews.
    const { row, bytes } = asset.mimeType === 'application/pdf' ? { row: asset, bytes: await visual.assets.read(assetId) } : await visual.assets.readDisplayable(assetId);
    return reply
      .type(row.mimeType)
      .header('content-security-policy', RAW_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-disposition', 'inline')
      .send(bytes);
  });

  api.post('/visual/assets/:assetId/variants', async (request, reply) => {
    const { assetId } = parse(AssetParams, request.params);
    const { operations, label } = parse(VariantRequest, request.body);
    return reply.code(201).send({ asset: await visual.variant(assetId, operations, label, actorOf(request)) });
  });

  api.get('/visual/assets/:assetId/artifacts', async (request) => {
    const { assetId } = parse(AssetParams, request.params);
    return { artifacts: visual.artifactsForAsset(visual.assetDetail(assetId).asset.originalAssetId) };
  });

  // ---------------------------------------------------------- providers
  api.get('/visual/providers', async () => visual.providerList());

  api.get('/visual/providers/:providerId/check', async (request) => {
    const { providerId } = parse(ProviderParams, request.params);
    const { model, taskType } = parse(ProviderCheckQuery, request.query);
    return visual.checkProvider(providerId, model, taskType);
  });

  // -------------------------------------------------------------- tasks
  const create = async (request: FastifyRequest, taskType: VisualTaskType, body: z.infer<typeof ReconstructRequest>) => visual.createTask({ ...body, taskType }, actorOf(request));

  api.post('/visual/tasks', async (request, reply) => {
    const input = parse(CreateVisualTaskRequest, request.body);
    return reply.code(202).send({ task: await visual.createTask(input, actorOf(request)) });
  });

  // Convenience endpoints for each kind of task.
  const kinds: [string, VisualTaskType][] = [
    ['/visual/equations/reconstruct', 'equation'],
    ['/visual/diagrams/reconstruct', 'diagram'],
    ['/visual/plots/reconstruct', 'plot'],
    ['/visual/diagrams/generate', 'text-to-diagram'],
    ['/visual/captions/generate', 'caption'],
  ];
  for (const [url, taskType] of kinds) {
    api.post(url, async (request, reply) => reply.code(202).send({ task: await create(request, taskType, parse(ReconstructRequest, request.body)) }));
  }
  api.post('/visual/circuits/reconstruct', async (request, reply) => {
    const { circuitType, ...body } = parse(CircuitReconstructRequest, request.body);
    return reply.code(202).send({ task: await create(request, circuitType === 'quantum' ? 'quantum-circuit' : 'electrical-circuit', body) });
  });

  api.get('/visual/tasks', async (request) => {
    const { projectId, limit } = parse(TasksQuery, request.query);
    return { tasks: visual.tasks({ projectId, limit }) };
  });

  api.get('/visual/tasks/:taskId', async (request) => {
    const { taskId } = parse(TaskParams, request.params);
    return { task: visual.task(taskId) };
  });

  api.post('/visual/tasks/:taskId/cancel', async (request) => {
    const { taskId } = parse(TaskParams, request.params);
    return { task: visual.cancel(taskId, actorOf(request)) };
  });

  api.post('/visual/tasks/:taskId/retry', async (request, reply) => {
    const { taskId } = parse(TaskParams, request.params);
    const { consent } = parse(RetryTaskRequest, request.body ?? {});
    return reply.code(202).send({ task: await visual.retry(taskId, consent, actorOf(request)) });
  });

  api.post('/visual/tasks/:taskId/choose', async (request, reply) => {
    const { taskId } = parse(TaskParams, request.params);
    const { taskType } = parse(ChooseTaskTypeRequest, request.body);
    return reply.code(202).send({ task: visual.choose(taskId, taskType, actorOf(request)) });
  });

  // ---------------------------------------------------------- artifacts
  api.get('/visual/artifacts', async (request) => {
    const { projectId } = parse(ArtifactsQuery, request.query);
    return { artifacts: visual.artifactList(projectId) };
  });

  api.get('/visual/artifacts/:artifactId', async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    return visual.artifact(artifactId);
  });

  api.get('/visual/artifacts/:artifactId/versions', async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    return { versions: await visual.versions(artifactId) };
  });

  api.get('/visual/artifacts/:artifactId/versions/:version', async (request) => {
    const { artifactId, version } = parse(VersionParams, request.params);
    return { version: visual.version(artifactId, version) };
  });

  api.post('/visual/artifacts/:artifactId/versions', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const input = parse(ManualEditRequest, request.body);
    return reply.code(201).send({ version: await visual.manualEdit(artifactId, input, actorOf(request)) });
  });

  api.post('/visual/artifacts/:artifactId/restore', async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const { version } = parse(RestoreRequest, request.body);
    return reply.code(201).send({ version: await visual.restore(artifactId, version, actorOf(request)) });
  });

  api.post('/visual/artifacts/:artifactId/validate', { bodyLimit: 512 * 1024 }, async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const { sourceCode } = parse(ValidateRequest, request.body ?? {});
    return visual.validate(artifactId, sourceCode);
  });

  api.post('/visual/artifacts/:artifactId/compile', async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const { version } = parse(CompileRequestBody, request.body ?? {});
    return reply.code(202).send({ version: await visual.compile(artifactId, version, actorOf(request)) });
  });

  api.get('/visual/artifacts/:artifactId/versions/:version/preview', async (request, reply) => {
    const { artifactId, version } = parse(VersionParams, request.params);
    const pdf = await visual.preview(artifactId, version);
    return reply.type('application/pdf').header('content-security-policy', RAW_CSP).header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').send(pdf);
  });

  api.post('/visual/artifacts/:artifactId/refine', async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const input = parse(RefineRequest, request.body);
    return reply.code(201).send(await visual.refine(artifactId, input, actorOf(request), clientSignal(reply)));
  });

  api.post('/visual/artifacts/:artifactId/plot', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const input = parse(PlotUpdateRequest, request.body);
    return reply.code(201).send({ version: await visual.updatePlot(artifactId, input, actorOf(request)) });
  });

  api.post('/visual/artifacts/:artifactId/approve', async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const { version } = parse(ApproveRequest, request.body);
    return { artifact: await visual.approve(artifactId, version, actorOf(request)) };
  });

  api.get('/visual/artifacts/:artifactId/compare', async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const { from, to } = parse(CompareQuery, request.query);
    return visual.compare(artifactId, from, to);
  });

  api.get('/visual/artifacts/:artifactId/versions/:version/export', async (request, reply) => {
    const { artifactId, version } = parse(VersionParams, request.params);
    const { format } = parse(ExportQuery, request.query);
    const out = visual.exportVersion(artifactId, version, format);
    return reply
      .type(`${out.contentType}; charset=utf-8`)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${out.fileName}"`)
      .send(out.content);
  });

  // ---------------------------------------------------------- insertion
  api.post('/visual/artifacts/:artifactId/insert/preview', async (request) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const input = parse(InsertionOptionsSchema, request.body);
    return { plan: await visual.previewInsertion(artifactId, input) };
  });

  api.post('/visual/artifacts/:artifactId/insert', async (request, reply) => {
    const { artifactId } = parse(ArtifactParams, request.params);
    const input = parse(ApplyInsertionRequest, request.body);
    return reply.code(201).send({ insertion: await visual.insert(artifactId, input, actorOf(request)) });
  });

  api.get('/visual/insertions', async (request) => {
    const { projectId } = parse(InsertionsQuery, request.query);
    return { insertions: visual.insertionList(projectId) };
  });

  api.post('/visual/insertions/:insertionId/rollback', async (request) => {
    const { insertionId } = parse(InsertionParams, request.params);
    return visual.rollback(insertionId, actorOf(request));
  });
}
