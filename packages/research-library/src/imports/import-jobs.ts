import type { ImportItemResult, ImportJob, ImportJobKind } from '@research-studio/shared-types';
import { LibraryCancelledError, notFound } from '../errors/library-errors';
import { toJob, type LibraryRepository } from '../library/library-repository';
import { newLibraryId } from '../library/library-service';

export interface JobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  record(result: ImportItemResult): void;
  warn(message: string): void;
  setTotal(total: number): void;
}

const MAX_RUNNING = 2;

/**
 * Runs imports in the background, one item at a time, persisting progress
 * after each item so the browser can follow it and a restart can tell what
 * was done. Jobs can be cancelled; items already imported stay imported.
 */
export class ImportJobRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly finished = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: LibraryRepository,
    private readonly onUpdate: (job: ImportJob) => void = () => {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Mark jobs a previous process left unfinished. Call once at startup. */
  recoverInterrupted(): number {
    return this.repo.markInterruptedJobs(this.now());
  }

  get(id: string): ImportJob {
    const row = this.repo.getJob(id);
    if (!row) throw notFound('Import', id);
    return toJob(row);
  }

  recent(limit = 20): ImportJob[] {
    return this.repo.recentJobs(limit).map(toJob);
  }

  /** Start a job; resolves immediately with the queued job. */
  start(kind: ImportJobKind, total: number, run: (ctx: JobContext) => Promise<void>, warnings: string[] = []): ImportJob {
    const id = newLibraryId('job');
    this.repo.insertJob({ id, kind, status: 'queued', total, processed: 0, items: [], warnings, createdAt: this.now() });
    this.repo.pruneJobs();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const done = new Promise<void>((resolve) => {
      const go = () => void this.execute(id, controller, run).finally(resolve);
      if (this.running < MAX_RUNNING) go();
      else this.queue.push(go);
    });
    this.finished.set(id, done);
    const job = this.get(id);
    this.onUpdate(job);
    return job;
  }

  /** Resolves when the job has ended (tests and shutdown). */
  async wait(id: string): Promise<ImportJob> {
    await this.finished.get(id);
    return this.get(id);
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Cancel everything (runtime shutdown). */
  async stopAll(): Promise<void> {
    for (const c of this.controllers.values()) c.abort();
    await Promise.all(this.finished.values());
  }

  private async execute(id: string, controller: AbortController, run: (ctx: JobContext) => Promise<void>): Promise<void> {
    this.running++;
    const items: ImportItemResult[] = [];
    const warnings = [...(this.repo.getJob(id)?.warnings ?? [])];
    let total = this.repo.getJob(id)?.total ?? 0;
    const publish = () => this.onUpdate(this.get(id));
    try {
      if (controller.signal.aborted) throw new LibraryCancelledError();
      this.repo.updateJob(id, { status: 'running' });
      publish();
      await run({
        jobId: id,
        signal: controller.signal,
        record: (result) => {
          items.push(result);
          this.repo.updateJob(id, { items, processed: items.length, total: Math.max(total, items.length) });
          publish();
        },
        warn: (message) => {
          warnings.push(message);
          this.repo.updateJob(id, { warnings });
        },
        setTotal: (n) => {
          total = n;
          this.repo.updateJob(id, { total: n });
        },
      });
      this.repo.updateJob(id, { status: controller.signal.aborted ? 'cancelled' : 'completed', finishedAt: this.now() });
    } catch (err) {
      const cancelled = controller.signal.aborted || err instanceof LibraryCancelledError;
      this.repo.updateJob(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : err instanceof Error ? err.message : String(err),
        finishedAt: this.now(),
      });
    } finally {
      this.running--;
      this.controllers.delete(id);
      publish();
      this.queue.shift()?.();
    }
  }
}
