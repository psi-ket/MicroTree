import { create } from 'zustand';
import { TERMINAL_COMPILE_STATUSES, type CompileJob, type CompileStatus } from '@research-studio/shared-types';

const MAX_LIVE_OUTPUT = 256 * 1024;

interface CompileState {
  /** Latest job per project (queued, running or finished). */
  jobs: Record<string, CompileJob>;
  /** Console output of the job currently streaming, per project. */
  output: Record<string, string>;
  /** Job id of the most recent job that produced a PDF, per project (drives PDF reloads). */
  pdfJob: Record<string, string>;
  upsert(job: CompileJob): void;
  append(projectId: string, jobId: string, chunk: string): void;
  setOutput(projectId: string, output: string): void;
}

/** Lifecycle order; HTTP responses and WebSocket events can arrive out of order. */
const STAGE: Record<CompileStatus, number> = { queued: 0, running: 1, succeeded: 2, failed: 2, cancelled: 2, error: 2 };

export const isActive = (job: CompileJob | undefined) => !!job && !TERMINAL_COMPILE_STATUSES.includes(job.status);

export const useCompile = create<CompileState>((set) => ({
  jobs: {},
  output: {},
  pdfJob: {},
  upsert: (job) =>
    set((s) => {
      const current = s.jobs[job.projectId];
      // Ignore stale updates for older jobs.
      if (current && current.id !== job.id && current.createdAt > job.createdAt) return s;
      // Never move the same job backwards (e.g. a late `queued` response after `compile.started`).
      if (current?.id === job.id && STAGE[job.status] < STAGE[current.status]) return s;
      const startingNew = job.status === 'running' && current?.id !== job.id;
      return {
        jobs: { ...s.jobs, [job.projectId]: job },
        output: startingNew || (job.status === 'running' && current?.status !== 'running')
          ? { ...s.output, [job.projectId]: '' }
          : s.output,
        pdfJob:
          TERMINAL_COMPILE_STATUSES.includes(job.status) && job.pdfAvailable
            ? { ...s.pdfJob, [job.projectId]: job.id }
            : s.pdfJob,
      };
    }),
  append: (projectId, jobId, chunk) =>
    set((s) => {
      if (s.jobs[projectId] && s.jobs[projectId].id !== jobId) return s;
      const next = (s.output[projectId] ?? '') + chunk;
      return { output: { ...s.output, [projectId]: next.length > MAX_LIVE_OUTPUT ? next.slice(-MAX_LIVE_OUTPUT) : next } };
    }),
  setOutput: (projectId, output) => set((s) => ({ output: { ...s.output, [projectId]: output } })),
}));
