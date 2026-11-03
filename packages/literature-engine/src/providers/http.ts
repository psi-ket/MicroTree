import type { LiteratureProviderId } from '@research-studio/shared-types';
import { isAbortError, LiteratureProviderError, type ProviderErrorKind } from '../errors/provider-errors';

/** What the runtime learns from each finished request (for provider health). */
export interface HttpObservation {
  provider: LiteratureProviderId;
  ok: boolean;
  status: number | null;
  error: ProviderErrorKind | null;
  message: string | null;
  /** Rate-limit headers the provider sent, by lower-case name. */
  rateLimit: Record<string, string> | null;
  at: string;
}

export interface ProviderHttpOptions {
  provider: LiteratureProviderId;
  fetch?: typeof fetch;
  userAgent: string;
  /** Minimum time between requests. */
  minIntervalMs: number;
  /** `start`: spacing between request starts; `end`: after the previous response (arXiv). */
  spacing?: 'start' | 'end';
  maxConcurrent: number;
  /** Per attempt. */
  timeoutMs: number;
  /** Retries for 429, 5xx, timeouts and network errors (never for other statuses). */
  maxRetries?: number;
  backoffBaseMs?: number;
  /** A provider asking us to wait longer than this fails the request instead of blocking it. */
  maxRetryWaitMs?: number;
  maxResponseBytes?: number;
  /** Query parameters removed from URLs before they are logged, stored or shown. */
  secretParams?: string[];
  /** Response headers worth keeping (lower case). */
  rateLimitHeaders?: string[];
  onObservation?: (o: HttpObservation) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Request URL with secrets removed. */
  url: string;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * FIFO gate enforcing a provider's concurrency and request spacing. Waiting
 * callers leave the queue when their signal aborts.
 */
export class RateGate {
  private active = 0;
  private nextStart = 0;
  private readonly waiting: { resolve: () => void; reject: (e: unknown) => void; signal: AbortSignal; onAbort: () => void }[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
    private readonly spacing: 'start' | 'end',
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>,
    private readonly now: () => number,
  ) {}

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const i = this.waiting.indexOf(entry);
            if (i >= 0) this.waiting.splice(i, 1);
            reject(signal.reason);
          },
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
        this.waiting.push(entry);
      });
    } else {
      this.active++;
    }
    // The slot is ours: `release` hands it to the next waiter or frees it.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.spacing === 'end') this.nextStart = Math.max(this.nextStart, this.now() + this.minIntervalMs);
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.resolve();
      } else {
        this.active--;
      }
    };
    const now = this.now();
    const start = Math.max(now, this.nextStart);
    if (this.spacing === 'start') this.nextStart = start + this.minIntervalMs;
    try {
      if (start > now) await this.sleep(start - now, signal);
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class ProviderHttp {
  readonly provider: LiteratureProviderId;
  private readonly gate: RateGate;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: ProviderHttpOptions) {
    this.provider = options.provider;
    this.doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    this.gate = new RateGate(options.maxConcurrent, options.minIntervalMs, options.spacing ?? 'start', this.sleep, this.now);
  }

  /** Remove credentials and contact details from a URL. */
  redact(url: string): string {
    try {
      const u = new URL(url);
      for (const p of this.options.secretParams ?? []) if (u.searchParams.has(p)) u.searchParams.delete(p);
      return u.toString();
    } catch {
      return url.replace(/([?&](?:api_key|mailto|key)=)[^&#]*/gi, '$1…');
    }
  }

  private fail(kind: ProviderErrorKind, message: string, status: number | null = null, retryAfterMs: number | null = null): LiteratureProviderError {
    return new LiteratureProviderError(this.provider, kind, message, status, retryAfterMs);
  }

  private observe(ok: boolean, status: number | null, headers: Headers | null, error: LiteratureProviderError | null): void {
    if (!this.options.onObservation) return;
    let rateLimit: Record<string, string> | null = null;
    if (headers) {
      for (const name of this.options.rateLimitHeaders ?? []) {
        const v = headers.get(name);
        if (v !== null) (rateLimit ??= {})[name] = v;
      }
    }
    try {
      this.options.onObservation({
        provider: this.provider,
        ok,
        status,
        error: error?.kind ?? null,
        message: error?.message ?? null,
        rateLimit,
        at: new Date(this.now()).toISOString(),
      });
    } catch {
      /* observers must not break requests */
    }
  }

  private async readBody(response: Response): Promise<string> {
    const limit = this.options.maxResponseBytes ?? 8 * 1024 * 1024;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      // Cancelling is cleanup only; the error must not wait for it.
      void response.body?.cancel().catch(() => undefined);
      throw this.fail('invalid_response', `response is larger than ${Math.round(limit / 1024 / 1024)} MB`, response.status);
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw this.fail('invalid_response', `response is larger than ${Math.round(limit / 1024 / 1024)} MB`, response.status);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  /**
   * GET with rate gating, timeout, retries and cancellation. Statuses in
   * `acceptStatuses` (e.g. 404 for lookups) are returned instead of thrown.
   */
  async get(url: string, opts: { signal: AbortSignal; headers?: Record<string, string>; acceptStatuses?: number[] }): Promise<HttpResponse> {
    const maxRetries = this.options.maxRetries ?? 2;
    const base = this.options.backoffBaseMs ?? 1000;
    const maxWait = this.options.maxRetryWaitMs ?? 30_000;
    const shown = this.redact(url);
    let lastError: LiteratureProviderError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = lastError?.retryAfterMs ?? base * 2 ** (attempt - 1) + Math.floor(Math.random() * base * 0.25);
        if (wait > maxWait) break;
        try {
          await this.sleep(wait, opts.signal);
        } catch {
          throw this.fail('cancelled', 'request cancelled');
        }
      }
      let release: () => void;
      try {
        release = await this.gate.acquire(opts.signal);
      } catch {
        throw this.fail('cancelled', 'request cancelled');
      }
      const timeout = AbortSignal.timeout(this.options.timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeout]);
      let response: Response;
      try {
        response = await this.doFetch(url, {
          method: 'GET',
          headers: { 'user-agent': this.options.userAgent, accept: 'application/json, application/atom+xml;q=0.9, */*;q=0.5', ...opts.headers },
          signal,
          redirect: 'follow',
        });
      } catch (err) {
        release();
        if (opts.signal.aborted) throw this.fail('cancelled', 'request cancelled');
        lastError = timeout.aborted || isAbortError(err)
          ? this.fail('timeout', `no response within ${Math.round(this.options.timeoutMs / 1000)} s`)
          : this.fail('network', 'could not connect');
        continue;
      }

      let text: string;
      try {
        text = await this.readBody(response);
      } catch (err) {
        release();
        if (opts.signal.aborted) throw this.fail('cancelled', 'request cancelled');
        if (err instanceof LiteratureProviderError) {
          this.observe(false, response.status, response.headers, err);
          throw err;
        }
        lastError = timeout.aborted ? this.fail('timeout', 'the response took too long') : this.fail('network', 'the connection was interrupted');
        continue;
      }
      release();

      const status = response.status;
      if ((status >= 200 && status < 300) || opts.acceptStatuses?.includes(status)) {
        this.observe(true, status, response.headers, null);
        return { status, headers: response.headers, text, url: shown };
      }
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      if (status === 429) {
        lastError = this.fail('rate_limited', 'rate limit reached; try again later', status, retryAfter);
        continue;
      }
      if (status >= 500) {
        lastError = this.fail('unavailable', `service unavailable (HTTP ${status})`, status, retryAfter);
        continue;
      }
      const error =
        status === 401 || status === 403
          ? this.fail('unauthorized', `the request was refused (HTTP ${status}); check the API key`, status)
          : this.fail('bad_request', `request rejected (HTTP ${status})`, status);
      this.observe(false, status, response.headers, error);
      throw error;
    }
    const error = lastError ?? this.fail('network', 'request failed');
    this.observe(false, error.status, null, error);
    throw error;
  }

  async getJson(url: string, opts: { signal: AbortSignal; headers?: Record<string, string>; acceptStatuses?: number[] }): Promise<{ status: number; data: unknown; url: string; headers: Headers }> {
    const res = await this.get(url, opts);
    if (res.status === 404 && opts.acceptStatuses?.includes(404)) return { status: 404, data: null, url: res.url, headers: res.headers };
    try {
      return { status: res.status, data: JSON.parse(res.text) as unknown, url: res.url, headers: res.headers };
    } catch {
      throw this.fail('invalid_response', 'the response was not valid JSON', res.status);
    }
  }
}
