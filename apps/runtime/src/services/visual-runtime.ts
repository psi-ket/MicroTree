import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { PROVIDER_KINDS, type ModelProvider } from '@research-studio/ai-core';
import type { z } from 'zod';
import type {
  ApplyInsertionRequest,
  CreateVisualTaskRequest,
  InsertionOptionsSchema,
  ManualEditRequest,
  PlotUpdateRequest,
  VisualTask,
} from '@research-studio/api-contracts';
import { schema, type StudioDb } from '@research-studio/database';
import type { Toolchain } from '@research-studio/latex-engine';
import { StudioError, type FileTreeNode, type PreprocessOperation, type VisualProvenance, type VisualTaskType } from '@research-studio/shared-types';
import { ArtifactError, ArtifactService, lineDiff, newVisualId, ProjectInsertionService, type ArtifactRow, type InsertionFilesPort, type InsertionPlan, type VersionRow } from '@research-studio/visual-artifacts';
import { VisualAssetService } from '@research-studio/visual-assets';
import {
  buildPlot,
  buildPlotFromData,
  checkLatexSafety,
  checkStructure,
  DEFAULT_PLOT_STYLE,
  detectPackages,
  estimateImageTokens,
  exactSeries,
  IMAGE_TASKS,
  IsolatedCompiler,
  isVisualError,
  parseXyCsv,
  payloadForSource,
  PREVIEW_DATA_FILE,
  PROMPT_VERSION,
  refineArtifact,
  requireConsent,
  routeTask,
  runVisualTask,
  standaloneDocument,
  validateEquation,
  VisualError,
  type Axis,
  type PlotData,
  type PlotOutput,
  type PlotStyle,
  type Route,
} from '@research-studio/visual-engine';
import type { RuntimeConfig } from '../config';
import type { EventBus } from '../events';
import type { AiProviderService } from './ai/provider-service';
import type { AuditService } from './audit-service';
import type { LibraryRuntime } from './library-runtime';
import type { Actor, ProjectService } from './project-service';

type TaskRow = typeof schema.visualTasks.$inferSelect;
type CreateTaskInput = z.infer<typeof CreateVisualTaskRequest>;
type InsertionInput = z.infer<typeof InsertionOptionsSchema>;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const IMAGE_FILE = /\.(png|jpe?g|webp|svg)$/i;

/** Map engine and artifact errors onto the API's error codes. */
export function toStudioError(err: unknown): unknown {
  if (err instanceof ArtifactError) return new StudioError(err.code === 'not-found' ? 'NOT_FOUND' : err.code === 'conflict' ? 'CONFLICT' : 'BAD_REQUEST', err.message);
  if (!isVisualError(err)) return err;
  const details = { reason: err.code.toUpperCase().replace(/-/g, '_'), ...(err.details && typeof err.details === 'object' ? err.details : {}) };
  switch (err.code) {
    case 'unsupported-type':
      return new StudioError('UNSUPPORTED_MEDIA_TYPE', err.message, details);
    case 'too-large':
    case 'too-many-pixels':
      return new StudioError('PAYLOAD_TOO_LARGE', err.message, details);
    case 'consent-required':
    case 'cancelled':
      return new StudioError('CONFLICT', err.message, details);
    case 'provider-error':
      return new StudioError('PROVIDER_ERROR', err.message, details);
    case 'compile-unavailable':
      return new StudioError('TOOLCHAIN_MISSING', err.message, details);
    default:
      return new StudioError('BAD_REQUEST', err.message, details);
  }
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toStudioError(err);
  }
}

function flatten(node: FileTreeNode, out: string[] = []): string[] {
  if (node.type === 'file') out.push(node.path);
  for (const c of node.children ?? []) flatten(c, out);
  return out;
}

export interface VisualRuntimeOptions {
  concurrency?: number;
}

/**
 * Visual intelligence (M4) inside the runtime: image assets, the task queue
 * that runs vision models, artifact versions, isolated preview compiles and
 * reviewed insertion into projects. Every model call names its provider,
 * model and privacy mode on the task record; cloud tasks need the user's
 * consent for that task.
 */
export class VisualRuntime {
  readonly assets: VisualAssetService;
  readonly artifacts: ArtifactService;
  readonly insertions: ProjectInsertionService;
  readonly compiler: IsolatedCompiler;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private active = 0;
  private readonly concurrency: number;
  private stopped = false;

  constructor(
    private readonly db: StudioDb,
    private readonly config: RuntimeConfig,
    private readonly providers: AiProviderService,
    private readonly projects: ProjectService,
    private readonly library: LibraryRuntime,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    toolchain: Toolchain,
    options: VisualRuntimeOptions = {},
  ) {
    this.assets = new VisualAssetService(db, config.visual.storageDir, { ...defaultLimits(config) });
    this.artifacts = new ArtifactService(db);
    this.insertions = new ProjectInsertionService(db, this.filesPort());
    const latexmk = toolchain.paths.latexmk;
    const kpse = latexmk ? path.join(path.dirname(latexmk), process.platform === 'win32' ? 'kpsewhich.exe' : 'kpsewhich') : null;
    this.compiler = new IsolatedCompiler({ latexmkPath: latexmk, kpsewhichPath: kpse && existsSync(kpse) ? kpse : null, workRoot: config.visual.buildDir, timeoutMs: config.visual.compileTimeoutMs });
    this.concurrency = options.concurrency ?? config.visual.concurrency;
  }

  async start(): Promise<void> {
    await this.assets.init();
    // Tasks cannot survive a restart (the request to the model is gone).
    const ts = new Date().toISOString();
    this.db
      .update(schema.visualTasks)
      .set({ status: 'failed', error: 'The runtime restarted while this task was running; retry it.', updatedAt: ts, finishedAt: ts })
      .where(inArray(schema.visualTasks.status, ['queued', 'running']))
      .run();
    this.db.update(schema.visualArtifactVersions).set({ compilationStatus: 'not-compiled' }).where(eq(schema.visualArtifactVersions.compilationStatus, 'compiling')).run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
    await this.idle();
  }

  /** Resolves when no task or compile is running (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  // ------------------------------------------------------------- assets

  async addUpload(bytes: Uint8Array, input: { fileName: string | null; declaredType: string | null; source: 'upload' | 'clipboard'; projectId: string | null }, actor: Actor) {
    if (input.projectId) this.projects.get(input.projectId);
    const r = await guard(() =>
      this.assets.addOriginal(bytes, { declaredType: input.declaredType, label: input.fileName ?? (input.source === 'clipboard' ? 'Pasted image' : 'Uploaded image'), provenance: { source: input.source, fileName: input.fileName }, projectId: input.projectId }),
    );
    this.audit.record({ action: 'visual.asset.add', outcome: 'success', actor: actor.sessionId, projectId: input.projectId, target: r.original.id, details: { source: input.source, mimeType: r.original.mimeType, size: r.original.fileSize, sanitized: r.removed.length } });
    return { asset: r.original, working: r.working, removed: r.removed };
  }

  async addFromProject(projectId: string, rel: string, actor: Actor) {
    if (!IMAGE_FILE.test(rel)) throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'Choose a PNG, JPEG, WebP or SVG file from the project');
    const file = await this.projects.readRaw(projectId, rel);
    const r = await guard(() => this.assets.addOriginal(file.bytes, { declaredType: null, label: path.posix.basename(file.path), provenance: { source: 'project-file', projectId, path: file.path }, projectId }));
    this.audit.record({ action: 'visual.asset.add', outcome: 'success', actor: actor.sessionId, projectId, target: r.original.id, details: { source: 'project-file', path: file.path } });
    return { asset: r.original, working: r.working, removed: r.removed };
  }

  /** A region of a library PDF page, rendered in the browser; the page and crop are recorded. */
  async addPdfRegion(bytes: Uint8Array, region: { attachmentId: string; pageNumber: number; x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number; renderScale: number }, actor: Actor) {
    const att = this.library.repo.getAttachment(region.attachmentId);
    if (!att) throw new StudioError('NOT_FOUND', 'Library attachment not found');
    if (att.mimeType !== 'application/pdf') throw new StudioError('BAD_REQUEST', 'Regions can only be taken from PDF attachments');
    if (region.x + region.width > region.pageWidth + 1 || region.y + region.height > region.pageHeight + 1) throw new StudioError('VALIDATION_FAILED', 'The region lies outside the page');
    const provenance: VisualProvenance = {
      source: 'pdf-region',
      attachmentId: att.id,
      libraryItemId: att.libraryItemId,
      pdfSha256: att.sha256,
      pageNumber: region.pageNumber,
      region: { x: region.x, y: region.y, width: region.width, height: region.height, pageWidth: region.pageWidth, pageHeight: region.pageHeight },
      renderScale: region.renderScale,
    };
    const r = await guard(() => this.assets.addOriginal(bytes, { declaredType: 'image/png', label: `${att.fileName}, page ${region.pageNumber}`, provenance }));
    if (r.original.mimeType !== 'image/png') throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'PDF regions are sent as PNG');
    this.audit.record({ action: 'visual.asset.add', outcome: 'success', actor: actor.sessionId, target: r.original.id, details: { source: 'pdf-region', attachmentId: att.id, page: region.pageNumber } });
    return { asset: r.original, working: r.working, removed: r.removed };
  }

  async variant(assetId: string, operations: PreprocessOperation[], label: string | undefined, actor: Actor) {
    const v = await guard(() => this.assets.createVariant(assetId, operations, label));
    this.audit.record({ action: 'visual.asset.variant', outcome: 'success', actor: actor.sessionId, target: v.id, details: { parent: assetId, operations: operations.map((o) => o.op) } });
    return v;
  }

  assetDetail(assetId: string) {
    const asset = this.requireAsset(assetId);
    return { asset, lineage: this.assets.lineage(asset.originalAssetId) };
  }

  private requireAsset(id: string) {
    const a = this.assets.get(id);
    if (!a) throw new StudioError('NOT_FOUND', 'Image not found');
    return a;
  }

  // -------------------------------------------------------------- tasks

  /** Every configured provider with what it can do for visual tasks (no network calls). */
  async providerList() {
    const out = [];
    for (const p of await this.providers.list()) {
      const info = PROVIDER_KINDS[p.kind];
      let host: string | null;
      try {
        host = new URL(p.baseUrl ?? info.defaultBaseUrl ?? '').hostname || null;
      } catch {
        host = null;
      }
      const local = p.kind === 'ollama' && host !== null && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
      const problem = !p.enabled ? 'Disabled' : !info.capabilities.vision ? 'This adapter cannot send images' : !info.capabilities.structuredOutput ? 'No structured output' : null;
      out.push({ id: p.id, kind: p.kind, displayName: p.displayName, defaultModel: p.defaultModel, vision: info.capabilities.vision, structuredOutput: info.capabilities.structuredOutput, privacyMode: local ? ('local' as const) : ('cloud' as const), host, usable: problem === null, problem });
    }
    out.sort((a, b) => Number(b.privacyMode === 'local') - Number(a.privacyMode === 'local'));
    return { providers: out, compileAvailable: this.compiler.enabled };
  }

  private async target(providerId: string, model: string, taskType: VisualTaskType, signal?: AbortSignal): Promise<{ provider: ModelProvider; route: Route; kind: string; displayName: string }> {
    const { record, provider } = await this.providers.instantiate(providerId);
    const route = await guard(() => routeTask(taskType, { kind: record.kind, baseUrl: record.baseUrl ?? PROVIDER_KINDS[record.kind].defaultBaseUrl ?? null, provider, model }, signal));
    return { provider, route, kind: record.kind, displayName: record.displayName };
  }

  async checkProvider(providerId: string, model: string, taskType: VisualTaskType) {
    try {
      const { route } = await this.target(providerId, model, taskType);
      return { ok: true, privacyMode: route.privacyMode, needsConsent: route.needsConsent, modelVision: route.modelVision, problem: null, estimatedImageTokens: null };
    } catch (err) {
      const e = toStudioError(err);
      return { ok: false, privacyMode: 'cloud' as const, needsConsent: true, modelVision: null, problem: e instanceof Error ? e.message : String(e), estimatedImageTokens: null };
    }
  }

  private consentError(route: Route, t: { displayName: string; kind: string }, model: string, asset: { fileSize: number; width: number | null; height: number | null } | null): StudioError {
    return new StudioError('CONFLICT', `This task sends ${asset ? 'the image' : 'your text'} to ${t.displayName} (${model}), which runs outside this computer. Confirm to continue.`, {
      reason: 'CONSENT_REQUIRED',
      privacyMode: route.privacyMode,
      provider: t.displayName,
      providerKind: t.kind,
      model,
      imageBytes: asset?.fileSize ?? null,
      imageSize: asset?.width && asset.height ? `${asset.width}×${asset.height}` : null,
      estimatedImageTokens: asset?.width && asset.height ? estimateImageTokens(Math.min(asset.width, 2048), Math.min(asset.height, 2048)) : null,
    });
  }

  async createTask(input: CreateTaskInput, actor: Actor): Promise<VisualTask> {
    const needsImage = IMAGE_TASKS.includes(input.taskType);
    const asset = input.assetId ? this.requireAsset(input.assetId) : null;
    if (needsImage && !asset) throw new StudioError('VALIDATION_FAILED', 'Choose an image for this task');
    if (asset && (asset.kind === 'render' || asset.mimeType === 'application/pdf')) throw new StudioError('BAD_REQUEST', 'Choose an input image, not a rendered preview');
    if (input.taskType === 'text-to-diagram' && !input.text?.trim()) throw new StudioError('VALIDATION_FAILED', 'Describe the diagram');
    if (input.projectId) this.projects.get(input.projectId);
    const t = await this.target(input.providerId, input.model, input.taskType);
    if (t.route.needsConsent && !input.consent) {
      this.audit.record({ action: 'visual.task.consent', outcome: 'denied', actor: actor.sessionId, details: { provider: input.providerId, model: input.model, taskType: input.taskType } });
      throw this.consentError(t.route, t, input.model, needsImage ? asset : null);
    }
    const prov = asset ? (asset.provenance as VisualProvenance) : null;
    const ts = new Date().toISOString();
    const id = newVisualId('vtk');
    this.db
      .insert(schema.visualTasks)
      .values({
        id,
        taskType: input.taskType,
        resolvedType: input.taskType === 'auto' ? null : input.taskType,
        projectId: input.projectId,
        sourceAssetId: asset?.originalAssetId ?? null,
        inputAssetId: needsImage ? (asset?.id ?? null) : null,
        sourceAttachmentId: prov?.source === 'pdf-region' ? prov.attachmentId : null,
        sourcePage: prov?.source === 'pdf-region' ? prov.pageNumber : null,
        providerId: input.providerId,
        providerKind: t.kind,
        model: input.model,
        privacyMode: t.route.privacyMode,
        consentAt: t.route.needsConsent ? ts : null,
        promptVersion: PROMPT_VERSION,
        config: { text: input.text, layout: input.layout ?? 'preserve', imageDetail: input.imageDetail ?? 'auto', modelVision: t.route.modelVision },
        status: 'queued',
        progress: 'Queued',
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    this.audit.record({
      action: 'visual.task.create',
      outcome: 'success',
      actor: actor.sessionId,
      projectId: input.projectId,
      target: id,
      details: { taskType: input.taskType, provider: input.providerId, providerKind: t.kind, model: input.model, privacyMode: t.route.privacyMode, consent: t.route.needsConsent, asset: asset?.id ?? null, imageBytes: needsImage ? (asset?.fileSize ?? null) : null },
    });
    this.enqueue(id);
    return this.task(id);
  }

  private enqueue(id: string): void {
    this.queue.push(id);
    this.publishTask(id);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      this.track(this.run(id)).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private update(id: string, patch: Partial<typeof schema.visualTasks.$inferInsert>): void {
    this.db.update(schema.visualTasks).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.visualTasks.id, id)).run();
    this.publishTask(id);
  }

  private publishTask(id: string): void {
    const row = this.taskRow(id);
    if (row) this.events.publish({ type: 'visual.task', task: taskView(row) });
  }

  private async run(id: string): Promise<void> {
    const row = this.taskRow(id);
    if (!row || row.status !== 'queued') return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const cfg = row.config as { text: string | null; layout: 'preserve' | 'improve' | 'publication' | 'alternative'; imageDetail: 'low' | 'high' | 'auto'; chosenType?: VisualTaskType };
    const type = (cfg.chosenType ?? row.taskType) as VisualTaskType;
    try {
      this.update(id, { status: 'running', progress: 'Preparing the image' });
      const image = row.inputAssetId ? await this.assets.providerImage(row.inputAssetId) : null;
      const { provider } = await this.providers.instantiate(row.providerId!);
      if (controller.signal.aborted) throw new VisualError('cancelled', 'The task was cancelled');
      this.update(id, { progress: `Asking ${row.model}` });
      const result = await runVisualTask({
        task: type,
        provider,
        model: row.model!,
        image: image ? { mimeType: image.mimeType, data: image.data } : null,
        text: cfg.text,
        layout: cfg.layout,
        imageDetail: cfg.imageDetail,
        maxOutputTokens: this.config.ai.maxOutputTokens,
        signal: controller.signal,
      });
      const usage = result.usage ? { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null } : null;
      if (result.status === 'needs_input') {
        this.update(id, { status: 'needs_input', progress: 'Choose what the image shows', choices: result.choices, usage });
        return;
      }
      const { artifact, version } = this.artifacts.create(result.payload, { projectId: row.projectId, sourceAssetId: row.sourceAssetId, taskId: id, origin: 'model', changeDescription: `Reconstructed with ${row.model}` });
      this.update(id, { resolvedType: result.resolvedType, artifactId: artifact.id, artifactVersion: version.versionNumber, usage, progress: 'Compiling the preview' });
      this.events.publish({ type: 'visual.artifact', artifactId: artifact.id, version: versionView(version) });
      if (this.compiler.enabled && version.compilationStatus === 'not-compiled' && artifact.artifactType !== 'explanation') await this.compileVersion(artifact, version, controller.signal);
      const ts = new Date().toISOString();
      this.update(id, { status: 'completed', progress: null, finishedAt: ts });
      this.audit.record({ action: 'visual.task.complete', outcome: 'success', projectId: row.projectId, target: id, details: { artifact: artifact.id, resolvedType: result.resolvedType, usage } });
    } catch (err) {
      const cancelled = controller.signal.aborted || (isVisualError(err) && err.code === 'cancelled');
      const message = err instanceof Error ? err.message : String(err);
      const ts = new Date().toISOString();
      this.update(id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : message.slice(0, 2000), progress: null, finishedAt: ts });
      this.audit.record({ action: 'visual.task.fail', outcome: cancelled ? 'denied' : 'error', projectId: row.projectId, target: id, details: { message: message.slice(0, 500) } });
      if (!cancelled) this.log.info({ task: id, err: message }, 'visual task failed');
    } finally {
      this.controllers.delete(id);
    }
  }

  cancel(id: string, actor: Actor): VisualTask {
    const row = this.requireTask(id);
    if (row.status === 'queued' || row.status === 'needs_input') {
      const i = this.queue.indexOf(id);
      if (i !== -1) this.queue.splice(i, 1);
      const ts = new Date().toISOString();
      this.update(id, { status: 'cancelled', progress: null, finishedAt: ts });
    } else if (row.status === 'running') {
      this.controllers.get(id)?.abort();
    } else throw new StudioError('CONFLICT', 'This task has already finished');
    this.audit.record({ action: 'visual.task.cancel', outcome: 'success', actor: actor.sessionId, target: id });
    return this.task(id);
  }

  /** Answer an ambiguous automatic task with the task type to use. */
  choose(id: string, taskType: VisualTaskType, actor: Actor): VisualTask {
    const row = this.requireTask(id);
    if (row.status !== 'needs_input') throw new StudioError('CONFLICT', 'This task is not waiting for a choice');
    if (taskType === 'auto' || taskType === 'text-to-diagram') throw new StudioError('VALIDATION_FAILED', 'Choose a specific task');
    this.update(id, { status: 'queued', resolvedType: taskType, progress: 'Queued', config: { ...row.config, chosenType: taskType } });
    this.audit.record({ action: 'visual.task.choose', outcome: 'success', actor: actor.sessionId, target: id, details: { taskType } });
    this.enqueue(id);
    return this.task(id);
  }

  /** Run a finished task again as a new task with the same input and settings (consent is asked again). */
  async retry(id: string, consent: boolean, actor: Actor): Promise<VisualTask> {
    const row = this.requireTask(id);
    if (row.status !== 'failed' && row.status !== 'cancelled') throw new StudioError('CONFLICT', 'Only a failed or cancelled task can be retried');
    const cfg = row.config as { text: string | null; layout?: 'preserve' | 'improve' | 'publication' | 'alternative'; imageDetail?: 'low' | 'high' | 'auto' };
    return this.createTask(
      {
        taskType: row.taskType as VisualTaskType,
        assetId: row.inputAssetId,
        text: cfg.text,
        projectId: row.projectId,
        ...(cfg.layout ? { layout: cfg.layout } : {}),
        ...(cfg.imageDetail ? { imageDetail: cfg.imageDetail } : {}),
        providerId: row.providerId!,
        model: row.model!,
        consent,
      },
      actor,
    );
  }

  private taskRow(id: string): TaskRow | null {
    return this.db.select().from(schema.visualTasks).where(eq(schema.visualTasks.id, id)).get() ?? null;
  }

  private requireTask(id: string): TaskRow {
    const row = this.taskRow(id);
    if (!row) throw new StudioError('NOT_FOUND', 'Task not found');
    return row;
  }

  task(id: string): VisualTask {
    return taskView(this.requireTask(id));
  }

  tasks(opts: { projectId?: string | undefined; limit?: number }): VisualTask[] {
    const q = this.db.select().from(schema.visualTasks);
    return (opts.projectId ? q.where(eq(schema.visualTasks.projectId, opts.projectId)) : q)
      .orderBy(desc(schema.visualTasks.createdAt))
      .limit(opts.limit ?? 50)
      .all()
      .map(taskView);
  }

  // ---------------------------------------------------------- artifacts

  artifact(id: string) {
    return guard(() => ({ artifact: this.artifacts.require(id), version: versionView(this.artifacts.current(id)) }));
  }

  artifactList(projectId?: string) {
    const rows = this.artifacts.list(projectId ? { projectId } : {});
    const status = new Map(
      rows.length
        ? this.db
            .select({ artifactId: schema.visualArtifactVersions.artifactId, n: schema.visualArtifactVersions.versionNumber, s: schema.visualArtifactVersions.compilationStatus })
            .from(schema.visualArtifactVersions)
            .where(inArray(schema.visualArtifactVersions.artifactId, rows.map((r) => r.id)))
            .all()
            .map((v) => [`${v.artifactId}:${v.n}`, v.s] as const)
        : [],
    );
    return rows.map((a) => ({ ...a, compilationStatus: status.get(`${a.id}:${a.currentVersion}`) ?? 'not-compiled' }));
  }

  async versions(id: string) {
    return guard(() => {
      this.artifacts.require(id);
      return this.artifacts.versions(id).map(versionView);
    });
  }

  version(id: string, n: number) {
    const v = this.artifacts.version(id, n);
    if (!v) throw new StudioError('NOT_FOUND', `Version ${n} not found`);
    return v;
  }

  private changed(artifactId: string, v: VersionRow) {
    this.events.publish({ type: 'visual.artifact', artifactId, version: versionView(v) });
  }

  /** A hand edit becomes a new version; the structure it came from is kept but marked as edited. */
  async manualEdit(id: string, input: z.infer<typeof ManualEditRequest>, actor: Actor) {
    const a = await guard(() => this.artifacts.require(id));
    const cur = this.artifacts.current(id);
    const dataCsv = input.dataCsv !== undefined ? input.dataCsv : cur.dataCsv;
    const payload = await guard(() => payloadForSource(a.artifactType, input.sourceCode, { structuredData: cur.structuredData, dataCsv, title: a.title }));
    const v = this.artifacts.addVersion(id, payload, 'manual', input.changeDescription);
    this.audit.record({ action: 'visual.artifact.edit', outcome: 'success', actor: actor.sessionId, projectId: a.projectId, target: id, details: { version: v.versionNumber } });
    this.changed(id, v);
    return this.autoCompile(a, v);
  }

  async restore(id: string, n: number, actor: Actor) {
    const v = await guard(() => this.artifacts.restore(id, n));
    const a = this.artifacts.require(id);
    this.audit.record({ action: 'visual.artifact.restore', outcome: 'success', actor: actor.sessionId, projectId: a.projectId, target: id, details: { from: n, version: v.versionNumber } });
    this.changed(id, v);
    // A restored version that compiled before keeps its result; anything else is compiled again.
    return v.compilationStatus === 'succeeded' ? versionView(v) : this.autoCompile(a, v);
  }

  private autoCompile(a: ArtifactRow, v: VersionRow) {
    if (this.compiler.enabled && v.compilationStatus === 'not-compiled' && a.artifactType !== 'explanation') {
      this.artifacts.setCompilation(v.id, { status: 'compiling' });
      this.track(this.compileVersion(a, this.artifacts.versionById(v.id)!));
      return versionView(this.artifacts.versionById(v.id)!);
    }
    return versionView(v);
  }

  async validate(id: string, sourceCode?: string) {
    const a = await guard(() => this.artifacts.require(id));
    const source = sourceCode ?? this.artifacts.current(id).sourceCode;
    const issues = [...checkLatexSafety(source), ...checkStructure(source), ...(a.artifactType === 'equation' ? validateEquation(source, 'custom') : [])];
    const seen = new Set<string>();
    const unique = issues.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
    const packages = a.artifactType === 'explanation' ? [] : standaloneDocument(source, a.artifactType === 'equation' ? 'math' : 'picture', detectPackages(source)).packages;
    return { issues: unique, packages, missingPackages: await this.compiler.missingPackages(packages) };
  }

  /** Compile a version in an isolated workspace; the result and preview are stored on the version. */
  async compile(id: string, n: number | undefined, actor: Actor) {
    const a = await guard(() => this.artifacts.require(id));
    if (a.artifactType === 'explanation') throw new StudioError('BAD_REQUEST', 'A caption has nothing to compile on its own');
    if (!this.compiler.enabled) throw new StudioError('TOOLCHAIN_MISSING', 'No LaTeX toolchain was found (latexmk); generated source cannot be compiled');
    const v = n ? this.version(id, n) : this.artifacts.current(id);
    if (v.compilationStatus === 'compiling') throw new StudioError('CONFLICT', 'This version is already compiling');
    this.artifacts.setCompilation(v.id, { status: 'compiling' });
    this.audit.record({ action: 'visual.artifact.compile', outcome: 'success', actor: actor.sessionId, projectId: a.projectId, target: id, details: { version: v.versionNumber } });
    this.track(this.compileVersion(a, this.artifacts.versionById(v.id)!));
    return versionView(this.artifacts.versionById(v.id)!);
  }

  private async compileVersion(a: ArtifactRow, v: VersionRow, signal?: AbortSignal): Promise<void> {
    try {
      const kind = a.artifactType === 'equation' ? 'math' : 'picture';
      const { document, packages } = standaloneDocument(v.sourceCode, kind, v.packages.filter((p) => p !== 'tikz' || kind === 'picture') as never);
      const files: Record<string, string> = a.artifactType === 'plot' && v.dataCsv ? { [PREVIEW_DATA_FILE]: v.dataCsv } : {};
      const r = await this.compiler.compile({ document, files, packages, ...(signal ? { signal } : {}) });
      let previewAssetId: string | null = null;
      if (r.pdf) previewAssetId = (await this.assets.addRender(r.pdf, 'application/pdf', `Preview of ${a.title}, version ${v.versionNumber}`, a.sourceAssetId)).id;
      const issueDiagnostics = r.issues.map((i) => ({ severity: i.severity, source: 'runtime' as const, message: i.message, file: null, line: null, context: null }));
      this.artifacts.setCompilation(v.id, { status: r.status, diagnostics: [...issueDiagnostics, ...r.diagnostics], log: r.log || null, previewAssetId });
    } catch (err) {
      const cancelled = isVisualError(err) && err.code === 'cancelled';
      this.artifacts.setCompilation(v.id, { status: cancelled ? 'not-compiled' : 'failed', diagnostics: cancelled ? [] : [{ severity: 'error', source: 'runtime', message: err instanceof Error ? err.message : String(err), file: null, line: null, context: null }] });
    }
    this.changed(a.id, this.artifacts.versionById(v.id)!);
  }

  async preview(id: string, n: number) {
    const v = this.version(id, n);
    if (!v.previewAssetId) throw new StudioError('NOT_FOUND', 'This version has no compiled preview');
    return this.assets.read(v.previewAssetId);
  }

  /** A controlled change asked for in words; the result is a new version to review, never an overwrite. */
  async refine(id: string, input: { instruction: string; providerId: string; model: string; consent: boolean }, actor: Actor, signal?: AbortSignal) {
    const a = await guard(() => this.artifacts.require(id));
    const cur = this.artifacts.current(id);
    const t = await this.target(input.providerId, input.model, 'text-to-diagram', signal);
    if (t.route.needsConsent && !input.consent) throw this.consentError(t.route, t, input.model, null);
    try {
      requireConsent(t.route, input.consent);
    } catch (err) {
      throw toStudioError(err);
    }
    const r = await guard(() =>
      refineArtifact({ provider: t.provider, model: input.model, instruction: input.instruction, artifactType: a.artifactType, title: a.title, sourceCode: cur.sourceCode, structuredData: cur.structuredData, dataCsv: cur.dataCsv, ...(signal ? { signal } : {}) }),
    );
    const v = this.artifacts.addVersion(id, r.payload, 'refinement', r.summary || input.instruction.slice(0, 200));
    this.audit.record({
      action: 'visual.artifact.refine',
      outcome: 'success',
      actor: actor.sessionId,
      projectId: a.projectId,
      target: id,
      details: { version: v.versionNumber, provider: input.providerId, model: input.model, privacyMode: t.route.privacyMode, consent: t.route.needsConsent, topologyChanges: r.topologyChanges.length },
    });
    this.changed(id, v);
    return { version: this.autoCompile(a, v), summary: r.summary, changes: r.changes, topologyChanges: r.topologyChanges, ambiguities: r.ambiguities };
  }

  /** Restyle, recalibrate or replace the data of a plot without asking the model again. */
  async updatePlot(id: string, input: z.infer<typeof PlotUpdateRequest>, actor: Actor) {
    const a = await guard(() => this.artifacts.require(id));
    if (a.artifactType !== 'plot') throw new StudioError('BAD_REQUEST', 'Only plots have data and calibration');
    const cur = this.artifacts.current(id);
    const sd = cur.structuredData as { kind?: string; data?: PlotData; style?: PlotStyle; reconstruction?: PlotOutput | null } | null;
    if (!sd?.data) throw new StudioError('CONFLICT', 'This plot has no structured data (its source was replaced by hand)');
    const style: PlotStyle = { ...DEFAULT_PLOT_STYLE, ...sd.style, ...stripUndefined(input.style ?? {}) };
    const mergeAxis = (axis: Axis, patch: typeof input.xAxis): Axis => (patch ? { ...axis, ...stripUndefined(patch) } : axis);
    let payload;
    let origin: 'calibration' | 'manual';
    let description: string;
    if (input.exactCsv !== undefined) {
      const parsed = parseXyCsv(input.exactCsv);
      if (parsed.errors.length) throw new StudioError('VALIDATION_FAILED', parsed.errors[0]!, { errors: parsed.errors.slice(0, 20) });
      if (!parsed.rows.length) throw new StudioError('VALIDATION_FAILED', 'The CSV has no data rows');
      const data: PlotData = { series: [exactSeries(sd.data.series[0]?.name ?? 'Data', parsed.rows)], xAxis: mergeAxis(sd.data.xAxis, input.xAxis), yAxis: mergeAxis(sd.data.yAxis, input.yAxis), warnings: [] };
      payload = buildPlotFromData(data, style, { title: a.title, ...(sd.reconstruction ? { reconstruction: sd.reconstruction } : {}) });
      origin = 'manual';
      description = `Replaced the data with ${parsed.rows.length} exact values`;
    } else if (input.xAxis || input.yAxis) {
      if (!sd.reconstruction) throw new StudioError('CONFLICT', 'Recalibration needs the pixel positions from an image reconstruction');
      const recon: PlotOutput = { ...sd.reconstruction, xAxis: mergeAxis(sd.reconstruction.xAxis, input.xAxis), yAxis: mergeAxis(sd.reconstruction.yAxis, input.yAxis) };
      payload = buildPlot(recon, style);
      payload.title = a.title;
      origin = 'calibration';
      description = 'Recalibrated the axes and digitised again';
    } else {
      payload = buildPlotFromData(sd.data, style, { title: a.title, ...(sd.reconstruction ? { reconstruction: sd.reconstruction } : {}) });
      origin = 'manual';
      description = 'Changed the plot style';
    }
    const v = this.artifacts.addVersion(id, payload, origin, description);
    this.audit.record({ action: 'visual.artifact.plot', outcome: 'success', actor: actor.sessionId, projectId: a.projectId, target: id, details: { version: v.versionNumber, origin } });
    this.changed(id, v);
    return this.autoCompile(a, v);
  }

  async approve(id: string, n: number, actor: Actor) {
    const a = await guard(() => this.artifacts.approve(id, n));
    this.audit.record({ action: 'visual.artifact.approve', outcome: 'success', actor: actor.sessionId, projectId: a.projectId, target: id, details: { version: n } });
    return a;
  }

  compare(id: string, from: number, to: number) {
    const a = this.version(id, from);
    const b = this.version(id, to);
    return { from, to, diff: lineDiff(a.sourceCode, b.sourceCode), structuredChanged: JSON.stringify(a.structuredData) !== JSON.stringify(b.structuredData) };
  }

  exportVersion(id: string, n: number, format: 'tex' | 'standalone' | 'csv' | 'json') {
    const a = this.artifacts.get(id);
    if (!a) throw new StudioError('NOT_FOUND', 'Artifact not found');
    const v = this.version(id, n);
    const stem = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'figure';
    switch (format) {
      case 'tex':
        return { fileName: `${stem}.tex`, contentType: 'application/x-tex', content: `${v.sourceCode}\n` };
      case 'standalone': {
        const kind = a.artifactType === 'equation' ? 'math' : 'picture';
        return { fileName: `${stem}-standalone.tex`, contentType: 'application/x-tex', content: standaloneDocument(v.sourceCode, kind, v.packages as never).document };
      }
      case 'csv': {
        const exportCsv = (v.structuredData as { exportCsv?: string } | null)?.exportCsv ?? v.dataCsv;
        if (!exportCsv) throw new StudioError('NOT_FOUND', 'This version has no data');
        return { fileName: `${stem}-data.csv`, contentType: 'text/csv', content: exportCsv };
      }
      case 'json':
        return { fileName: `${stem}.json`, contentType: 'application/json', content: JSON.stringify({ artifactType: a.artifactType, title: a.title, version: v.versionNumber, origin: v.origin, packages: v.packages, warnings: v.warnings, structuredData: v.structuredData }, null, 2) };
    }
  }

  // ---------------------------------------------------------- insertion

  private filesPort(): InsertionFilesPort {
    const system = { sessionId: null };
    return {
      listFiles: async (projectId) => flatten(await this.projects.tree(projectId)),
      read: async (projectId, rel) => {
        try {
          const f = await this.projects.readFile(projectId, rel);
          return { content: f.content, hash: sha256(f.content) };
        } catch (err) {
          if (err instanceof StudioError && err.code === 'NOT_FOUND') return null;
          throw err;
        }
      },
      write: async (projectId, rel, content, baseHash) => {
        const r = await this.projects.writeFile(projectId, { path: rel, content, baseHash, createOnly: baseHash === null }, system);
        return { hash: r.hash };
      },
      delete: (projectId, rel) => this.projects.deleteEntry(projectId, rel, system),
    };
  }

  private async plan(artifactId: string, input: InsertionInput): Promise<InsertionPlan & { planHash: string }> {
    const project = this.projects.get(input.projectId);
    const a = await guard(() => this.artifacts.require(artifactId));
    const v = this.version(artifactId, input.version);
    const plan = await guard(() =>
      this.insertions.plan(project.id, a, v, { targetFile: input.targetFile, afterLine: input.afterLine, directory: input.directory, label: input.label, caption: input.caption, addPreamble: input.addPreamble, mainFile: project.mainFile }),
    );
    return { ...plan, planHash: sha256(JSON.stringify(plan)) };
  }

  previewInsertion(artifactId: string, input: InsertionInput) {
    return this.plan(artifactId, input);
  }

  /** Apply exactly the reviewed plan; if anything changed since the preview, nothing is written. */
  async insert(artifactId: string, input: z.infer<typeof ApplyInsertionRequest>, actor: Actor) {
    const { planHash, ...opts } = input;
    const plan = await this.plan(artifactId, opts);
    if (plan.planHash !== planHash) throw new StudioError('CONFLICT', 'The project or the artifact changed since the preview; review the changes again', { reason: 'STALE_PREVIEW' });
    const { planHash: _h, ...raw } = plan;
    const done = await guard(() => this.insertions.apply(input.projectId, raw));
    this.audit.record({
      action: 'visual.insert',
      outcome: 'success',
      actor: actor.sessionId,
      projectId: input.projectId,
      target: artifactId,
      details: { insertion: done.id, version: input.version, created: done.createdFiles.map((f) => f.path), modified: done.modifiedFiles.map((f) => f.path), preamble: input.addPreamble && plan.preambleLines.length > 0 },
    });
    return insertionView(done);
  }

  insertionList(projectId: string) {
    this.projects.get(projectId);
    return this.insertions.list(projectId).map(insertionView);
  }

  async rollback(insertionId: string, actor: Actor) {
    const r = await guard(() => this.insertions.rollback(insertionId));
    const ins = this.insertions.get(insertionId)!;
    this.audit.record({ action: 'visual.insert.rollback', outcome: 'success', actor: actor.sessionId, projectId: ins.projectId, target: insertionId, details: r });
    return { insertion: insertionView(ins), ...r };
  }

  /** Artifacts made from one source image (history across tasks). */
  artifactsForAsset(originalAssetId: string) {
    return this.db.select().from(schema.visualArtifacts).where(and(eq(schema.visualArtifacts.sourceAssetId, originalAssetId))).orderBy(desc(schema.visualArtifacts.updatedAt)).all();
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function defaultLimits(config: RuntimeConfig) {
  return { maxBytes: config.visual.maxImageBytes, maxPixels: config.visual.maxImagePixels, maxDimension: 12_000 };
}

export function taskView(row: TaskRow): VisualTask {
  const { config: _config, ...rest } = row;
  return { ...rest, taskType: row.taskType as VisualTaskType, resolvedType: (row.resolvedType ?? null) as VisualTaskType | null, choices: (row.choices ?? null) as VisualTaskType[] | null } as VisualTask;
}

export function versionView(v: VersionRow) {
  return v;
}

function insertionView(i: typeof schema.visualInsertions.$inferSelect) {
  return { ...i, modifiedFiles: i.modifiedFiles.map(({ before: _b, ...m }) => m) };
}
