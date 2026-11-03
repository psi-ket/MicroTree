import { toast } from 'sonner';
import type { ImportJob } from '@research-studio/shared-types';
import { invalidateLibrary, keys, queryClient } from '../../lib/queries';
import { FINAL_JOB, JOB_KIND_LABEL, jobSummary } from './model';

/**
 * Keep the job list current from runtime events (and from the responses that
 * start jobs). A job seen running that has now ended refreshes the library and
 * says how it went.
 */
export function upsertLibraryJob(job: ImportJob): void {
  const list = queryClient.getQueryData<ImportJob[]>(keys.library.jobs);
  const before = list?.find((j) => j.id === job.id) ?? null;
  queryClient.setQueryData<ImportJob[]>(keys.library.jobs, (current = []) =>
    [job, ...current.filter((j) => j.id !== job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  if (before && !FINAL_JOB.has(before.status) && FINAL_JOB.has(job.status)) {
    invalidateLibrary();
    const title = `${JOB_KIND_LABEL[job.kind]} ${job.status === 'completed' ? 'finished' : job.status}`;
    if (job.status === 'completed') toast.success(title, { description: jobSummary(job) });
    else if (job.status === 'cancelled') toast.info(title, { description: jobSummary(job) });
    else toast.error(title, { description: jobSummary(job) });
  }
}
