import { ExtractionCancelledError, ExtractionError } from '../../errors/extraction-errors';
import { Semaphore, sleep } from '../../pipeline/concurrency';
import { checkServiceUrl, grobidFormFields, type GrobidConfiguration } from './grobid-configuration';
import { parseGrobidVersion, type GrobidHealth } from './grobid-health';

export interface GrobidResult {
  tei: string;
  version: string | null;
  attempts: number;
}

export interface GrobidClientOptions {
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  now?: () => Date;
}

const SOURCE = 'grobid';

/** Read a response body as text, refusing more than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ExtractionError('invalid-output', 'GROBID answered with more data than the processing limit', SOURCE, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function shorten(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Client for a GROBID service (`/api/isalive`, `/api/version`,
 * `/api/processFulltextDocument`). Requests are bounded by a semaphore,
 * each has a timeout and follows the caller's `AbortSignal`. 503 (all GROBID
 * threads busy), refused connections and timeouts are retried a bounded
 * number of times; 204, 400 and 500 are permanent and not retried.
 */
export class GrobidClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly semaphore: Semaphore;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;
  private cachedVersion: string | null = null;

  constructor(
    readonly config: GrobidConfiguration,
    options: GrobidClientOptions = {},
  ) {
    this.baseUrl = checkServiceUrl(config.baseUrl, config.allowRemote, 'GROBID');
    this.fetchFn = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.semaphore = new Semaphore(config.concurrency);
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  get remote(): boolean {
    return this.config.allowRemote && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(this.baseUrl).hostname);
  }

  private async get(path: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.fetchFn(`${this.baseUrl}${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
  }

  async health(signal?: AbortSignal): Promise<GrobidHealth> {
    const base = { host: new URL(this.baseUrl).host, remote: this.remote, checkedAt: this.now().toISOString() };
    try {
      const alive = await this.get('/api/isalive', 5_000, signal);
      const body = (await readCapped(alive, 4096)).trim();
      if (alive.status === 503 || body === 'false') return { ...base, status: 'initialising', version: null, message: 'GROBID is starting' };
      if (!alive.ok) return { ...base, status: 'unavailable', version: null, message: `GROBID answered HTTP ${alive.status}` };
      const version = await this.version(signal).catch(() => null);
      return { ...base, status: 'available', version, message: null };
    } catch (err) {
      const message = err instanceof Error && err.name === 'TimeoutError' ? 'GROBID did not answer in time' : 'GROBID is not reachable';
      return { ...base, status: 'unavailable', version: null, message };
    }
  }

  async version(signal?: AbortSignal): Promise<string | null> {
    const res = await this.get('/api/version', 5_000, signal);
    if (!res.ok) return null;
    this.cachedVersion = parseGrobidVersion(await readCapped(res, 4096));
    return this.cachedVersion;
  }

  /** Full-text extraction to TEI with coordinates. */
  async processFulltext(pdf: Uint8Array, signal: AbortSignal): Promise<GrobidResult> {
    return this.semaphore.run(async () => {
      let attempt = 0;
      let timeouts = 0;
      for (;;) {
        if (signal.aborted) throw new ExtractionCancelledError(SOURCE);
        attempt++;
        try {
          const tei = await this.once(pdf, signal);
          const version = this.cachedVersion ?? (await this.version(signal).catch(() => null));
          return { tei, version, attempts: attempt };
        } catch (err) {
          if (signal.aborted) throw new ExtractionCancelledError(SOURCE);
          if (!(err instanceof ExtractionError) || !err.retryable || attempt > this.config.maxRetries) throw err;
          // A timeout on a large document is retried once; anything slower is not going to finish.
          if (err.code === 'timeout' && ++timeouts > 1) throw err;
          const delay = err.code === 'overloaded' ? this.config.busyRetryDelayMs : Math.min(30_000, 500 * 2 ** (attempt - 1));
          await sleep(delay, signal).catch(() => {
            throw new ExtractionCancelledError(SOURCE);
          });
        }
      }
    }, signal);
  }

  private async once(pdf: Uint8Array, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('input', new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'document.pdf');
    for (const [k, v] of grobidFormFields(this.config)) form.append(k, v);
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/processFulltextDocument`, {
        method: 'POST',
        body: form,
        headers: { accept: 'application/xml' },
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      });
    } catch (err) {
      if (signal.aborted) throw new ExtractionCancelledError(SOURCE);
      if (timeout.aborted) throw new ExtractionError('timeout', `GROBID did not finish within ${Math.round(this.config.timeoutMs / 1000)} s`, SOURCE);
      throw new ExtractionError('unavailable', `GROBID is not reachable${err instanceof Error && err.message ? ` (${shorten(err.message)})` : ''}`, SOURCE);
    }
    let body: string;
    try {
      body = await readCapped(response, this.maxResponseBytes);
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      if (signal.aborted) throw new ExtractionCancelledError(SOURCE);
      if (timeout.aborted) throw new ExtractionError('timeout', 'GROBID did not finish sending its answer in time', SOURCE);
      throw new ExtractionError('unavailable', 'The connection to GROBID broke while reading its answer', SOURCE);
    }
    switch (response.status) {
      case 200:
        if (!body.trim()) throw new ExtractionError('empty', 'GROBID returned an empty document', SOURCE);
        return body;
      case 204:
        throw new ExtractionError('empty', 'GROBID processed the PDF but could not extract or structure any content', SOURCE);
      case 400:
        throw new ExtractionError('unsupported', `GROBID refused the request${body ? `: ${shorten(body)}` : ''}`, SOURCE);
      case 500:
        throw new ExtractionError('extractor-error', `GROBID failed on this document${body ? `: ${shorten(body)}` : ''}`, SOURCE);
      case 503:
        throw new ExtractionError('overloaded', 'GROBID is busy (all its threads are in use)', SOURCE);
      default:
        throw new ExtractionError(response.status >= 500 ? 'unavailable' : 'extractor-error', `GROBID answered HTTP ${response.status}`, SOURCE, response.status >= 502);
    }
  }
}
