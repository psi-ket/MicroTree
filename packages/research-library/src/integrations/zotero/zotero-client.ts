import { randomBytes } from 'node:crypto';
import type { ZoteroMode } from '@research-studio/shared-types';
import { LibraryCancelledError, LibraryError } from '../../errors/library-errors';
import type { ZoteroItem, ZoteroItemData } from './zotero-mapper';

/**
 * Zotero API client (API version 3).
 *
 * - Web API (`https://api.zotero.org`): read and write; the API key is kept
 *   by the runtime and sent only to Zotero, never to the browser.
 * - Local API (Zotero 7+ desktop, `http://localhost:23119/api`, user ID 0):
 *   read-only here; it must be enabled in Zotero's settings.
 *
 * Paging uses `limit`/`start` with `Total-Results`; versions come from
 * `Last-Modified-Version`. `Backoff`, 429 and 503 (`Retry-After`) make the
 * client wait and retry. Writes use `Zotero-Write-Token` (creation) or
 * `If-Unmodified-Since-Version` (updates); 412 means the item changed in
 * Zotero since it was last read.
 */

export interface ZoteroClientOptions {
  mode: ZoteroMode;
  baseUrl: string;
  apiKey?: string | null;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Upper bound on one wait for Backoff/Retry-After, in seconds. */
  maxWaitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface ZoteroKeyInfo {
  userId: string;
  username: string | null;
  canRead: boolean;
  canWrite: boolean;
  canReadFiles: boolean;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: { key: string; name: string; parentCollection: string | false };
  meta?: { numItems?: number };
}

export interface ZoteroWriteResult {
  successful: Record<string, { key: string; version: number }>;
  unchanged: Record<string, string>;
  failed: Record<string, { code: number; message: string }>;
}

const PAGE = 100;
const WRITE_BATCH = 50;
const MAX_ITEMS = 50_000;
const MAX_ATTEMPTS = 4;

export class ZoteroHttpError extends LibraryError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(status === 403 || status === 401 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 412 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', message, {
      status,
    });
  }
}

export class ZoteroClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private backoffUntil = 0;

  constructor(private readonly opts: ZoteroClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.mode === 'local') {
      const u = new URL(opts.baseUrl);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new LibraryError('VALIDATION_FAILED', 'The Zotero local API must be on this computer');
    }
  }

  get mode(): ZoteroMode {
    return this.opts.mode;
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.href;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Zotero-API-Version': '3', 'User-Agent': this.opts.userAgent ?? 'ResearchStudio', ...extra };
    if (this.opts.apiKey) h['Zotero-API-Key'] = this.opts.apiKey;
    return h;
  }

  private async request(method: string, path: string, init: { query?: Record<string, string | number | undefined>; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      if (init.signal?.aborted) throw new LibraryCancelledError();
      const wait = this.backoffUntil - Date.now();
      if (wait > 0) await this.sleep(wait);
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchFn(this.url(path, init.query), { method, headers: this.headers(init.headers), body: init.body, signal, redirect: 'follow' });
      } catch (err) {
        if (init.signal?.aborted) throw new LibraryCancelledError();
        const local = this.opts.mode === 'local';
        throw new LibraryError(
          'PROVIDER_ERROR',
          local ? 'Zotero is not answering on this computer. Start Zotero and enable "Allow other applications on this computer to communicate with Zotero" in its settings.' : `Zotero could not be reached: ${(err as Error).message}`,
        );
      }
      const backoff = Number(res.headers.get('Backoff'));
      const maxWait = (this.opts.maxWaitSeconds ?? 60) * 1000;
      if (Number.isFinite(backoff) && backoff > 0) this.backoffUntil = Date.now() + Math.min(backoff * 1000, maxWait);
      if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
        const retry = Number(res.headers.get('Retry-After'));
        await res.body?.cancel();
        await this.sleep(Math.min((Number.isFinite(retry) && retry > 0 ? retry : 2 ** attempt) * 1000, maxWait));
        continue;
      }
      return res;
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => '')).slice(0, 300).trim();
    const reason =
      res.status === 403
        ? this.opts.mode === 'web'
          ? 'the API key does not allow this'
          : 'Zotero refused the request'
        : res.status === 412
          ? 'the item changed in Zotero since it was last read'
          : res.status === 429
            ? 'Zotero asks to slow down; try again later'
            : text || `HTTP ${res.status}`;
    throw new ZoteroHttpError(res.status, `${what} failed: ${reason}`);
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) await this.fail(res, what);
    return (await res.json()) as T;
  }

  /** Web API: who the key belongs to and what it may do. */
  async keyInfo(signal?: AbortSignal): Promise<ZoteroKeyInfo> {
    if (this.opts.mode !== 'web') throw new LibraryError('BAD_REQUEST', 'Only the web API uses keys');
    if (!this.opts.apiKey) throw new LibraryError('NOT_CONFIGURED', 'No Zotero API key is stored');
    const res = await this.request('GET', '/keys/current', { signal });
    const body = await this.json<{ userID: number; username?: string; access?: { user?: { library?: boolean; write?: boolean; files?: boolean } } }>(res, 'Checking the Zotero key');
    const user = body.access?.user ?? {};
    return { userId: String(body.userID), username: body.username ?? null, canRead: !!user.library, canWrite: !!user.write, canReadFiles: !!user.files };
  }

  /** Local API: whether Zotero answers. */
  async ping(signal?: AbortSignal): Promise<boolean> {
    const res = await this.request('GET', '/users/0/items', { query: { limit: 1 }, signal });
    await res.body?.cancel();
    return res.ok;
  }

  private async paged<T>(path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<{ items: T[]; version: number | null }> {
    const items: T[] = [];
    let version: number | null = null;
    for (let start = 0; start < MAX_ITEMS; start += PAGE) {
      const res = await this.request('GET', path, { query: { ...query, limit: PAGE, start, format: 'json' }, signal });
      if (res.status === 304) return { items: [], version: Number(res.headers.get('Last-Modified-Version')) || null };
      const page = await this.json<T[]>(res, 'Reading from Zotero');
      version ??= Number(res.headers.get('Last-Modified-Version')) || null;
      items.push(...page);
      const total = Number(res.headers.get('Total-Results'));
      if (page.length < PAGE || (Number.isFinite(total) && start + PAGE >= total)) break;
    }
    return { items, version };
  }

  collections(userId: string, signal?: AbortSignal) {
    return this.paged<ZoteroCollection>(`/users/${encodeURIComponent(userId)}/collections`, {}, signal);
  }

  /** All items (including child attachments) changed since `since`, or in one collection. */
  items(userId: string, options: { since?: number; collectionKey?: string } = {}, signal?: AbortSignal) {
    const path = options.collectionKey
      ? `/users/${encodeURIComponent(userId)}/collections/${encodeURIComponent(options.collectionKey)}/items`
      : `/users/${encodeURIComponent(userId)}/items`;
    return this.paged<ZoteroItem>(path, { since: options.since }, signal);
  }

  /** Items by key (current versions), for checking remote changes before writing. */
  async itemsByKey(userId: string, keys: readonly string[], signal?: AbortSignal): Promise<ZoteroItem[]> {
    const out: ZoteroItem[] = [];
    for (let i = 0; i < keys.length; i += WRITE_BATCH) {
      const res = await this.request('GET', `/users/${encodeURIComponent(userId)}/items`, { query: { itemKey: keys.slice(i, i + WRITE_BATCH).join(','), format: 'json' }, signal });
      out.push(...(await this.json<ZoteroItem[]>(res, 'Reading from Zotero')));
    }
    return out;
  }

  /**
   * An attachment's file. Web: the body (Zotero redirects to its file
   * storage); the ETag is the file's MD5. Local: Zotero answers with a
   * `file:` link to its storage folder, returned as `localPath`.
   */
  async file(userId: string, itemKey: string, signal?: AbortSignal): Promise<{ body: AsyncIterable<Uint8Array>; md5: string | null } | { localPath: string }> {
    const path = `/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(itemKey)}/file`;
    if (this.opts.mode === 'local') {
      const res = await this.fetchFn(this.url(path), { headers: this.headers(), redirect: 'manual', signal: signal ?? null });
      const location = res.headers.get('Location');
      await res.body?.cancel();
      if (res.status >= 300 && res.status < 400 && location?.startsWith('file:')) return { localPath: location };
      if (!res.ok) await this.fail(res, 'Reading the attachment');
      throw new LibraryError('PROVIDER_ERROR', 'Zotero did not return a file location');
    }
    const res = await this.request('GET', path, { signal });
    if (!res.ok || !res.body) await this.fail(res, 'Downloading the attachment');
    const etag = res.headers.get('ETag')?.replace(/"/g, '') ?? null;
    return { body: res.body as unknown as AsyncIterable<Uint8Array>, md5: etag && /^[0-9a-f]{32}$/i.test(etag) ? etag.toLowerCase() : null };
  }

  private requireWeb() {
    if (this.opts.mode !== 'web') throw new LibraryError('BAD_REQUEST', 'Exporting to Zotero uses the web API; the local API is read-only here');
    if (!this.opts.apiKey) throw new LibraryError('NOT_CONFIGURED', 'No Zotero API key is stored');
  }

  /** Create items, 50 per request, each request with its own write token (safe to retry). */
  async createItems(userId: string, items: ZoteroItemData[], signal?: AbortSignal): Promise<ZoteroWriteResult> {
    this.requireWeb();
    const merged: ZoteroWriteResult = { successful: {}, unchanged: {}, failed: {} };
    for (let i = 0; i < items.length; i += WRITE_BATCH) {
      const batch = items.slice(i, i + WRITE_BATCH);
      const res = await this.request('POST', `/users/${encodeURIComponent(userId)}/items`, {
        headers: { 'Content-Type': 'application/json', 'Zotero-Write-Token': randomBytes(16).toString('hex') },
        body: JSON.stringify(batch),
        signal,
      });
      const body = await this.json<{
        successful?: Record<string, { key: string; version: number }>;
        unchanged?: Record<string, string>;
        failed?: Record<string, { code: number; message: string }>;
      }>(res, 'Creating items in Zotero');
      for (const [k, v] of Object.entries(body.successful ?? {})) merged.successful[String(i + Number(k))] = { key: v.key, version: v.version };
      for (const [k, v] of Object.entries(body.unchanged ?? {})) merged.unchanged[String(i + Number(k))] = v;
      for (const [k, v] of Object.entries(body.failed ?? {})) merged.failed[String(i + Number(k))] = v;
    }
    return merged;
  }

  /** Update one item if it has not changed in Zotero since `version`; returns the new version. */
  async updateItem(userId: string, key: string, data: Partial<ZoteroItemData>, version: number, signal?: AbortSignal): Promise<number> {
    this.requireWeb();
    const res = await this.request('PATCH', `/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(key)}`, {
      headers: { 'Content-Type': 'application/json', 'If-Unmodified-Since-Version': String(version) },
      body: JSON.stringify(data),
      signal,
    });
    if (res.status !== 204 && !res.ok) await this.fail(res, 'Updating the Zotero item');
    await res.body?.cancel();
    return Number(res.headers.get('Last-Modified-Version')) || version;
  }
}
