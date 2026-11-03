import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZoteroItem, ZoteroItemData } from '../../src/integrations/zotero/zotero-mapper';

/**
 * A small stand-in for the Zotero web API v3 (as documented at
 * https://www.zotero.org/support/dev/web_api/v3/): API-key check, paging with
 * Total-Results, Last-Modified-Version, ?itemKey=, ?since=, file downloads
 * with an MD5 ETag, creation with Zotero-Write-Token, updates with
 * If-Unmodified-Since-Version (412 on mismatch), and 429/Retry-After.
 */
export class MockZotero {
  readonly userId = '4242';
  readonly apiKey = 'TestKeyNotRealAbc0123456';
  version = 10;
  items = new Map<string, ZoteroItem>();
  collections = new Map<string, { key: string; version: number; data: { key: string; name: string; parentCollection: string | false } }>();
  files = new Map<string, Buffer>();
  requests: string[] = [];
  /** Answer the next N requests with 429. */
  rateLimitNext = 0;
  writeTokens = new Set<string>();
  canWrite = true;
  private server: http.Server | null = null;
  private keyCounter = 0;
  baseUrl = '';

  newKey(): string {
    return `K${String(++this.keyCounter).padStart(7, '0')}`;
  }

  addItem(data: Omit<ZoteroItemData, 'key' | 'version'>, key = this.newKey()): ZoteroItem {
    this.version++;
    const item = { key, version: this.version, data: { ...data, key, version: this.version } as ZoteroItemData };
    this.items.set(key, item);
    return item;
  }

  editItem(key: string, patch: Partial<ZoteroItemData>): void {
    const item = this.items.get(key)!;
    this.version++;
    item.version = this.version;
    item.data = { ...item.data, ...patch, version: this.version };
  }

  addCollection(name: string, parent: string | false = false): string {
    const key = this.newKey();
    this.version++;
    this.collections.set(key, { key, version: this.version, data: { key, name, parentCollection: parent } });
    return key;
  }

  addPdf(parentKey: string, bytes: Buffer, filename = 'paper.pdf'): string {
    const item = this.addItem({ itemType: 'attachment', parentItem: parentKey, linkMode: 'imported_file', contentType: 'application/pdf', filename, md5: createHash('md5').update(bytes).digest('hex') });
    this.files.set(item.key, bytes);
    return item.key;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body?: unknown, headers: Record<string, string | number> = {}) => {
      res.writeHead(status, { 'Last-Modified-Version': this.version, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers });
      res.end(body !== undefined ? JSON.stringify(body) : undefined);
    };
    if (req.headers['zotero-api-version'] !== '3') return send(400, { error: 'API version 3 expected' });
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return send(429, undefined, { 'Retry-After': 0 });
    }
    if (req.headers['zotero-api-key'] !== this.apiKey) return send(403, undefined);
    let body = '';
    for await (const chunk of req) body += chunk;

    if (url.pathname === '/keys/current') {
      return send(200, { key: 'hidden', userID: Number(this.userId), username: 'tester', access: { user: { library: true, files: true, notes: true, write: this.canWrite } } });
    }
    const m = /^\/users\/(\d+)\/(collections|items)(?:\/([A-Z0-9]+))?(?:\/(items|file))?$/.exec(url.pathname);
    if (!m || m[1] !== this.userId) return send(404);
    const [, , kind, key, sub] = m;

    if (kind === 'collections' && !key && req.method === 'GET') return this.page(url, [...this.collections.values()], send);
    if (kind === 'collections' && key && sub === 'items') {
      return this.page(url, [...this.items.values()].filter((i) => i.data.collections?.includes(key) || (i.data.parentItem && this.items.get(i.data.parentItem)?.data.collections?.includes(key))), send);
    }
    if (kind === 'items' && !key && req.method === 'GET') {
      let list = [...this.items.values()];
      const keys = url.searchParams.get('itemKey');
      if (keys) list = list.filter((i) => keys.split(',').includes(i.key));
      const since = Number(url.searchParams.get('since') ?? 0);
      if (since) list = list.filter((i) => i.version > since);
      return this.page(url, list, send);
    }
    if (kind === 'items' && key && sub === 'file') {
      const file = this.files.get(key);
      if (!file) return send(404);
      res.writeHead(200, { 'Content-Type': 'application/pdf', ETag: `"${createHash('md5').update(file).digest('hex')}"`, 'Content-Length': file.length });
      return res.end(file);
    }
    if (kind === 'items' && !key && req.method === 'POST') {
      if (!this.canWrite) return send(403);
      const token = String(req.headers['zotero-write-token'] ?? '');
      if (token.length !== 32) return send(400, { error: 'Write token expected' });
      if (this.writeTokens.has(token)) return send(412);
      this.writeTokens.add(token);
      const created = JSON.parse(body) as ZoteroItemData[];
      const successful: Record<string, { key: string; version: number }> = {};
      const failed: Record<string, { code: number; message: string }> = {};
      created.forEach((data, i) => {
        if (!data.title) {
          failed[i] = { code: 400, message: 'title is required by this mock' };
          return;
        }
        const item = this.addItem(data);
        successful[i] = { key: item.key, version: item.version };
      });
      return send(200, { successful, success: Object.fromEntries(Object.entries(successful).map(([i, v]) => [i, v.key])), unchanged: {}, failed });
    }
    if (kind === 'items' && key && req.method === 'PATCH') {
      const item = this.items.get(key);
      if (!item) return send(404);
      if (Number(req.headers['if-unmodified-since-version']) !== item.version) return send(412);
      this.editItem(key, JSON.parse(body) as Partial<ZoteroItemData>);
      return send(204, undefined);
    }
    return send(404);
  }

  private page(url: URL, list: unknown[], send: (s: number, b?: unknown, h?: Record<string, string | number>) => void) {
    const start = Number(url.searchParams.get('start') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 100);
    return send(200, list.slice(start, start + limit), { 'Total-Results': list.length });
  }
}
