import { realpath } from 'node:fs/promises';
import nodePath from 'node:path';

/** `node:path` flavour to use; tests pass `path.win32` / `path.posix` explicitly. */
export type PathApi = typeof nodePath.posix;

/**
 * True when `candidate` is `root` itself or lies beneath it.
 *
 * Segment-aware: `path.relative` is used and its result is checked for a
 * leading `..` *segment*, so `<root>/..staging` and `<root>/...data` count as
 * inside while `<root>/../x` does not. Both arguments are resolved first,
 * which also normalises mixed separators on Windows. On Windows the
 * comparison is case-insensitive (as `path.win32.relative` is).
 */
export function isWithin(root: string, candidate: string, api: PathApi = nodePath): boolean {
  const rel = api.relative(api.resolve(root), api.resolve(candidate));
  if (rel === '') return true;
  if (api.isAbsolute(rel)) return false; // different drive or UNC share
  const first = rel.split(api.sep)[0];
  return first !== '..';
}

/** Strictly beneath `root` (not equal). */
export function isStrictlyWithin(root: string, candidate: string, api: PathApi = nodePath): boolean {
  return isWithin(root, candidate, api) && api.relative(api.resolve(root), api.resolve(candidate)) !== '';
}

/** True when neither tree contains the other. */
export function areDisjoint(a: string, b: string, api: PathApi = nodePath): boolean {
  return !isWithin(a, b, api) && !isWithin(b, a, api);
}

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainmentError';
  }
}

/**
 * Realpath of `target`, or of its nearest existing ancestor with the missing
 * tail appended. Symlinks and Windows junctions in every existing component
 * are resolved. Any error other than "does not exist" is rethrown so callers
 * fail closed.
 */
export async function realpathOfNearestExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let current = nodePath.resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length ? nodePath.join(real, ...rest) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = nodePath.dirname(current);
      if (parent === current) throw err;
      rest.unshift(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and require that it
 * stays within `root` both lexically and after resolving links. Returns the
 * real path. Throws `ContainmentError` when containment cannot be
 * established, including when the file system cannot be read.
 */
export async function resolveWithin(root: string, candidate: string): Promise<string> {
  const lexical = nodePath.resolve(root, candidate);
  if (!isWithin(root, lexical)) throw new ContainmentError(`${candidate} is outside ${root}`);
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpathOfNearestExisting(lexical);
  } catch (err) {
    throw new ContainmentError(`Cannot verify that ${candidate} is inside ${root}: ${(err as Error).message}`);
  }
  if (!isWithin(realRoot, real)) throw new ContainmentError(`${candidate} resolves outside ${root}`);
  return real;
}

/**
 * Require that two directory trees do not overlap, comparing both the given
 * paths and their real paths (so a link cannot make one appear disjoint).
 */
export async function assertDisjoint(a: string, b: string, message: string): Promise<void> {
  if (!areDisjoint(a, b)) throw new ContainmentError(message);
  let realA: string;
  let realB: string;
  try {
    realA = await realpathOfNearestExisting(a);
    realB = await realpathOfNearestExisting(b);
  } catch (err) {
    throw new ContainmentError(`${message} (${(err as Error).message})`);
  }
  if (!areDisjoint(realA, realB)) throw new ContainmentError(message);
}
