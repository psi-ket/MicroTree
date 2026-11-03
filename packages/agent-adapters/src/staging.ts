import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isEditablePath } from '@research-studio/document-engine';
import { areDisjoint, assertDisjoint, isStrictlyWithin, resolveWithin } from '@research-studio/document-engine/node';

/** Directories never copied into (or read back from) a staging copy. */
const SKIP_DIRS = new Set(['.rs-build', '.git', 'node_modules', '.claude', '.codex']);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export interface StagingLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_STAGING_LIMITS: StagingLimits = { maxFiles: 5_000, maxTotalBytes: 300 * 1024 * 1024 };

export interface StagedFile {
  hash: string;
  size: number;
}

export type StagedChange =
  | { path: string; change: 'update'; before: string; after: string; baseHash: string }
  | { path: string; change: 'add'; after: string }
  | { path: string; change: 'delete'; before: string; baseHash: string };

export interface StagingResult {
  changes: StagedChange[];
  /** Changes that cannot become proposals (binary files, too large, not editable). */
  ignored: { path: string; reason: string }[];
}

/** One path segment: what the runtime uses as a session (conversation) id. */
export const STAGING_SESSION_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/**
 * Visit regular files below `root`. Links (symbolic links and Windows
 * junctions) are never followed: they are reported to `onLink` and skipped.
 */
async function walk(
  root: string,
  onFile: (rel: string, abs: string, size: number) => Promise<void>,
  onLink: (rel: string) => void = () => undefined,
): Promise<void> {
  const visit = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      // lstat as well as the Dirent: junctions are links too.
      const info = await lstat(abs);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        onLink(childRel);
      } else if (info.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(abs, childRel);
      } else if (info.isFile()) {
        await onFile(childRel, abs, info.size);
      }
    }
  };
  await visit(root, '');
}

export interface StagingLocation {
  /** The project being copied. */
  projectRoot: string;
  /** Runtime-owned directory that holds every staging copy (outside all projects). */
  stagingRoot: string;
  /** The agent session this copy belongs to; becomes the directory name. */
  sessionId: string;
}

/**
 * Remove one staging directory, which must be strictly inside the staging
 * root. A link at `dir` is unlinked, never followed; `rm` itself unlinks links
 * found inside the tree instead of descending into them.
 */
export async function removeStagingDir(stagingRoot: string, dir: string): Promise<void> {
  if (!isStrictlyWithin(stagingRoot, dir)) throw new Error('Refusing to remove a directory outside the staging root');
  let info;
  try {
    info = await lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (info.isSymbolicLink()) {
    await unlink(dir);
    return;
  }
  // Its real path must still be inside the real staging root.
  await resolveWithin(stagingRoot, dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * An isolated copy of a project for one agent session. The agent works here;
 * the project directory is never its working directory. After a run, `diff`
 * compares the copy with the snapshot taken when it was prepared.
 *
 * The copy lives at `<stagingRoot>/<sessionId>`. The staging root must not
 * overlap the project (checked lexically here and with real paths before
 * every file operation), and the session id must be a single plain segment.
 */
export class StagingWorkspace {
  readonly projectRoot: string;
  readonly stagingRoot: string;
  readonly dir: string;
  private snapshot = new Map<string, StagedFile>();

  constructor(
    location: StagingLocation,
    private readonly limits: StagingLimits = DEFAULT_STAGING_LIMITS,
  ) {
    if (!STAGING_SESSION_ID.test(location.sessionId)) throw new Error('Invalid staging session id');
    this.projectRoot = path.resolve(location.projectRoot);
    this.stagingRoot = path.resolve(location.stagingRoot);
    this.dir = path.join(this.stagingRoot, location.sessionId);
    if (!areDisjoint(this.projectRoot, this.stagingRoot)) throw new Error('The staging directory must be outside the project');
  }

  /** Re-check containment against the real file system (links, junctions). Fails closed. */
  private async verify(): Promise<void> {
    const message = 'The staging directory must be outside the project';
    // Check before creating anything, so a link cannot make us create folders in the project.
    await assertDisjoint(this.projectRoot, this.stagingRoot, message);
    await mkdir(this.stagingRoot, { recursive: true });
    await assertDisjoint(this.projectRoot, this.stagingRoot, message);
    await resolveWithin(this.stagingRoot, this.dir);
  }

  /** Replace the staging copy with the project's current files and remember their hashes. */
  async prepare(): Promise<{ files: number; bytes: number }> {
    await this.verify();
    await removeStagingDir(this.stagingRoot, this.dir);
    await mkdir(this.dir, { recursive: true });
    this.snapshot = new Map();
    let files = 0;
    let bytes = 0;
    await walk(this.projectRoot, async (rel, abs, size) => {
      if (size > MAX_FILE_BYTES) return;
      if (++files > this.limits.maxFiles) throw new Error(`The project has more than ${this.limits.maxFiles} files; too large for an agent run.`);
      bytes += size;
      if (bytes > this.limits.maxTotalBytes) throw new Error('The project is too large to copy for an agent run.');
      const target = path.join(this.dir, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(abs, target);
      this.snapshot.set(rel, { hash: sha(await readFile(target)), size });
    });
    return { files, bytes };
  }

  /** Hash the project file had when staged (for proposal base hashes). */
  baseHash(rel: string): string | null {
    return this.snapshot.get(rel)?.hash ?? null;
  }

  async diff(): Promise<StagingResult> {
    await this.verify();
    const changes: StagedChange[] = [];
    const ignored: StagingResult['ignored'] = [];
    const seen = new Set<string>();
    let count = 0;
    const onLink = (rel: string) => {
      seen.add(rel);
      ignored.push({ path: rel, reason: 'link (not followed)' });
    };
    await walk(this.dir, async (rel, abs, size) => {
      if (++count > this.limits.maxFiles * 2) throw new Error('The agent created too many files.');
      seen.add(rel);
      const before = this.snapshot.get(rel);
      if (size > MAX_TEXT_BYTES) {
        if (!before || before.size !== size) ignored.push({ path: rel, reason: 'too large to review' });
        return;
      }
      const bytes = await readFile(abs);
      const hash = sha(bytes);
      if (before && before.hash === hash) return;
      if (!isEditablePath(rel)) {
        ignored.push({ path: rel, reason: before ? 'binary or non-text file changed' : 'binary or non-text file created' });
        return;
      }
      let after: string;
      try {
        after = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        ignored.push({ path: rel, reason: 'not valid UTF-8 text' });
        return;
      }
      if (!before) {
        changes.push({ path: rel, change: 'add', after });
        return;
      }
      const original = await readFile(path.join(this.projectRoot, ...rel.split('/')), 'utf8').catch(() => null);
      if (original === null || sha(original) !== before.hash) {
        ignored.push({ path: rel, reason: 'the project file changed while the agent was running' });
        return;
      }
      changes.push({ path: rel, change: 'update', before: original, after, baseHash: before.hash });
    }, onLink);
    for (const [rel, file] of this.snapshot) {
      if (seen.has(rel)) continue;
      if (!isEditablePath(rel)) {
        ignored.push({ path: rel, reason: 'binary or non-text file deleted' });
        continue;
      }
      const original = await readFile(path.join(this.projectRoot, ...rel.split('/')), 'utf8').catch(() => null);
      if (original !== null && sha(original) === file.hash) changes.push({ path: rel, change: 'delete', before: original, baseHash: file.hash });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return { changes, ignored };
  }

  async dispose(): Promise<void> {
    await removeStagingDir(this.stagingRoot, this.dir);
  }
}
