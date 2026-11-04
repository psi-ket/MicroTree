import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { EvidenceJob } from '@research-studio/api-contracts';
import { schema, type StudioDb } from '@research-studio/database';
import { isEvidenceError } from '@research-studio/evidence-engine';
import { StudioError, type EvidenceJobKind, type TokenUsage } from '@research-studio/shared-types';
import type { EventBus } from '../../events';
import { randomId } from '../../security/tokens';
import type { ResolvedModel } from './privacy';

type JobRow = typeof schema.evidenceJobs.$inferSelect;

export interface JobContext {
  signal: AbortSignal;
  progress(done: number, total: number, message?: string | null): void;
  /** Record what left the computer and the tokens used. */
  account(outgoing: { manuscriptChars?: number; sourceChars?: number; passages?: number; requests?: number }, usage: TokenUsage | null): void;
}

export const jobView = (r: JobRow): EvidenceJob => ({ ...r, privacyMode: r.privacyMode ?? null, outgoing: r.outgoing ?? null, usage: r.usage ?? null, result: r.result ?? null });

/**
 * Persistent background jobs for M5. Rows live in `evidence_jobs`; work runs
 * in this process (one job per project at a time, two overall), can be
 * cancelled, and a job that was running when the runtime stopped is marked
 * failed at start so it can be run again.
 */
export class EvidenceJobs {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queue: { id: string; run: (ctx: JobContext) => Promise<Record<string, unknown>> }[] = [];
  private active = 0;

  constructor(
    private readonly db: StudioDb,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly concurrency = 2,
  ) {}

  recover(): void {
    const ts = new Date().toISOString();
    this.db.update(schema.evidenceJobs).set({ status: 'failed', error: 'The runtime restarted while this job was running; run it again.', updatedAt: ts, finishedAt: ts }).where(inArray(schema.evidenceJobs.status, ['queued', 'running'])).run();
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async stop(): Promise<void> {
    for (const c of this.controllers.values()) c.abort();
    this.queue.length = 0;
    await this.idle();
  }

  get(id: string): JobRow {
    const r = this.db.select().from(schema.evidenceJobs).where(eq(schema.evidenceJobs.id, id)).get();
    if (!r) throw new StudioError('NOT_FOUND', 'Job not found');
    return r;
  }

  list(projectId: string, limit = 50): EvidenceJob[] {
    return this.db.select().from(schema.evidenceJobs).where(eq(schema.evidenceJobs.projectId, projectId)).orderBy(desc(schema.evidenceJobs.createdAt)).limit(limit).all().map(jobView);
  }

  private publish(id: string) {
    this.events.publish({ type: 'evidence.job', job: jobView(this.get(id)) });
  }

  private patch(id: string, p: Partial<typeof schema.evidenceJobs.$inferInsert>) {
    this.db.update(schema.evidenceJobs).set({ ...p, updatedAt: new Date().toISOString() }).where(eq(schema.evidenceJobs.id, id)).run();
    this.publish(id);
  }

  start(projectId: string, kind: EvidenceJobKind, input: Record<string, unknown>, model: ResolvedModel | null, run: (ctx: JobContext) => Promise<Record<string, unknown>>): EvidenceJob {
    const id = `ejb_${randomId(10)}`;
    const ts = new Date().toISOString();
    this.db
      .insert(schema.evidenceJobs)
      .values({
        id,
        projectId,
        kind,
        status: 'queued',
        input,
        progress: { done: 0, total: 0, message: 'Waiting' },
        providerId: model?.providerId ?? null,
        providerKind: model?.providerKind ?? null,
        modelId: model?.model ?? null,
        privacyMode: model?.privacyMode ?? null,
        consentAt: model?.consentAt ?? null,
        outgoing: model ? { manuscriptChars: 0, sourceChars: 0, passages: 0, requests: 0 } : null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    this.queue.push({ id, run });
    this.publish(id);
    this.pump();
    return jobView(this.get(id));
  }

  cancel(projectId: string, id: string): EvidenceJob {
    const job = this.get(id);
    if (job.projectId !== projectId) throw new StudioError('NOT_FOUND', 'Job not found');
    if (job.status === 'queued') {
      const i = this.queue.findIndex((q) => q.id === id);
      if (i !== -1) this.queue.splice(i, 1);
      const ts = new Date().toISOString();
      this.patch(id, { status: 'cancelled', finishedAt: ts });
    } else if (job.status === 'running') this.controllers.get(id)?.abort();
    else throw new StudioError('CONFLICT', 'This job has already finished');
    return jobView(this.get(id));
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const next = this.queue.shift()!;
      this.active++;
      const p = this.execute(next.id, next.run).finally(() => {
        this.active--;
        this.pending.delete(p);
        this.pump();
      });
      this.pending.add(p);
    }
  }

  private async execute(id: string, run: (ctx: JobContext) => Promise<Record<string, unknown>>) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let outgoing = this.get(id).outgoing ?? null;
    let usage: Record<string, number | null> | null = null;
    const ctx: JobContext = {
      signal: controller.signal,
      progress: (done, total, message = null) => this.patch(id, { progress: { done, total, message } }),
      account: (o, u) => {
        if (outgoing) outgoing = { manuscriptChars: outgoing.manuscriptChars + (o.manuscriptChars ?? 0), sourceChars: outgoing.sourceChars + (o.sourceChars ?? 0), passages: outgoing.passages + (o.passages ?? 0), requests: outgoing.requests + (o.requests ?? 0) };
        if (u) usage = { inputTokens: (usage?.inputTokens ?? 0) + (u.inputTokens ?? 0), outputTokens: (usage?.outputTokens ?? 0) + (u.outputTokens ?? 0), costUsd: u.costUsd !== null ? (usage?.costUsd ?? 0) + u.costUsd : (usage?.costUsd ?? null) };
        this.db.update(schema.evidenceJobs).set({ outgoing, usage }).where(eq(schema.evidenceJobs.id, id)).run();
      },
    };
    try {
      this.patch(id, { status: 'running' });
      const result = await run(ctx);
      const ts = new Date().toISOString();
      this.patch(id, { status: controller.signal.aborted ? 'cancelled' : 'completed', result, finishedAt: ts });
    } catch (err) {
      const cancelled = controller.signal.aborted || (isEvidenceError(err) && err.code === 'cancelled');
      const ts = new Date().toISOString();
      this.patch(id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : (err instanceof Error ? err.message : String(err)).slice(0, 2000), finishedAt: ts });
      if (!cancelled) this.log.info({ job: id, err: err instanceof Error ? err.message : String(err) }, 'evidence job failed');
    } finally {
      this.controllers.delete(id);
    }
  }

  running(projectId: string, kind: EvidenceJobKind, key: string): JobRow | null {
    return (
      this.db
        .select()
        .from(schema.evidenceJobs)
        .where(and(eq(schema.evidenceJobs.projectId, projectId), eq(schema.evidenceJobs.kind, kind), inArray(schema.evidenceJobs.status, ['queued', 'running'])))
        .all()
        .find((j) => (j.input as { key?: string }).key === key) ?? null
    );
  }
}
