import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  StudioError,
  type FileTreeNode,
  type ProjectFileContent,
} from '@research-studio/shared-types';
import { classifyFile, isEditablePath } from '../file-kinds';
import { basename, RESERVED_TOP_LEVEL } from '../paths';
import { PathGuard } from './path-guard';

export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 24;
const IGNORED_DIRS = new Set([...RESERVED_TOP_LEVEL, 'node_modules']);
const TEMP_MARKER = '.rs-tmp-';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface FileStat {
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export interface WriteTextOptions {
  /** Fail with ALREADY_EXISTS if the file exists. */
  createOnly?: boolean;
  /** Expected sha256 of the current content; CONFLICT when it differs. */
  baseHash?: string | null;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function decodeUtf8(bytes: Buffer, rel: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'File is not valid UTF-8 text', { path: rel });
  }
}

/** All filesystem access to a project goes through this class. */
export class ProjectFs {
  private constructor(readonly guard: PathGuard) {}

  static async open(root: string): Promise<ProjectFs> {
    return new ProjectFs(await PathGuard.create(root));
  }

  get root(): string {
    return this.guard.root;
  }

  async exists(rel: string): Promise<boolean> {
    const { abs } = await this.guard.resolve(rel, { allowRoot: true });
    try {
      await lstat(abs);
      return true;
    } catch (err) {
      if (errno(err) === 'ENOENT') return false;
      throw err;
    }
  }

  async stat(rel: string): Promise<FileStat> {
    const { rel: clean, abs } = await this.guard.resolve(rel, { allowRoot: true });
    try {
      const s = await stat(abs);
      return {
        path: clean,
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        modifiedAt: s.mtime.toISOString(),
      };
    } catch (err) {
      if (errno(err) === 'ENOENT') throw new StudioError('NOT_FOUND', 'File not found', { path: clean });
      throw err;
    }
  }

  async readText(rel: string): Promise<ProjectFileContent> {
    const { rel: clean, abs } = await this.guard.resolve(rel);
    const s = await this.statFile(abs, clean);
    if (s.size > MAX_TEXT_FILE_BYTES) {
      throw new StudioError('PAYLOAD_TOO_LARGE', 'File is too large to open in the editor', {
        path: clean,
        size: s.size,
      });
    }
    const bytes = await readFile(abs);
    const content = decodeUtf8(bytes, clean);
    return {
      path: clean,
      kind: classifyFile(clean),
      content,
      hash: sha256(bytes),
      size: bytes.byteLength,
      modifiedAt: s.mtime.toISOString(),
    };
  }

  async readBinary(rel: string): Promise<{ path: string; bytes: Buffer; modifiedAt: string }> {
    const { rel: clean, abs } = await this.guard.resolve(rel);
    const s = await this.statFile(abs, clean);
    return { path: clean, bytes: await readFile(abs), modifiedAt: s.mtime.toISOString() };
  }

  /** Current sha256 of a file, or null when it does not exist. */
  async hashOf(rel: string): Promise<string | null> {
    const { abs } = await this.guard.resolve(rel);
    try {
      return sha256(await readFile(abs));
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  }

  async writeText(rel: string, content: string, options: WriteTextOptions = {}): Promise<ProjectFileContent> {
    const { rel: clean, abs } = await this.guard.resolve(rel, { forWrite: true });
    if (!isEditablePath(clean)) {
      throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'This file type cannot be edited as text', {
        path: clean,
      });
    }
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new StudioError('PAYLOAD_TOO_LARGE', 'File is too large', { path: clean });
    }
    const current = await this.hashOf(clean);
    if (options.createOnly && current !== null) {
      throw new StudioError('ALREADY_EXISTS', 'A file with this name already exists', { path: clean });
    }
    if (options.baseHash && current !== null && current !== options.baseHash) {
      throw new StudioError('CONFLICT', 'The file was modified on disk since it was opened', {
        path: clean,
        currentHash: current,
      });
    }
    await this.ensureParent(abs);
    await this.atomicWrite(abs, bytes);
    const s = await stat(abs);
    return {
      path: clean,
      kind: classifyFile(clean),
      content,
      hash: sha256(bytes),
      size: bytes.byteLength,
      modifiedAt: s.mtime.toISOString(),
    };
  }

  /** Write a binary file. Never overwrites: a numeric suffix is added on collision. */
  async writeBinaryUnique(rel: string, bytes: Uint8Array): Promise<FileStat> {
    const first = await this.guard.resolve(rel, { forWrite: true });
    const dot = first.rel.lastIndexOf('.');
    const stem = dot > first.rel.lastIndexOf('/') ? first.rel.slice(0, dot) : first.rel;
    const ext = dot > first.rel.lastIndexOf('/') ? first.rel.slice(dot) : '';
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? first.rel : `${stem}-${i}${ext}`;
      const { rel: clean, abs } = await this.guard.resolve(candidate, { forWrite: true });
      await this.ensureParent(abs);
      try {
        await writeFile(abs, bytes, { flag: 'wx' });
        return this.stat(clean);
      } catch (err) {
        if (errno(err) === 'EEXIST') continue;
        throw err;
      }
    }
    throw new StudioError('ALREADY_EXISTS', 'Could not find a free file name', { path: rel });
  }

  async mkdir(rel: string): Promise<FileStat> {
    const { rel: clean, abs } = await this.guard.resolve(rel, { forWrite: true });
    try {
      await mkdir(abs);
    } catch (err) {
      if (errno(err) === 'EEXIST') {
        throw new StudioError('ALREADY_EXISTS', 'A file or folder with this name already exists', {
          path: clean,
        });
      }
      if (errno(err) === 'ENOENT') {
        await mkdir(abs, { recursive: true });
      } else {
        throw err;
      }
    }
    return this.stat(clean);
  }

  async rename(fromRel: string, toRel: string): Promise<FileStat> {
    const from = await this.guard.resolve(fromRel, { forWrite: true });
    const to = await this.guard.resolve(toRel, { forWrite: true });
    await this.statAny(from.abs, from.rel);
    if (await this.exists(to.rel)) {
      // Allow pure case changes on case-insensitive filesystems.
      if (from.rel.toLowerCase() !== to.rel.toLowerCase()) {
        throw new StudioError('ALREADY_EXISTS', 'Destination already exists', { path: to.rel });
      }
    }
    if (to.rel.startsWith(`${from.rel}/`)) {
      throw new StudioError('BAD_REQUEST', 'Cannot move a folder into itself', { path: to.rel });
    }
    await this.ensureParent(to.abs);
    await rename(from.abs, to.abs);
    return this.stat(to.rel);
  }

  async remove(rel: string): Promise<void> {
    const { rel: clean, abs } = await this.guard.resolve(rel, { forWrite: true });
    await this.statAny(abs, clean);
    await rm(abs, { recursive: true, force: false });
  }

  /** Scan the project tree. Symlinks are not followed or listed. */
  async tree(): Promise<FileTreeNode> {
    let count = 0;
    const walk = async (absDir: string, relDir: string, depth: number): Promise<FileTreeNode[]> => {
      if (depth > MAX_TREE_DEPTH) return [];
      const entries = await readdir(absDir, { withFileTypes: true });
      const nodes: FileTreeNode[] = [];
      for (const entry of entries) {
        if (count >= MAX_TREE_ENTRIES) break;
        if (entry.isSymbolicLink()) continue;
        if (entry.name.includes(TEMP_MARKER)) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (relDir === '' && IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
          if (entry.name === 'node_modules') continue;
          count++;
          nodes.push({
            path: rel,
            name: entry.name,
            type: 'directory',
            kind: null,
            size: null,
            children: await walk(path.join(absDir, entry.name), rel, depth + 1),
          });
        } else if (entry.isFile()) {
          count++;
          let size: number | null;
          try {
            size = (await stat(path.join(absDir, entry.name))).size;
          } catch {
            size = null;
          }
          nodes.push({ path: rel, name: entry.name, type: 'file', kind: classifyFile(rel), size });
        }
      }
      nodes.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'directory' ? -1 : 1,
      );
      return nodes;
    };
    return {
      path: '',
      name: basename(this.root.split(path.sep).join('/')),
      type: 'directory',
      kind: null,
      size: null,
      children: await walk(this.root, '', 0),
    };
  }

  /** Flat list of all files in the tree. */
  async listFiles(): Promise<FileTreeNode[]> {
    const out: FileTreeNode[] = [];
    const visit = (node: FileTreeNode) => {
      if (node.type === 'file') out.push(node);
      node.children?.forEach(visit);
    };
    visit(await this.tree());
    return out;
  }

  private async statFile(abs: string, rel: string) {
    const s = await this.statAny(abs, rel);
    if (!s.isFile()) throw new StudioError('BAD_REQUEST', 'Path is not a file', { path: rel });
    return s;
  }

  private async statAny(abs: string, rel: string) {
    try {
      return await lstat(abs);
    } catch (err) {
      if (errno(err) === 'ENOENT') throw new StudioError('NOT_FOUND', 'File not found', { path: rel });
      throw err;
    }
  }

  private async ensureParent(abs: string): Promise<void> {
    await mkdir(path.dirname(abs), { recursive: true });
  }

  private async atomicWrite(abs: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${abs}${TEMP_MARKER}${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, bytes, { flag: 'wx' });
    try {
      await rename(tmp, abs);
    } catch (err) {
      // Windows refuses to replace a file another process holds open; fall back to in-place write.
      if (errno(err) === 'EPERM' || errno(err) === 'EBUSY' || errno(err) === 'EACCES') {
        await writeFile(abs, bytes);
        await rm(tmp, { force: true });
        return;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
