import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GROBID_CONFIGURATION, ExtractionError, GrobidClient, isLoopbackUrl, parseGrobidVersion, type GrobidConfiguration } from '../src';
import { MockGrobid } from './fixtures/mock-grobid';
import { SAMPLE_TEI } from './fixtures/tei';

let grobid: MockGrobid;
const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'));

beforeEach(async () => {
  grobid = await new MockGrobid().start();
});
afterEach(() => grobid.stop());

function client(patch: Partial<GrobidConfiguration> = {}) {
  return new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: grobid.url, busyRetryDelayMs: 20, timeoutMs: 2000, ...patch });
}

async function failure(p: Promise<unknown>): Promise<ExtractionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExtractionError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('GROBID client', () => {
  it('extracts TEI and sends the documented options with consolidation off', async () => {
    grobid.script = [{ status: 200, body: SAMPLE_TEI }];
    const r = await client().processFulltext(pdf, new AbortController().signal);
    expect(r.tei).toBe(SAMPLE_TEI);
    expect(r.version).toBe('0.8.2');
    expect(r.attempts).toBe(1);
    const body = grobid.requests[0]!;
    expect(body).toContain('name="input"; filename="document.pdf"');
    expect(MockGrobid.fields(body, 'consolidateHeader')).toEqual(['0']);
    expect(MockGrobid.fields(body, 'consolidateCitations')).toEqual(['0']);
    expect(MockGrobid.fields(body, 'consolidateFunders')).toEqual(['0']);
    expect(MockGrobid.fields(body, 'includeRawCitations')).toEqual(['1']);
    expect(MockGrobid.fields(body, 'segmentSentences')).toEqual(['1']);
    expect(MockGrobid.fields(body, 'teiCoordinates')).toEqual(['head', 'p', 's', 'figure', 'formula', 'ref', 'biblStruct', 'note', 'title', 'persName']);
  });

  it('treats 204 (nothing extracted), 400 and 500 as permanent and does not retry them', async () => {
    for (const [status, code] of [
      [204, 'empty'],
      [400, 'unsupported'],
      [500, 'extractor-error'],
    ] as const) {
      grobid.requests = [];
      grobid.script = [{ status, body: status === 500 ? 'PDF parsing failed' : '' }];
      const err = await failure(client().processFulltext(pdf, new AbortController().signal));
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(false);
      expect(grobid.requests).toHaveLength(1);
    }
  });

  it('retries 503 (busy) and succeeds when GROBID frees up', async () => {
    grobid.script = [{ status: 503 }, { status: 503 }, { status: 200, body: SAMPLE_TEI }];
    const r = await client().processFulltext(pdf, new AbortController().signal);
    expect(r.attempts).toBe(3);
  });

  it('stops retrying an overloaded service after the retry limit', async () => {
    grobid.fallback = { status: 503 };
    const err = await failure(client({ maxRetries: 2 }).processFulltext(pdf, new AbortController().signal));
    expect(err.code).toBe('overloaded');
    expect(err.retryable).toBe(true);
    expect(grobid.requests).toHaveLength(3);
  });

  it('times out slow requests and retries a timeout only once', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 400 };
    const err = await failure(client({ timeoutMs: 100 }).processFulltext(pdf, new AbortController().signal));
    expect(err.code).toBe('timeout');
    expect(grobid.requests).toHaveLength(2);
  });

  it('reports an unreachable service', async () => {
    await grobid.stop();
    const c = new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: grobid.url, maxRetries: 1 });
    const err = await failure(c.processFulltext(pdf, new AbortController().signal));
    expect(err.code).toBe('unavailable');
    expect((await c.health()).status).toBe('unavailable');
    grobid = await new MockGrobid().start(); // for afterEach
  });

  it('cancels a request in flight and while waiting to retry', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 1000 };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect((await failure(client().processFulltext(pdf, ac.signal))).code).toBe('cancelled');
    grobid.fallback = { status: 503 };
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 60);
    expect((await failure(client({ busyRetryDelayMs: 5000 }).processFulltext(pdf, ac2.signal))).code).toBe('cancelled');
  });

  it('keeps the number of concurrent requests within the limit', async () => {
    grobid.fallback = { status: 200, body: SAMPLE_TEI, delayMs: 60 };
    const c = client({ concurrency: 2 });
    await Promise.all(Array.from({ length: 5 }, () => c.processFulltext(pdf, new AbortController().signal)));
    expect(grobid.peak).toBe(2);
  });

  it('refuses answers larger than the limit', async () => {
    grobid.script = [{ status: 200, body: 'x'.repeat(5000) }];
    const c = new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: grobid.url }, { maxResponseBytes: 1000 });
    expect((await failure(c.processFulltext(pdf, new AbortController().signal))).code).toBe('invalid-output');
  });

  it('checks health and reads plain and JSON versions', async () => {
    expect(await client().health()).toMatchObject({ status: 'available', version: '0.8.2', remote: false });
    grobid.alive = { status: 503, body: 'false' };
    expect((await client().health()).status).toBe('initialising');
    expect(parseGrobidVersion('{"version":"0.9.0","revision":"0.9.0-70-g94429f4e2"}')).toBe('0.9.0 (0.9.0-70-g94429f4e2)');
    expect(parseGrobidVersion('<html>')).toBeNull();
  });

  it('refuses a remote service unless remote processing was allowed, and URLs with credentials', () => {
    expect(() => new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: 'https://grobid.example.org' })).toThrow(/another computer/);
    expect(new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: 'https://grobid.example.org', allowRemote: true }).remote).toBe(true);
    expect(() => new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: 'http://u:p@127.0.0.1:8070' })).toThrow(/credentials/);
    expect(() => new GrobidClient({ ...DEFAULT_GROBID_CONFIGURATION, baseUrl: 'file:///etc/passwd' })).toThrow(/http/);
    expect(isLoopbackUrl('http://127.0.0.2:8070')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8070')).toBe(true);
    expect(isLoopbackUrl('http://10.0.0.1:8070')).toBe(false);
  });
});
