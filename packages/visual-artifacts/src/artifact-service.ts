import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';
import type { CompilationStatus, Diagnostic, VersionOrigin } from '@research-studio/shared-types';
import type { ArtifactPayload } from '@research-studio/visual-engine';

export type ArtifactRow = typeof schema.visualArtifacts.$inferSelect;
export type VersionRow = typeof schema.visualArtifactVersions.$inferSelect;

export const newVisualId = (prefix: 'var' | 'vav' | 'vtk' | 'vin') => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export class ArtifactError extends Error {
  override name = 'ArtifactError';
  constructor(
    readonly code: 'not-found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Visual artifacts and their versions. Every change (model output, manual
 * edit, refinement, recalibration, restore) is a new version; nothing is
 * overwritten. Approval names the exact version approved, so a later edit
 * needs approval again.
 */
export class ArtifactService {
  constructor(
    private readonly db: StudioDb,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(payload: ArtifactPayload, input: { projectId: string | null; sourceAssetId: string | null; taskId: string | null; origin: VersionOrigin; changeDescription: string }): { artifact: ArtifactRow; version: VersionRow } {
    const id = newVisualId('var');
    const ts = this.now();
    this.db.transaction((tx) => {
      tx.insert(schema.visualArtifacts)
        .values({ id, artifactType: payload.artifactType, title: payload.title.slice(0, 200), description: null, projectId: input.projectId, sourceAssetId: input.sourceAssetId, currentVersion: 1, createdAt: ts, updatedAt: ts })
        .run();
      tx.insert(schema.visualArtifactVersions).values(this.versionRow(id, 1, payload, input.origin, input.changeDescription, input.taskId, ts)).run();
    });
    return { artifact: this.require(id), version: this.version(id, 1)! };
  }

  private versionRow(artifactId: string, n: number, p: ArtifactPayload, origin: VersionOrigin, description: string, taskId: string | null, ts: string): typeof schema.visualArtifactVersions.$inferInsert {
    const invalid = p.issues.some((i) => i.severity === 'error');
    return {
      id: newVisualId('vav'),
      artifactId,
      versionNumber: n,
      sourceCode: p.sourceCode,
      structuredData: p.structuredData,
      dataCsv: p.dataCsv,
      warnings: [...p.warnings, ...p.issues.filter((i) => i.severity === 'error').map((i) => `Invalid: ${i.message}`)],
      origin,
      changeDescription: description.slice(0, 1000),
      packages: p.packages,
      compilationStatus: invalid ? 'invalid' : 'not-compiled',
      diagnostics: [],
      taskId,
      createdAt: ts,
    };
  }

  /** A new version on top of the current one. */
  addVersion(artifactId: string, payload: ArtifactPayload, origin: VersionOrigin, changeDescription: string, taskId: string | null = null): VersionRow {
    const a = this.require(artifactId);
    const n = a.currentVersion + 1;
    const ts = this.now();
    this.db.transaction((tx) => {
      tx.insert(schema.visualArtifactVersions).values(this.versionRow(artifactId, n, payload, origin, changeDescription, taskId, ts)).run();
      tx.update(schema.visualArtifacts).set({ currentVersion: n, title: payload.title.slice(0, 200), updatedAt: ts }).where(eq(schema.visualArtifacts.id, artifactId)).run();
    });
    return this.version(artifactId, n)!;
  }

  /** Restoring copies an old version into a new one; history is kept. */
  restore(artifactId: string, versionNumber: number): VersionRow {
    const old = this.version(artifactId, versionNumber);
    if (!old) throw new ArtifactError('not-found', `Version ${versionNumber} not found`);
    const a = this.require(artifactId);
    const n = a.currentVersion + 1;
    const ts = this.now();
    this.db.transaction((tx) => {
      tx.insert(schema.visualArtifactVersions)
        .values({ ...old, id: newVisualId('vav'), versionNumber: n, origin: 'restore', changeDescription: `Restored version ${versionNumber}`, createdAt: ts })
        .run();
      tx.update(schema.visualArtifacts).set({ currentVersion: n, updatedAt: ts }).where(eq(schema.visualArtifacts.id, artifactId)).run();
    });
    return this.version(artifactId, n)!;
  }

  setCompilation(versionId: string, patch: { status: CompilationStatus; diagnostics?: Diagnostic[]; log?: string | null; previewAssetId?: string | null; packages?: string[] }): void {
    this.db
      .update(schema.visualArtifactVersions)
      .set({
        compilationStatus: patch.status,
        ...(patch.diagnostics ? { diagnostics: patch.diagnostics } : {}),
        ...(patch.log !== undefined ? { compileLog: patch.log } : {}),
        ...(patch.previewAssetId !== undefined ? { previewAssetId: patch.previewAssetId } : {}),
        ...(patch.packages ? { packages: patch.packages } : {}),
      })
      .where(eq(schema.visualArtifactVersions.id, versionId))
      .run();
  }

  /** Approve one version (only one that compiled, unless it has nothing to compile). */
  approve(artifactId: string, versionNumber: number): ArtifactRow {
    const v = this.version(artifactId, versionNumber);
    if (!v) throw new ArtifactError('not-found', `Version ${versionNumber} not found`);
    const a = this.require(artifactId);
    if (a.artifactType !== 'explanation' && v.compilationStatus !== 'succeeded') throw new ArtifactError('conflict', 'Only a version that compiled can be approved; compile it first');
    this.db.update(schema.visualArtifacts).set({ approval: 'approved', approvedAt: this.now(), approvedVersion: versionNumber, updatedAt: this.now() }).where(eq(schema.visualArtifacts.id, artifactId)).run();
    return this.require(artifactId);
  }

  get(id: string): ArtifactRow | null {
    return this.db.select().from(schema.visualArtifacts).where(eq(schema.visualArtifacts.id, id)).get() ?? null;
  }

  require(id: string): ArtifactRow {
    const a = this.get(id);
    if (!a) throw new ArtifactError('not-found', `Artifact ${id} not found`);
    return a;
  }

  version(artifactId: string, n: number): VersionRow | null {
    return this.db.select().from(schema.visualArtifactVersions).where(and(eq(schema.visualArtifactVersions.artifactId, artifactId), eq(schema.visualArtifactVersions.versionNumber, n))).get() ?? null;
  }

  versionById(id: string): VersionRow | null {
    return this.db.select().from(schema.visualArtifactVersions).where(eq(schema.visualArtifactVersions.id, id)).get() ?? null;
  }

  current(artifactId: string): VersionRow {
    const a = this.require(artifactId);
    return this.version(artifactId, a.currentVersion)!;
  }

  versions(artifactId: string): VersionRow[] {
    return this.db.select().from(schema.visualArtifactVersions).where(eq(schema.visualArtifactVersions.artifactId, artifactId)).orderBy(desc(schema.visualArtifactVersions.versionNumber)).all();
  }

  list(opts: { projectId?: string; limit?: number } = {}): ArtifactRow[] {
    const q = this.db.select().from(schema.visualArtifacts);
    return (opts.projectId ? q.where(eq(schema.visualArtifacts.projectId, opts.projectId)) : q).orderBy(desc(schema.visualArtifacts.updatedAt)).limit(opts.limit ?? 100).all();
  }

  delete(id: string): void {
    this.db.delete(schema.visualArtifacts).where(eq(schema.visualArtifacts.id, id)).run();
  }
}

/** A line diff for comparing versions (longest common subsequence over lines). */
export function lineDiff(a: string, b: string): { kind: 'same' | 'added' | 'removed'; text: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ kind: 'removed' as const, text: t })), ...y.map((t) => ({ kind: 'added' as const, text: t }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { kind: 'same' | 'added' | 'removed'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'removed', text: x[i++]! });
    else out.push({ kind: 'added', text: y[j++]! });
  }
  while (i < x.length) out.push({ kind: 'removed', text: x[i++]! });
  while (j < y.length) out.push({ kind: 'added', text: y[j++]! });
  return out;
}
