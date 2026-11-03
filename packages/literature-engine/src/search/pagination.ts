/**
 * Search cursors refer to state kept by the engine: each provider's next
 * position, works already fetched but not yet returned, and the keys of works
 * already returned (so a later page never repeats an earlier one). Cursors are
 * random, expire, and are single-use.
 */

export interface CursorStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class LiteratureRequestError extends Error {
  override name = 'LiteratureRequestError';
}

function randomId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export class CursorStore<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CursorStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.maxEntries = options.maxEntries ?? 200;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  put(value: T): string {
    this.sweep();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const id = randomId();
    this.entries.set(id, { value, expires: this.now() + this.ttlMs });
    return id;
  }

  /** Take (and remove) a cursor's state; throws when unknown or expired. */
  take(id: string): T {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (!entry || entry.expires <= this.now()) throw new LiteratureRequestError('This page of results has expired. Run the search again.');
    return entry.value;
  }

  sweep(): void {
    const now = this.now();
    for (const [id, e] of this.entries) if (e.expires <= now) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
