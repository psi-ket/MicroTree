import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { RuntimeApiError, type EvidenceJob, type ServerEvent } from '@research-studio/api-contracts';
import type { EvidenceModelTask } from '@research-studio/shared-types';
import { runtime } from '../../lib/connection';
import { queryClient } from '../../lib/queries';

export const evidenceKeys = {
  all: ['evidence'] as const,
  claims: (projectId: string) => ['evidence', 'claims', projectId] as const,
  claim: (claimId: string) => ['evidence', 'claim', claimId] as const,
  coverage: (projectId: string) => ['evidence', 'coverage', projectId] as const,
  markers: (projectId: string) => ['evidence', 'markers', projectId] as const,
  settings: (projectId: string) => ['evidence', 'settings', projectId] as const,
  review: (projectId: string) => ['evidence', 'review', projectId] as const,
  jobs: (projectId: string) => ['evidence', 'jobs', projectId] as const,
};

export const useClaims = (projectId: string) => useQuery({ queryKey: evidenceKeys.claims(projectId), queryFn: () => runtime().evidence.claims(projectId) });
export const useClaim = (claimId: string | null) => useQuery({ queryKey: evidenceKeys.claim(claimId ?? ''), queryFn: () => runtime().evidence.claim(claimId!), enabled: !!claimId });
export const useCoverage = (projectId: string) => useQuery({ queryKey: evidenceKeys.coverage(projectId), queryFn: () => runtime().evidence.coverage(projectId) });
export const useMarkers = (projectId: string, enabled: boolean) => useQuery({ queryKey: evidenceKeys.markers(projectId), queryFn: () => runtime().evidence.markers(projectId), enabled, staleTime: 10_000 });
export const useEvidenceSettings = (projectId: string) => useQuery({ queryKey: evidenceKeys.settings(projectId), queryFn: async () => (await runtime().evidence.settings(projectId)).settings });
export const useLatestReview = (projectId: string) => useQuery({ queryKey: evidenceKeys.review(projectId), queryFn: () => runtime().evidence.latestReview(projectId) });

/** Runtime events: a job changed, or claims changed (new evidence, anchors after an edit). */
export function onEvidenceEvent(e: Extract<ServerEvent, { type: 'evidence.job' | 'evidence.claims' }>): void {
  if (e.type === 'evidence.job') {
    useEvidenceJobs.getState().upsert(e.job);
    if (e.job.status === 'completed' || e.job.status === 'failed') {
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.claims(e.job.projectId) });
      void queryClient.invalidateQueries({ queryKey: ['evidence', 'claim'] });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.coverage(e.job.projectId) });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.review(e.job.projectId) });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.markers(e.job.projectId) });
    }
    return;
  }
  void queryClient.invalidateQueries({ queryKey: evidenceKeys.claims(e.projectId) });
  void queryClient.invalidateQueries({ queryKey: evidenceKeys.coverage(e.projectId) });
  void queryClient.invalidateQueries({ queryKey: evidenceKeys.markers(e.projectId) });
  for (const id of e.claimIds) void queryClient.invalidateQueries({ queryKey: evidenceKeys.claim(id) });
}

interface JobsState {
  jobs: Record<string, EvidenceJob>;
  upsert(job: EvidenceJob): void;
}

export const useEvidenceJobs = create<JobsState>((set) => ({
  jobs: {},
  upsert: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
}));

/** The latest state of a job (events, with polling as the fallback). */
export function useJob(jobId: string | null) {
  const fromEvents = useEvidenceJobs((s) => (jobId ? s.jobs[jobId] : undefined));
  const polled = useQuery({
    queryKey: ['evidence', 'job', jobId],
    queryFn: async () => (await runtime().evidence.job(jobId!)).job,
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && !['completed', 'failed', 'cancelled'].includes(q.state.data.status) ? 1500 : false),
  });
  const a = fromEvents;
  const b = polled.data;
  if (!a) return b ?? null;
  if (!b) return a;
  return a.updatedAt >= b.updatedAt ? a : b;
}

/** What a cloud operation would send, from the runtime's refusal. */
export interface EvidenceConsent {
  message: string;
  provider: string;
  model: string;
  task: string;
  outgoing: { manuscriptChars: number; sourceChars: number; passages: number; requests: number; preview: { claims: string[]; passages: { title: string; excerpt: string }[] } };
}

export function consentFrom(err: unknown): EvidenceConsent | null {
  if (!(err instanceof RuntimeApiError) || err.status !== 409) return null;
  const d = err.details as Partial<EvidenceConsent> & { reason?: string } | undefined;
  if (d?.reason !== 'CONSENT_REQUIRED' || !d.outgoing) return null;
  return { message: err.message, provider: d.provider ?? 'the provider', model: d.model ?? '', task: d.task ?? '', outgoing: d.outgoing };
}

/** A refusal because of the project's privacy settings (local only, confidential, provider not allowed). */
export function privacyRefusal(err: unknown): string | null {
  if (!(err instanceof RuntimeApiError)) return null;
  const reason = (err.details as { reason?: string } | undefined)?.reason;
  return reason === 'LOCAL_ONLY' || reason === 'CONFIDENTIAL_PROJECT' || reason === 'PROVIDER_NOT_ALLOWED' ? err.message : null;
}

interface ConsentState {
  pending: { request: EvidenceConsent; proceed: () => Promise<void> } | null;
  ask(request: EvidenceConsent, proceed: () => Promise<void>): void;
  clear(): void;
}

export const useEvidenceConsent = create<ConsentState>((set) => ({
  pending: null,
  ask: (request, proceed) => set({ pending: { request, proceed } }),
  clear: () => set({ pending: null }),
}));

/**
 * Run an operation that may need cloud consent: on a CONSENT_REQUIRED
 * refusal the consent dialog shows what would leave the computer, and the
 * operation runs again with consent only if the user confirms.
 */
export async function withConsent(run: (consent: boolean) => Promise<void>, onError: (err: unknown) => void): Promise<void> {
  try {
    await run(false);
  } catch (err) {
    const request = consentFrom(err);
    if (request) useEvidenceConsent.getState().ask(request, () => run(true).catch(onError));
    else onError(err);
  }
}

/** The model chosen for a task in the project's settings, or the user's last choice. */
export function useModelFor(projectId: string, task: EvidenceModelTask): { providerId: string; model: string } | null {
  const settings = useEvidenceSettings(projectId).data;
  return settings?.models[task] ?? settings?.models.assessment ?? null;
}

interface SelectionRequest {
  /** Incremented to ask the evidence panel to analyse the editor's selection. */
  nonce: number;
  request(): void;
}

export const useEvidenceRequest = create<SelectionRequest>((set, get) => ({ nonce: 0, request: () => set({ nonce: get().nonce + 1 }) }));
