import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RESERVED_TOP_LEVEL } from '@research-studio/document-engine';
import type { FileChange } from '@research-studio/shared-types';
import type { FastifyBaseLogger } from 'fastify';
import type { EventBus } from '../events';
import type { ProjectService } from './project-service';

/** Files up to this size are hashed, so touches without a content change are not reported. */
const HASH_LIMIT = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;
const TEMP_MARKER = '.rs-tmp-';
/** Raw watcher events are collected for this long before the project is rescanned. */
const DEBOUNCE_MS = 150;
/** Watched projects per subscriber (browser tab). */
const MAX_PER_SUBSCRIBER = 4;

interface Entry {
  size: number;
  mtimeMs: number;
  hash: string | null;
}

interface Watched {
  root: string;
  watcher: FSWatcher;
  subscribers: Set<string>;
  snapshot: Map<string, Entry>;
  /** Serialises rescans and snapshot refreshes. */
  queue: Promise<void>;
  timer: NodeJS.Timeout | null;
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Same content: equal hashes when both are known, otherwise same size and modification time. */
function same(a: Entry, b: Entry): boolean {
  if (a.hash !== null && b.hash !== null) return a.hash === b.hash;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Notices changes made to project files outside Research Studio (another
 * editor, git, a sync client) and publishes them as `files.changed` events
 * with `source: "external"`.
 *
 * A project is watched only while at least one client asks for it. Raw
 * `fs.watch` events only trigger a rescan: the rescan compares the tree with
 * a snapshot (size, modification time and, for files up to 1 MB, a content
 * hash), so the reported changes are accurate even when the platform's events
 * are coalesced, duplicated or missing a path. A file deleted and another
 * created with the same content in one batch is reported as a rename.
 *
 * The runtime's own writes are not reported again: when the runtime
 * publishes a change, the snapshot for those paths is refreshed first.
 *
 * Skipped like in the file tree: `.rs-build`, `.git`, `node_modules`, links,
 * and the runtime's temporary files.
 */
export class FileWatchService {
  private readonly watched = new Map<string, Watched>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly projects: ProjectService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
  ) {
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'files.changed' && event.source === 'runtime') this.absorb(event.projectId, event.paths);
      if (event.type === 'project.deleted') this.stop(event.projectId);
    });
  }

  isWatching(projectId: string): boolean {
    return this.watched.has(projectId);
  }

  /** Start watching for a subscriber. Resolves once the initial snapshot is taken. */
  async watch(projectId: string, subscriber: string): Promise<void> {
    const existing = this.watched.get(projectId);
    if (existing) {
      existing.subscribers.add(subscriber);
      await existing.queue;
      return;
    }
    if ([...this.watched.values()].filter((w) => w.subscribers.has(subscriber)).length >= MAX_PER_SUBSCRIBER) return;
    const { fs } = await this.projects.open(projectId);
    if (this.watched.has(projectId)) return this.watch(projectId, subscriber);
    const root = fs.root;
    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true, persistent: false });
    } catch (err) {
      this.log.warn({ err, projectId }, 'cannot watch project for external changes');
      return;
    }
    const entry: Watched = { root, watcher, subscribers: new Set([subscriber]), snapshot: new Map(), queue: Promise.resolve(), timer: null };
    this.watched.set(projectId, entry);
    watcher.on('change', (_type, name) => {
      if (name !== null && !this.relevant(String(name))) return;
      this.schedule(projectId, entry);
    });
    watcher.on('error', (err) => {
      this.log.warn({ err, projectId }, 'project watcher failed; stopped watching');
      this.stop(projectId);
    });
    entry.queue = entry.queue.then(async () => {
      entry.snapshot = await this.scan(root, new Map());
    });
    await entry.queue;
  }

  unwatch(projectId: string, subscriber: string): void {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size === 0) this.stop(projectId);
  }

  /** A subscriber went away (socket closed). */
  release(subscriber: string): void {
    for (const [projectId, entry] of this.watched) {
      if (entry.subscribers.has(subscriber)) this.unwatch(projectId, subscriber);
    }
  }

  close(): void {
    this.unsubscribe();
    for (const projectId of [...this.watched.keys()]) this.stop(projectId);
  }

  /** Rescan now instead of waiting for the debounce (tests, focus resync). */
  async flush(projectId: string): Promise<void> {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    await this.enqueue(projectId, entry, () => this.rescan(projectId, entry));
  }

  private stop(projectId: string): void {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    this.watched.delete(projectId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
  }

  /** Whether a project-relative path (from a raw event or a scan) is watched at all. */
  private relevant(raw: string): boolean {
    const segments = raw.split(/[\\/]/).filter(Boolean);
    if (!segments.length) return true;
    const top = segments[0]!.toLowerCase();
    if (RESERVED_TOP_LEVEL.has(top)) return false;
    return !segments.some((s) => s === 'node_modules' || s.includes(TEMP_MARKER));
  }

  private schedule(projectId: string, entry: Watched): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.enqueue(projectId, entry, () => this.rescan(projectId, entry));
    }, DEBOUNCE_MS);
    entry.timer.unref();
  }

  private enqueue(projectId: string, entry: Watched, task: () => Promise<void>): Promise<void> {
    entry.queue = entry.queue.then(task).catch((err: unknown) => this.log.warn({ err, projectId }, 'external change scan failed'));
    return entry.queue;
  }

  /** The runtime changed these paths itself: take them into the snapshot without reporting them. */
  private absorb(projectId: string, paths: string[]): void {
    const entry = this.watched.get(projectId);
    if (!entry) return;
    void this.enqueue(projectId, entry, async () => {
      for (const rel of paths) {
        // A folder (rename, delete) can stand for many files: drop them and re-read what is there now.
        for (const key of [...entry.snapshot.keys()]) if (key === rel || key.startsWith(`${rel}/`)) entry.snapshot.delete(key);
        const abs = path.join(entry.root, ...rel.split('/'));
        const info = await lstat(abs).catch(() => null);
        if (info?.isFile()) {
          const current = await this.entryFor(abs, info, undefined);
          if (current) entry.snapshot.set(rel, current);
        } else if (info?.isDirectory()) {
          for (const [k, v] of await this.scan(abs, new Map(), rel)) entry.snapshot.set(k, v);
        }
      }
    });
  }

  private async rescan(projectId: string, entry: Watched): Promise<void> {
    if (this.watched.get(projectId) !== entry) return;
    const next = await this.scan(entry.root, entry.snapshot);
    const added: string[] = [];
    const deleted: string[] = [];
    const changes: FileChange[] = [];
    for (const [rel, now] of next) {
      const before = entry.snapshot.get(rel);
      if (!before) added.push(rel);
      else if (!same(before, now)) changes.push({ path: rel, change: 'changed' });
    }
    for (const rel of entry.snapshot.keys()) if (!next.has(rel)) deleted.push(rel);
    // Pair deletions with additions of identical content: renames (or moves).
    // Empty files all look alike, so they are never paired.
    const unmatched = new Set(added);
    for (const from of deleted) {
      const old = entry.snapshot.get(from)!;
      const to = old.size > 0 ? [...unmatched].find((rel) => same(old, next.get(rel)!)) : undefined;
      if (to) {
        unmatched.delete(to);
        changes.push({ path: to, change: 'renamed', from });
      } else {
        changes.push({ path: from, change: 'deleted' });
      }
    }
    for (const rel of unmatched) changes.push({ path: rel, change: 'added' });
    entry.snapshot = next;
    if (!changes.length) return;
    changes.sort((a, b) => a.path.localeCompare(b.path));
    const paths = [...new Set(changes.flatMap((c) => (c.change === 'renamed' ? [c.from!, c.path] : [c.path])))];
    this.events.publish({ type: 'files.changed', projectId, paths, originSessionId: null, source: 'external', changes });
  }

  /** Files under `dir` (project paths prefixed with `prefix`). Unchanged files reuse their previous hash. */
  private async scan(dir: string, previous: Map<string, Entry>, prefix = ''): Promise<Map<string, Entry>> {
    const out = new Map<string, Entry>();
    const visit = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of entries) {
        if (out.size >= MAX_ENTRIES) return;
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        if (!this.relevant(rel)) continue;
        const abs = path.join(absDir, dirent.name);
        if (dirent.isDirectory()) {
          await visit(abs, rel, depth + 1);
        } else if (dirent.isFile()) {
          const info = await lstat(abs).catch(() => null);
          if (!info?.isFile()) continue;
          const current = await this.entryFor(abs, info, previous.get(rel));
          if (current) out.set(rel, current);
        }
      }
    };
    await visit(dir, prefix, prefix ? prefix.split('/').length : 0);
    return out;
  }

  private async entryFor(abs: string, info: { size: number; mtimeMs: number }, previous: Entry | undefined): Promise<Entry | null> {
    if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return previous;
    if (info.size > HASH_LIMIT) return { size: info.size, mtimeMs: info.mtimeMs, hash: null };
    try {
      return { size: info.size, mtimeMs: info.mtimeMs, hash: sha(await readFile(abs)) };
    } catch {
      return null;
    }
  }
}
