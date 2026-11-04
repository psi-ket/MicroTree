import { createReadStream, type ReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isWithin } from '@research-studio/document-engine/node';
import { LibraryCancelledError, LibraryError } from '../errors/library-errors';
import { SHA256_HEX, StreamDigest } from './content-hash';

/** A file received into the temporary area, hashed and measured while it was written. */
export interface TempFile {
  path: string;
  sha256: string;
  size: number;
  head: Buffer;
  tail: Buffer;
}

const STORAGE_KEY = /^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.(pdf|zip|png|jpg|webp|svg|csv|txt)$/;

/**
 * Content-addressed file store for library attachments:
 * `<root>/objects/<ab>/<cd>/<sha256>.<ext>`, written through `<root>/tmp`.
 * Locations are derived from the hash only; nothing the browser sends becomes
 * part of a path. The store never follows a symbolic link it finds inside it.
 */
export class AttachmentStorage {
  readonly objectsDir: string;
  readonly tmpDir: string;
  private realRoot: string | null = null;

  constructor(readonly root: string) {
    this.objectsDir = path.join(root, 'objects');
    this.tmpDir = path.join(root, 'tmp');
  }

  async init(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    this.realRoot = await realpath(this.root);
    for (const dir of [this.objectsDir, this.tmpDir]) {
      if ((await lstat(dir)).isSymbolicLink()) throw new LibraryError('PATH_VIOLATION', `Library storage folder ${path.basename(dir)} is a link; refusing to use it`);
      await this.assertInside(dir);
    }
  }

  private async assertInside(p: string): Promise<void> {
    const real = await realpath(p);
    if (!this.realRoot || !isWithin(this.realRoot, real)) {
      throw new LibraryError('PATH_VIOLATION', 'A library storage folder resolves outside the library directory');
    }
  }

  static storageKeyFor(sha256: string, extension: string): string {
    if (!SHA256_HEX.test(sha256)) throw new LibraryError('INTERNAL', 'Invalid content hash');
    const key = `objects/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${extension}`;
    if (!STORAGE_KEY.test(key)) throw new LibraryError('INTERNAL', `Unsupported attachment extension "${extension}"`);
    return key;
  }

  /** Absolute path for a storage key; refuses anything that is not a well-formed key. */
  resolve(storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) throw new LibraryError('PATH_VIOLATION', 'Invalid storage key');
    const abs = path.join(this.root, ...storageKey.split('/'));
    if (!isWithin(this.root, abs)) throw new LibraryError('PATH_VIOLATION', 'Invalid storage key');
    return abs;
  }

  /** Write a stream (or bytes) to a new temporary file, hashing it; stops at `maxBytes`. */
  async writeTemp(source: AsyncIterable<Uint8Array> | Uint8Array, maxBytes: number, signal?: AbortSignal): Promise<TempFile> {
    const tmp = path.join(this.tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.part`);
    const handle = await open(tmp, 'wx', 0o600);
    const digest = new StreamDigest();
    let ok = false;
    try {
      const chunks: AsyncIterable<Uint8Array> | Uint8Array[] = source instanceof Uint8Array ? [source] : source;
      for await (const chunk of chunks) {
        if (signal?.aborted) throw new LibraryCancelledError();
        if (digest.size + chunk.byteLength > maxBytes) {
          throw new LibraryError('PAYLOAD_TOO_LARGE', `The file is larger than the ${formatBytes(maxBytes)} limit`);
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      if (digest.size === 0) throw new LibraryError('BAD_REQUEST', 'The file is empty');
      await handle.sync();
      ok = true;
    } finally {
      await handle.close();
      if (!ok) await rm(tmp, { force: true });
    }
    return { path: tmp, sha256: digest.digest(), size: digest.size, head: digest.head, tail: digest.tail };
  }

  readTemp(temp: TempFile): Promise<Buffer> {
    return readFile(temp.path);
  }

  async discard(temp: TempFile): Promise<void> {
    await rm(temp.path, { force: true });
  }

  /**
   * Move a temporary file to its content address. When an object with the same
   * hash exists, the temporary file is dropped and the object reused. Callers
   * serialise commits and removals of the same hash.
   */
  async commit(temp: TempFile, extension: string): Promise<{ storageKey: string; created: boolean }> {
    const storageKey = AttachmentStorage.storageKeyFor(temp.sha256, extension);
    const target = this.resolve(storageKey);
    const dir = path.dirname(target);
    // The two hash-prefix folders must be real folders inside the store, not links elsewhere.
    // Each is checked before anything is created inside it.
    for (const d of [path.dirname(dir), dir]) {
      const st = await lstat(d).catch(() => null);
      if (!st) await mkdir(d, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
      const now = st ?? (await lstat(d));
      if (now.isSymbolicLink() || !now.isDirectory()) {
        throw new LibraryError('PATH_VIOLATION', 'A library storage folder is a link or not a folder; refusing to write through it');
      }
      await this.assertInside(d);
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isFile() && existing.size === temp.size) {
      await this.discard(temp);
      return { storageKey, created: false };
    }
    if (existing) await rm(target, { force: true }); // a link or a damaged copy is replaced, never followed
    await rename(temp.path, target);
    return { storageKey, created: true };
  }

  /** Whether the object exists as a regular file. */
  async exists(storageKey: string): Promise<boolean> {
    const st = await lstat(this.resolve(storageKey)).catch(() => null);
    return !!st?.isFile();
  }

  async open(storageKey: string): Promise<{ stream: ReadStream; size: number }> {
    const abs = this.resolve(storageKey);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) throw new LibraryError('NOT_FOUND', 'The stored file is missing');
    return { stream: createReadStream(abs), size: st.size };
  }

  async readBytes(storageKey: string): Promise<Buffer> {
    const abs = this.resolve(storageKey);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) throw new LibraryError('NOT_FOUND', 'The stored file is missing');
    return readFile(abs);
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.resolve(storageKey)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  /** Delete every temporary file (left by interrupted imports). */
  async sweepTmp(olderThanMs = 0): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.tmpDir).catch(() => [] as string[])) {
      const p = path.join(this.tmpDir, name);
      const st = await lstat(p).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < olderThanMs) continue;
      await rm(p, { force: true, recursive: true });
      removed++;
    }
    return removed;
  }

  /** Storage keys of all objects (well-formed names only; anything else is reported as a stray). */
  async listObjects(): Promise<{ keys: string[]; strays: string[] }> {
    const keys: string[] = [];
    const strays: string[] = [];
    for (const a of await readdir(this.objectsDir).catch(() => [] as string[])) {
      const da = path.join(this.objectsDir, a);
      const sa = await lstat(da);
      if (!sa.isDirectory()) {
        strays.push(`objects/${a}`);
        continue;
      }
      for (const b of await readdir(da)) {
        const db = path.join(da, b);
        const sb = await lstat(db);
        if (!sb.isDirectory()) {
          strays.push(`objects/${a}/${b}`);
          continue;
        }
        for (const f of await readdir(db)) {
          const key = `objects/${a}/${b}/${f}`;
          if (STORAGE_KEY.test(key) && f.startsWith(`${a}${b}`) && (await lstat(path.join(db, f))).isFile()) keys.push(key);
          else strays.push(key);
        }
      }
    }
    return { keys, strays };
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
