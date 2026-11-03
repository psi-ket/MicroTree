import { isTerminalJobStatus } from '@research-studio/document-intelligence';
import { ExtractionError, toJobError } from '../errors/extraction-errors';
import type { DocumentStore, JobRow } from '../storage/document-store';
import type { IngestionService } from './ingestion-service';

/** A job that crashed the runtime this many times is not started again. */
export const MAX_ATTEMPTS = 3;

/**
 * Runs one persisted job to a terminal state. Every outcome is written to the
 * job row; errors never escape. A failure leaves any earlier extraction of
 * the attachment untouched.
 */
export async function runIngestionJob(
  jobId: string,
  deps: { store: DocumentStore; service: IngestionService; onUpdate?: (job: JobRow) => void },
  signal: AbortSignal,
): Promise<JobRow | null> {
  const { store } = deps;
  const initial = store.getJob(jobId);
  if (!initial || isTerminalJobStatus(initial.status)) return initial;
  const publish = (job: JobRow) => {
    deps.onUpdate?.(job);
    return job;
  };
  const attempts = initial.attempts + 1;
  if (attempts > MAX_ATTEMPTS) {
    return publish(
      store.setJobError(jobId, 'failed', new ExtractionError('internal', `Processing was interrupted ${initial.attempts} times; it is not started again automatically`).toJobError()),
    );
  }
  let job = store.updateJob(jobId, { attempts, startedAt: initial.startedAt ?? new Date().toISOString(), error: null });
  try {
    const result = await deps.service.run(job, signal, deps.onUpdate);
    job = store.updateJob(jobId, {
      status: result.status,
      progress: 1,
      extractionId: result.extractionId,
      notes: result.notes,
      error: result.embeddingError ? { code: 'embedding-failed', message: result.embeddingError, retryable: true, source: 'embeddings' } : null,
      finishedAt: new Date().toISOString(),
    });
    return publish(job);
  } catch (err) {
    const current = store.getJob(jobId);
    // An unfinished (inactive) extraction written by this run is removed; the active one stays.
    if (current?.extractionId) {
      const x = store.getExtraction(current.extractionId);
      if (x && !x.isActive) store.deleteExtraction(x.id);
    }
    const error = toJobError(err);
    const status = error.code === 'cancelled' || signal.aborted ? 'cancelled' : 'failed';
    return publish(store.setJobError(jobId, status, status === 'cancelled' ? null : error, current?.notes ?? []));
  }
}
