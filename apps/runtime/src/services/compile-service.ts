import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '@research-studio/database';
import {
  buildArtifacts,
  compileProject,
  synctexForward,
  synctexInverse,
  type Toolchain,
} from '@research-studio/latex-engine';
import {
  isStudioError,
  StudioError,
  type CompileJob,
  type CompileStatus,
  type Diagnostic,
  type PdfRect,
  type SourceLocation,
} from '@research-studio/shared-types';
import type { RuntimeConfig } from '../config';
import type { EventBus } from '../events';
import { randomId } from '../security/tokens';
import type { AuditService } from './audit-service';
import type { Actor, ProjectService } from './project-service';

const OUTPUT_TAIL_BYTES = 64 * 1024;
const OUTPUT_FLUSH_MS = 150;

interface ActiveJob {
  jobId: string;
  controller: AbortController;
}

/**
 * Asynchronous compile queue. At most one job runs per project and at most
 * `maxConcurrentCompiles` overall; repeated requests while a job is queued
 * coalesce into that job.
 */
export class CompileService {
  private readonly running = new Map<string, ActiveJob>();
  private readonly queued = new Map<string, string>(); // projectId -> jobId
  private readonly order: string[] = []; // FIFO of projectIds with a queued job
  private readonly idleWaiters = new Set<() => void>();
  private shuttingDown = false;

  constructor(
    private readonly repos: Repositories,
    private readonly projects: ProjectService,
    private readonly toolchain: Toolchain,
    private readonly config: RuntimeConfig,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async request(projectId: string, actor: Actor): Promise<CompileJob> {
    if (!this.toolchain.paths.latexmk) {
      throw new StudioError(
        'TOOLCHAIN_MISSING',
        'latexmk was not found. Install a TeX distribution (TeX Live or MiKTeX) or set RS_LATEXMK_PATH.',
      );
    }
    if (this.shuttingDown) throw new StudioError('INTERNAL', 'The runtime is shutting down');
    const { project } = await this.projects.open(projectId);

    const existing = this.queued.get(projectId);
    if (existing) {
      const job = this.repos.jobs.get(existing);
      if (job) return job;
    }

    const job = this.repos.jobs.create({
      id: randomId(),
      projectId,
      engine: project.engine,
      mainFile: project.mainFile,
    });
    this.queued.set(projectId, job.id);
    this.order.push(projectId);
    this.audit.record({ action: 'compile.request', outcome: 'success', actor: actor.sessionId, projectId, target: job.id });
    this.events.publish({ type: 'compile.queued', job });
    queueMicrotask(() => this.pump());
    return job;
  }

  cancel(projectId: string, actor: Actor): CompileJob | null {
    const queuedId = this.queued.get(projectId);
    if (queuedId) {
      this.queued.delete(projectId);
      this.order.splice(this.order.indexOf(projectId), 1);
      const job = this.repos.jobs.update(queuedId, {
        status: 'cancelled',
        statusMessage: 'Cancelled before it started',
        finishedAt: new Date().toISOString(),
      });
      if (job) this.events.publish({ type: 'compile.finished', job });
    }
    const active = this.running.get(projectId);
    if (active) active.controller.abort();
    this.audit.record({ action: 'compile.cancel', outcome: 'success', actor: actor.sessionId, projectId });
    const id = active?.jobId ?? queuedId;
    return id ? this.repos.jobs.get(id) : null;
  }

  listJobs(projectId: string): CompileJob[] {
    this.projects.get(projectId);
    return this.repos.jobs.listByProject(projectId, 20);
  }

  getJob(projectId: string, jobId: string): { job: CompileJob; output: string | null } {
    const job = this.repos.jobs.get(jobId);
    if (!job || job.projectId !== projectId) throw new StudioError('NOT_FOUND', 'Compile job not found');
    return { job, output: this.repos.jobs.outputTail(jobId) };
  }

  async pdfPath(projectId: string): Promise<string> {
    const { project, fs } = await this.projects.open(projectId);
    const { pdfPath } = buildArtifacts(fs.root, project.mainFile);
    try {
      if ((await stat(pdfPath)).isFile()) return pdfPath;
    } catch {
      /* fall through */
    }
    throw new StudioError('NOT_FOUND', 'No PDF has been produced yet. Compile the project first.');
  }

  async forward(projectId: string, input: { file: string; line: number; column: number }): Promise<PdfRect[]> {
    const { project, fs } = await this.projects.open(projectId);
    return synctexForward({ ...input, synctexPath: this.requireSynctex(), projectRoot: fs.root, mainFile: project.mainFile });
  }

  async inverse(projectId: string, input: { page: number; x: number; y: number }): Promise<SourceLocation | null> {
    const { project, fs } = await this.projects.open(projectId);
    return synctexInverse({ ...input, synctexPath: this.requireSynctex(), projectRoot: fs.root, mainFile: project.mainFile });
  }

  /** Resolves when no job is queued or running (used by tests and shutdown). */
  whenIdle(): Promise<void> {
    if (this.running.size === 0 && this.queued.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const projectId of [...this.queued.keys()]) this.cancel(projectId, { sessionId: null });
    for (const active of this.running.values()) active.controller.abort();
    await this.whenIdle();
  }

  private requireSynctex(): string {
    if (!this.toolchain.paths.synctex) {
      throw new StudioError('TOOLCHAIN_MISSING', 'The synctex command was not found on this machine');
    }
    return this.toolchain.paths.synctex;
  }

  private pump(): void {
    while (this.running.size < this.config.maxConcurrentCompiles) {
      const index = this.order.findIndex((projectId) => !this.running.has(projectId));
      if (index === -1) break;
      const projectId = this.order.splice(index, 1)[0]!;
      const jobId = this.queued.get(projectId);
      this.queued.delete(projectId);
      if (!jobId) continue;
      const active: ActiveJob = { jobId, controller: new AbortController() };
      this.running.set(projectId, active);
      void this.run(projectId, active).finally(() => {
        this.running.delete(projectId);
        if (this.running.size === 0 && this.queued.size === 0) {
          this.idleWaiters.forEach((resolve) => resolve());
          this.idleWaiters.clear();
        }
        this.pump();
      });
    }
  }

  private async run(projectId: string, active: ActiveJob): Promise<void> {
    const startedAt = new Date();
    const started = this.repos.jobs.update(active.jobId, { status: 'running', startedAt: startedAt.toISOString() });
    if (!started) return;
    this.events.publish({ type: 'compile.started', job: started });

    let buffer = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (!buffer) return;
      this.events.publish({ type: 'compile.output', projectId, jobId: active.jobId, chunk: buffer });
      buffer = '';
    };

    let status: CompileStatus;
    let statusMessage: string | null = null;
    let diagnostics: Diagnostic[];
    let exitCode: number | null = null;
    let pdfAvailable = false;
    let output = '';
    try {
      const { project, fs } = await this.projects.open(projectId);
      const outcome = await compileProject({
        latexmkPath: this.toolchain.paths.latexmk!,
        projectRoot: fs.root,
        mainFile: started.mainFile,
        engine: project.engine,
        timeoutMs: this.config.compileTimeoutMs,
        signal: active.controller.signal,
        onOutput: (chunk) => {
          buffer += chunk;
          timer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
        },
      });
      diagnostics = outcome.diagnostics;
      exitCode = outcome.exitCode;
      pdfAvailable = outcome.pdfAvailable;
      output = outcome.output;
      const hasErrors = diagnostics.some((d) => d.severity === 'error');
      if (outcome.cancelled) {
        status = 'cancelled';
        statusMessage = 'Cancelled by the user';
      } else if (outcome.timedOut) {
        status = 'error';
        statusMessage = 'Compilation timed out';
      } else if (outcome.exitCode === 0 && !hasErrors && outcome.pdfAvailable) {
        status = 'succeeded';
      } else {
        status = 'failed';
        statusMessage = hasErrors ? null : `latexmk exited with code ${outcome.exitCode ?? 'unknown'}`;
      }
    } catch (err) {
      status = 'error';
      statusMessage = isStudioError(err) ? err.message : 'The compiler could not be started';
      if (!isStudioError(err)) this.log.error({ err, projectId }, 'compile failed to run');
      diagnostics = [{ severity: 'error', source: 'runtime', message: statusMessage, file: null, line: null, context: null }];
    } finally {
      if (timer) clearTimeout(timer);
      flush();
    }

    const finishedAt = new Date();
    const job = this.repos.jobs.update(active.jobId, {
      status,
      statusMessage,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      pdfAvailable,
      diagnostics,
      errorCount: diagnostics.filter((d) => d.severity === 'error').length,
      warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
      outputTail: output.length > OUTPUT_TAIL_BYTES ? output.slice(-OUTPUT_TAIL_BYTES) : output,
    });
    this.audit.record({
      action: 'compile.finish',
      outcome: status === 'error' ? 'error' : 'success',
      projectId,
      target: active.jobId,
      details: { status, exitCode, durationMs: job?.durationMs ?? null },
    });
    if (job) this.events.publish({ type: 'compile.finished', job });
  }
}
