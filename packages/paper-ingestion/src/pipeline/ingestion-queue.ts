import { isTerminalJobStatus, type DocumentJobKind } from '@research-studio/document-intelligence';
import { ExtractionError } from '../errors/extraction-errors';
import type { DocumentStore, JobRow } from '../storage/document-store';
import type { IngestionService } from './ingestion-service';
import { runIngestionJob } from './ingestion-worker';

export interface IngestionQueueOptions {
  store: DocumentStore;
  service: IngestionService;
  concurrency: number;
  /** Current configuration hash; a job is unique per (attachment, configuration). */
  configHash: () => string;
  onUpdate?: (job: JobRow) => void;
}

/**
 * Persistent, bounded job queue. Jobs live in `document_jobs`; this class
 * only decides which run now. At most `concurrency` run at once; a second
 * request for an attachment with an unfinished job returns that job; unfinished
 * jobs are resumed by `resume()` after a restart.
 */
export class IngestionQueue {
  private readonly pending: string[] = [];
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopped = false;

  constructor(private readonly options: IngestionQueueOptions) {}

  get active(): number {
    return this.running.size;
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** Queue processing of an attachment (or return the job already doing it). */
  request(attachmentId: string, kind: DocumentJobKind = 'process'): { job: JobRow; created: boolean } {
    const { store } = this.options;
    const attachment = store.attachmentInfo(attachmentId);
    if (!attachment) throw new ExtractionError('missing-file', 'The attachment does not exist', 'library', false);
    if (attachment.attachmentType !== 'pdf') throw new ExtractionError('unsupported', 'Only PDF attachments can be processed', 'library', false);
    const configHash = this.options.configHash();
    const existing = store.unfinishedJob(attachmentId, configHash) ?? store.unfinishedJob(attachmentId);
    if (existing) return { job: existing, created: false };
    const previous = store.latestJob(attachmentId);
    const job = store.createJob({
      kind,
      attachment,
      configHash,
      previousExtractionId: store.activeExtraction(attachmentId)?.id ?? null,
      retryCount: previous?.status === 'failed' ? previous.retryCount + 1 : 0,
    });
    this.options.onUpdate?.(job);
    this.enqueue(job.id);
    return { job, created: true };
  }

  /** Re-queue jobs that were unfinished when the runtime stopped, and drop half-written extractions. */
  resume(): number {
    const { store } = this.options;
    const jobs = store.unfinishedJobs();
    for (const job of jobs) {
      if (job.extractionId) {
        const x = store.getExtraction(job.extractionId);
        if (x && !x.isActive) store.deleteExtraction(x.id);
      }
      store.updateJob(job.id, { status: 'queued', progress: null, extractionId: null });
      this.enqueue(job.id);
    }
    return jobs.length;
  }

  cancel(jobId: string): JobRow | null {
    const { store } = this.options;
    const job = store.getJob(jobId);
    if (!job || isTerminalJobStatus(job.status)) return job;
    const i = this.pending.indexOf(jobId);
    if (i !== -1) {
      this.pending.splice(i, 1);
      const cancelled = store.setJobError(jobId, 'cancelled', null);
      this.options.onUpdate?.(cancelled);
      return cancelled;
    }
    this.running.get(jobId)?.controller.abort();
    return store.getJob(jobId);
  }

  /** Wait until a job has finished (tests, shutdown). */
  async wait(jobId: string): Promise<JobRow | null> {
    for (;;) {
      const r = this.running.get(jobId);
      if (r) await r.done;
      else if (!this.pending.includes(jobId)) return this.options.store.getJob(jobId);
      else await new Promise((res) => setTimeout(res, 10));
    }
  }

  async idle(): Promise<void> {
    while (this.running.size || this.pending.length) {
      await Promise.all([...this.running.values()].map((r) => r.done));
      if (!this.running.size && this.pending.length) await new Promise((res) => setTimeout(res, 5));
    }
  }

  /** Stop taking work and abort what runs; aborted jobs are resumed at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    const running = [...this.running.values()];
    // Mark the abort as a shutdown: the jobs must stay unfinished so they resume.
    for (const r of running) (r.controller as AbortController & { shutdown?: boolean }).shutdown = true;
    for (const r of running) r.controller.abort();
    await Promise.all(running.map((r) => r.done));
  }

  private enqueue(jobId: string): void {
    if (this.stopped || this.pending.includes(jobId) || this.running.has(jobId)) return;
    this.pending.push(jobId);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.running.size < this.options.concurrency && this.pending.length) {
      const jobId = this.pending.shift()!;
      const controller = new AbortController();
      const done = (async () => {
        const { store } = this.options;
        const before = store.getJob(jobId);
        const result = await runIngestionJob(jobId, { store, service: this.options.service, onUpdate: this.options.onUpdate }, controller.signal);
        if ((controller as AbortController & { shutdown?: boolean }).shutdown && result?.status === 'cancelled') {
          // Shutdown, not a user cancel: leave it queued for the next start (attempts already counted).
          store.updateJob(jobId, { status: 'queued', progress: null, finishedAt: null, error: null, notes: before?.notes ?? [] });
        }
      })()
        .catch(() => {})
        .finally(() => {
          this.running.delete(jobId);
          this.pump();
        });
      this.running.set(jobId, { controller, done });
    }
  }
}
