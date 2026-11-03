import { StudioError } from '@research-studio/shared-types';

/**
 * Pure (isomorphic) validation of project-relative paths. This is the first
 * line of defence against traversal; the runtime additionally resolves the
 * result against the real project root (see `node/path-guard.ts`).
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_SEGMENT_LENGTH = 255;

/** Top-level names clients may never write to. */
export const RESERVED_TOP_LEVEL = new Set(['.rs-build', '.git']);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_CHARS = /[<>:"|?*]/;

export interface NormalizeOptions {
  /** Accept the empty path (project root). */
  allowRoot?: boolean;
  /** Reject paths inside reserved top-level directories. */
  forWrite?: boolean;
}

function violation(message: string, input: string): StudioError {
  return new StudioError('PATH_VIOLATION', message, { path: input });
}

/**
 * Validate and canonicalise a project-relative path to POSIX form.
 * Throws `StudioError('PATH_VIOLATION')` for anything that is not a plain
 * relative path made of safe segments.
 */
export function normalizeProjectPath(input: unknown, options: NormalizeOptions = {}): string {
  if (typeof input !== 'string') throw violation('Path must be a string', String(input));
  if (input.length > MAX_PATH_LENGTH) throw violation('Path is too long', input.slice(0, 64));
  if (CONTROL_CHARS.test(input)) throw violation('Path contains control characters', input);

  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('/')) throw violation('Absolute paths are not allowed', input);
  if (/^[a-zA-Z]:/.test(unified)) throw violation('Drive-qualified paths are not allowed', input);

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw violation('Parent directory segments are not allowed', input);
    if (segment.length > MAX_SEGMENT_LENGTH) throw violation('Path segment is too long', input);
    if (FORBIDDEN_CHARS.test(segment)) throw violation('Path contains forbidden characters', input);
    if (/[. ]$/.test(segment)) throw violation('Path segments may not end with a dot or space', input);
    if (WINDOWS_RESERVED.test(segment)) throw violation('Path uses a reserved device name', input);
    segments.push(segment);
  }

  if (segments.length === 0) {
    if (options.allowRoot) return '';
    throw violation('Path must not be empty', input);
  }
  if (options.forWrite && RESERVED_TOP_LEVEL.has(segments[0]!.toLowerCase())) {
    throw violation(`"${segments[0]}" is reserved by Research Studio`, input);
  }
  return segments.join('/');
}

/** Validate a single file or folder name (no separators). */
export function validateEntryName(name: string): string {
  if (name.includes('/') || name.includes('\\')) {
    throw violation('Names may not contain path separators', name);
  }
  return normalizeProjectPath(name);
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function extname(path: string): string {
  const name = basename(path);
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export function joinProjectPath(...parts: string[]): string {
  return normalizeProjectPath(parts.filter((p) => p !== '').join('/'), { allowRoot: true });
}

/** Turn a human project name into a safe directory name. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug === '' || WINDOWS_RESERVED.test(slug) ? `project-${slug || 'untitled'}` : slug;
}
