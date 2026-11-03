import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_STAGING_LIMITS, removeStagingDir, type StagingLimits } from '@research-studio/agent-adapters';
import type { AiRepositories } from '@research-studio/ai-storage';
import { areDisjoint } from '@research-studio/document-engine/node';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeConfig } from '../../config';
import type { AuditService } from '../audit-service';

export type StagingCleanupReason = 'startup' | 'scheduled' | 'run-finished' | 'conversation-deleted';

export interface StagingSweepResult {
  removed: string[];
  orphans: string[];
  failed: string[];
  bytes: number;
}

/**
 * Lifecycle of agent staging copies (`<dataDir>/agent-workspaces/<sessionId>`).
 *
 * A copy is (re)created from the project at the start of every run and has no
 * use once the run's diff is taken (proposals hold the full file contents, and
 * agent session resume only needs the directory path). So:
 *
 * - each copy is recorded (session, project, agent, created / last active,
 *   size) while it exists;
 * - it is removed as soon as its run ends;
 * - a sweep at startup and every hour removes what was left behind: copies of
 *   runs interrupted by a crash, removals that failed (e.g. a file still
 *   locked on Windows) and directories nothing records (orphans);
 * - a copy in use (by a run, or by a removal) is never touched;
 * - removal only ever happens strictly inside the staging root, never
 *   following links, so project data cannot be deleted through it;
 * - all copies in use together stay under `RS_AGENT_STAGING_MAX_BYTES`.
 */
export class StagingLifecycle {
  /** Sessions whose copy is in use, with a promise that settles when it is free again. */
  private readonly busy = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repos: AiRepositories,
    private readonly config: RuntimeConfig,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
  ) {}

  get root(): string {
    return path.join(this.config.dataDir, 'agent-workspaces');
  }

  /** Why agents cannot use the staging root, or null. */
  problem(): string | null {
    if (!areDisjoint(this.root, this.config.workspaceRoot)) {
      return `The agent staging directory (${this.root}) overlaps the project workspace (${this.config.workspaceRoot}). Set RS_DATA_DIR outside RS_WORKSPACE_ROOT.`;
    }
    return null;
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  /** Wait until nothing else uses the session's copy, then hold it. Returns the release function. */
  async claim(sessionId: string): Promise<() => void> {
    while (this.busy.has(sessionId)) await this.busy.get(sessionId);
    let release!: () => void;
    this.busy.set(sessionId, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.busy.delete(sessionId);
      release();
    };
  }

  /** Record that a run is about to use the copy. */
  activate(input: { sessionId: string; projectId: string; agentId: string }): void {
    this.repos.staging.activate(input);
  }

  /** Remember the copy's size once it is prepared. */
  recordSize(sessionId: string, size: { files: number; bytes: number }): void {
    this.repos.staging.touch(sessionId, size);
  }

  /** Limits for a new copy: its share of the total budget not used by other copies. */
  limitsFor(sessionId: string): StagingLimits {
    const used = this.repos.staging
      .list()
      .filter((r) => r.sessionId !== sessionId)
      .reduce((n, r) => n + r.bytes, 0);
    const remaining = Math.max(0, this.config.ai.stagingMaxBytes - used);
    return { ...DEFAULT_STAGING_LIMITS, maxTotalBytes: Math.min(DEFAULT_STAGING_LIMITS.maxTotalBytes, remaining) };
  }

  /**
   * Remove one copy the caller holds (see `claim`). On failure the record
   * stays, marked idle, so the next sweep retries.
   */
  async remove(sessionId: string, reason: StagingCleanupReason): Promise<boolean> {
    try {
      await removeStagingDir(this.root, path.join(this.root, sessionId));
      this.repos.staging.delete(sessionId);
      return true;
    } catch (err) {
      this.repos.staging.release(sessionId, null);
      this.log.warn({ err, sessionId, reason }, 'could not remove agent staging copy');
      this.audit.record({
        action: 'ai.staging.cleanup',
        outcome: 'error',
        actor: null,
        projectId: null,
        target: sessionId,
        details: { reason, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }

  /** Remove every copy not in use, and every directory in the staging root that no record explains. */
  async sweep(reason: 'startup' | 'scheduled'): Promise<StagingSweepResult> {
    const result: StagingSweepResult = { removed: [], orphans: [], failed: [], bytes: 0 };
    if (this.problem()) return result;
    // After a restart nothing can be running.
    if (reason === 'startup') this.repos.staging.releaseAll();

    const recorded = new Set<string>();
    for (const row of this.repos.staging.list()) {
      recorded.add(row.sessionId);
      if (this.busy.has(row.sessionId)) continue;
      const release = await this.claim(row.sessionId);
      try {
        if (await this.remove(row.sessionId, reason)) {
          result.removed.push(row.sessionId);
          result.bytes += row.bytes;
        } else {
          result.failed.push(row.sessionId);
        }
      } finally {
        release();
      }
    }

    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const name of entries) {
      if (recorded.has(name) || this.busy.has(name)) continue;
      const release = await this.claim(name);
      try {
        // A run may have started (and recorded itself) while we were busy.
        if (this.repos.staging.get(name)) continue;
        await lstat(path.join(this.root, name));
        await removeStagingDir(this.root, path.join(this.root, name));
        result.orphans.push(name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.log.warn({ err, entry: name }, 'could not remove orphaned staging entry');
        result.failed.push(name);
      } finally {
        release();
      }
    }

    if (result.removed.length || result.orphans.length || result.failed.length) {
      this.audit.record({
        action: 'ai.staging.cleanup',
        outcome: result.failed.length ? 'error' : 'success',
        actor: null,
        projectId: null,
        target: null,
        details: { reason, removed: result.removed.length, orphans: result.orphans.length, failed: result.failed.length, bytes: result.bytes },
      });
    }
    return result;
  }

  /** Sweep now (startup) and then every `intervalMs`. */
  start(intervalMs = 60 * 60_000): void {
    const problem = this.problem();
    if (problem) this.log.error(problem);
    const run = (reason: 'startup' | 'scheduled') =>
      this.sweep(reason).catch((err: unknown) => this.log.warn({ err }, 'agent staging sweep failed'));
    void run('startup');
    this.timer = setInterval(() => void run('scheduled'), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.busy.values()]);
  }
}
