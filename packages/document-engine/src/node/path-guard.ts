import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '@research-studio/shared-types';
import { normalizeProjectPath, type NormalizeOptions } from '../paths';
import { isWithin, realpathOfNearestExisting } from './containment';

/** True when `candidate` is `root` or lies beneath it (segment-aware; case-insensitive on Windows). */
export const isInside = (root: string, candidate: string): boolean => isWithin(root, candidate);

/**
 * Resolves client-supplied project-relative paths to absolute paths that are
 * guaranteed to stay within the project root, including after symlink
 * resolution of every existing ancestor.
 */
export class PathGuard {
  private constructor(readonly root: string) {}

  /** `root` must exist; it is canonicalised with realpath. */
  static async create(root: string): Promise<PathGuard> {
    try {
      return new PathGuard(await realpath(root));
    } catch (err) {
      throw new StudioError('NOT_FOUND', 'Project directory does not exist', {
        cause: (err as Error).message,
      });
    }
  }

  /** Lexical resolution only (no FS access). */
  resolveLexical(relative: string, options?: NormalizeOptions): { rel: string; abs: string } {
    const rel = normalizeProjectPath(relative, options);
    const abs = rel === '' ? this.root : path.join(this.root, ...rel.split('/'));
    if (!isInside(this.root, abs)) {
      throw new StudioError('PATH_VIOLATION', 'Path escapes the project directory', { path: relative });
    }
    return { rel, abs };
  }

  /** Full resolution: lexical checks plus realpath containment of the nearest existing ancestor. */
  async resolve(relative: string, options?: NormalizeOptions): Promise<{ rel: string; abs: string }> {
    const resolved = this.resolveLexical(relative, options);
    const finalReal = await realpathOfNearestExisting(resolved.abs);
    if (!isInside(this.root, finalReal)) {
      throw new StudioError('PATH_VIOLATION', 'Path resolves outside the project directory', {
        path: relative,
      });
    }
    return { rel: resolved.rel, abs: finalReal };
  }

  /** Convert an absolute path produced by a tool (e.g. SyncTeX) back to a project path. */
  toProjectPath(absolute: string): string | null {
    const abs = path.resolve(this.root, absolute);
    if (!isInside(this.root, abs)) return null;
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    try {
      return normalizeProjectPath(rel);
    } catch {
      return null;
    }
  }
}

/** Validates that a project root lies inside one of the authorised workspace roots. */
export async function assertAuthorizedRoot(candidate: string, authorizedRoots: string[]): Promise<string> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new StudioError('NOT_FOUND', 'Project directory does not exist', { path: candidate });
  }
  for (const root of authorizedRoots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (real !== realRoot && isInside(realRoot, real)) return real;
  }
  throw new StudioError('FORBIDDEN', 'Directory is outside the authorized workspace roots', {
    path: candidate,
  });
}
