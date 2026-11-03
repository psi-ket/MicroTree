import { describe, expect, it } from 'vitest';
import { LiteratureProviderError } from '../src/errors/provider-errors';
import { ProviderHttp, RateGate, type HttpObservation } from '../src/providers/http';
import { fakeFetch, json } from './helpers';

function client(fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof ProviderHttp>[0]> = {}) {
  const sleeps: number[] = [];
  const observations: HttpObservation[] = [];
  const http = new ProviderHttp({
    provider: 'openalex',
    fetch,
    userAgent: 'test-agent',
    minIntervalMs: 0,
    maxConcurrent: 2,
    timeoutMs: 1000,
    backoffBaseMs: 100,
    secretParams: ['api_key', 'mailto'],
    rateLimitHeaders: ['x-ratelimit-remaining'],
    onObservation: (o) => observations.push(o),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { http, sleeps, observations };
}

const signal = () => new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<LiteratureProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LiteratureProviderError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

describe('ProviderHttp', () => {
  it('sends the user agent and returns the body with a redacted URL', async () => {
    const f = fakeFetch([[() => true, json({ ok: true }, 200, { 'x-ratelimit-remaining': '99' })]]);
    const { http, observations } = client(f.fetch);
    const res = await http.getJson('https://api.example/works?search=x&api_key=SECRET&mailto=me%40example.org', { signal: signal() });
    expect(res.data).toEqual({ ok: true });
    expect(res.url).toBe('https://api.example/works?search=x');
    expect(f.calls[0]!.headers.get('user-agent')).toBe('test-agent');
    expect(observations).toEqual([expect.objectContaining({ ok: true, status: 200, rateLimit: { 'x-ratelimit-remaining': '99' } })]);
    expect(JSON.stringify(observations)).not.toContain('SECRET');
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    let n = 0;
    const f = fakeFetch([[() => true, () => (++n < 3 ? json({}, 503) : json({ ok: 1 }))]]);
    const { http, sleeps } = client(f.fetch);
    await expect(http.getJson('https://api.example/x', { signal: signal() })).resolves.toMatchObject({ data: { ok: 1 } });
    expect(f.calls).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(126);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeLessThan(226);
  });

  it('waits as long as Retry-After asks (seconds or HTTP date)', async () => {
    let n = 0;
    const f = fakeFetch([[() => true, () => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({}))]]);
    const { http, sleeps } = client(f.fetch);
    await http.get('https://api.example/x', { signal: signal() });
    expect(sleeps).toEqual([2000]);

    let m = 0;
    const date = new Date(Date.parse('2026-11-02T12:00:05Z')).toUTCString();
    const g = fakeFetch([[() => true, () => (++m === 1 ? json({}, 503, { 'retry-after': date }) : json({}))]]);
    const second = client(g.fetch, { now: () => Date.parse('2026-11-02T12:00:00Z') });
    await second.http.get('https://api.example/x', { signal: signal() });
    expect(second.sleeps).toEqual([5000]);
  });

  it('gives up instead of blocking when Retry-After is too long', async () => {
    const f = fakeFetch([[() => true, json({}, 429, { 'retry-after': '3600' })]]);
    const { http, sleeps, observations } = client(f.fetch);
    const err = await failure(http.get('https://api.example/x', { signal: signal() }));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(err.retryable).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(observations.at(-1)).toMatchObject({ ok: false, error: 'rate_limited', status: 429 });
  });

  it('reports a rate limit after the retries run out', async () => {
    const f = fakeFetch([[() => true, json({ message: 'Too Many Requests' }, 429)]]);
    const { http } = client(f.fetch);
    const err = await failure(http.get('https://api.example/x', { signal: signal() }));
    expect(err.kind).toBe('rate_limited');
    expect(f.calls).toHaveLength(3);
  });

  it('does not retry other client errors, and names 401/403 as key problems', async () => {
    const f = fakeFetch([
      [(u) => u.pathname === '/bad', json({}, 400)],
      [(u) => u.pathname === '/key', json({}, 403)],
    ]);
    const { http } = client(f.fetch);
    expect((await failure(http.get('https://api.example/bad', { signal: signal() }))).kind).toBe('bad_request');
    const key = await failure(http.get('https://api.example/key', { signal: signal() }));
    expect(key.kind).toBe('unauthorized');
    expect(key.message).toMatch(/API key/);
    expect(f.calls).toHaveLength(2);
  });

  it('returns accepted statuses instead of throwing', async () => {
    const f = fakeFetch([[() => true, json({ error: 'nope' }, 404)]]);
    const { http } = client(f.fetch);
    await expect(http.getJson('https://api.example/x', { signal: signal(), acceptStatuses: [404] })).resolves.toMatchObject({ status: 404, data: null });
  });

  it('times out a request that never answers, and retries it', async () => {
    const f = fakeFetch([
      [
        () => true,
        ({ url }) =>
          new Promise<Response>((_, reject) => {
            void url;
            setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), 30);
          }),
      ],
    ]);
    const { http } = client(f.fetch, { timeoutMs: 20, maxRetries: 1 });
    const err = await failure(http.get('https://api.example/x', { signal: signal() }));
    expect(err.kind).toBe('timeout');
    expect(f.calls).toHaveLength(2);
  });

  it('stops at once when the caller cancels', async () => {
    const controller = new AbortController();
    const f = fakeFetch([
      [
        () => true,
        () =>
          new Promise<Response>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            setTimeout(() => controller.abort(), 5);
          }),
      ],
    ]);
    const { http } = client(f.fetch);
    const err = await failure(http.get('https://api.example/x', { signal: controller.signal }));
    expect(err.kind).toBe('cancelled');
    expect(f.calls).toHaveLength(1);
  });

  it('maps network errors and invalid JSON', async () => {
    const f = fakeFetch([
      [(u) => u.pathname === '/down', () => Promise.reject(new TypeError('fetch failed'))],
      [(u) => u.pathname === '/html', new Response('<html>', { status: 200 })],
    ]);
    const { http } = client(f.fetch, { maxRetries: 0 });
    expect((await failure(http.get('https://api.example/down', { signal: signal() }))).kind).toBe('network');
    expect((await failure(http.getJson('https://api.example/html', { signal: signal() }))).kind).toBe('invalid_response');
  });

  it('refuses responses over the size limit, declared or streamed', async () => {
    const big = 'x'.repeat(2048);
    const f = fakeFetch([
      [(u) => u.pathname === '/declared', new Response(big, { headers: { 'content-length': '2048' } })],
      [
        (u) => u.pathname === '/streamed',
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode('y'.repeat(600)));
                c.close();
              },
            }),
          ),
      ],
    ]);
    const { http } = client(f.fetch, { maxResponseBytes: 1024 });
    expect((await failure(http.get('https://api.example/declared', { signal: signal() }))).kind).toBe('invalid_response');
    expect((await failure(http.get('https://api.example/streamed', { signal: signal() }))).kind).toBe('invalid_response');
  });
});

describe('RateGate', () => {
  it('spaces request starts and limits concurrency', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = new RateGate(1, 1000, 'start', (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    }, () => clock);
    const order: string[] = [];
    const run = async (name: string) => {
      const release = await gate.acquire(new AbortController().signal);
      order.push(`start ${name}@${clock}`);
      await Promise.resolve();
      order.push(`end ${name}`);
      release();
    };
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(order).toEqual(['start a@0', 'end a', 'start b@1000', 'end b', 'start c@2000', 'end c']);
    expect(waits).toEqual([1000, 1000]);
  });

  it('spaces from the previous response with "end" spacing (arXiv)', async () => {
    let clock = 0;
    const gate = new RateGate(1, 3000, 'end', (ms) => {
      clock += ms;
      return Promise.resolve();
    }, () => clock);
    const r1 = await gate.acquire(new AbortController().signal);
    clock += 500; // the first response takes 0.5 s
    r1();
    const r2 = await gate.acquire(new AbortController().signal);
    expect(clock).toBe(3500);
    r2();
  });

  it('removes a cancelled waiter from the queue', async () => {
    const gate = new RateGate(1, 0, 'start', () => Promise.resolve(), () => 0);
    const first = await gate.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    expect(gate.queued).toBe(1);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    expect(gate.queued).toBe(0);
    first();
    const again = await gate.acquire(new AbortController().signal);
    again();
  });
});
