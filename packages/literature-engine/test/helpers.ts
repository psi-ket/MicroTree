import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ScholarlySourceRecord } from '@research-studio/shared-types';
import { baseRecord } from '../src/normalization/work-normalizer';
import type { ProviderConfig } from '../src/providers/shared';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A recorded provider response (see fixtures/README.md). */
export function fixture(path: string): string {
  return readFileSync(`${FIXTURES}${path}`, 'utf8');
}

export interface FakeCall {
  url: URL;
  headers: Headers;
}

type Reply = Response | ((call: FakeCall) => Response | Promise<Response>);

/**
 * A `fetch` that answers from a route table (first matching predicate wins)
 * and records every request. Unmatched requests fail the test loudly.
 */
export function fakeFetch(routes: [match: (url: URL) => boolean, reply: Reply][]) {
  const calls: FakeCall[] = [];
  const fetch: typeof globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call = { url, headers: new Headers(init?.headers) };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    for (const [match, reply] of routes) {
      if (!match(url)) continue;
      const res = typeof reply === 'function' ? await reply(call) : reply.clone();
      return res;
    }
    return new Response(`no fake route for ${url.href}`, { status: 599 });
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/atom+xml' } });

/** Provider config for tests: no waiting between requests or before retries. */
export function testConfig(fetch: typeof globalThis.fetch, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    fetch,
    minIntervalMs: 0,
    backoffBaseMs: 1,
    sleep: () => Promise.resolve(),
    now: () => Date.parse('2026-11-02T12:00:00Z'),
    ...extra,
  };
}

export const ctx = () => ({ signal: new AbortController().signal });

/** A minimal source record for engine tests. */
export function record(
  provider: ScholarlySourceRecord['provider'],
  providerId: string,
  title: string,
  patch: Partial<Omit<ScholarlySourceRecord, 'identifiers'>> & { identifiers?: Partial<ScholarlySourceRecord['identifiers']>; authorNames?: string[] } = {},
): ScholarlySourceRecord {
  const r = baseRecord(provider, providerId, title, patch.retrievedAt ?? '2026-11-02T12:00:00.000Z', null);
  const { identifiers, authorNames, ...rest } = patch;
  Object.assign(r, rest);
  r.identifiers = { ...r.identifiers, ...identifiers };
  if (authorNames) {
    r.authors = authorNames.map((name) => {
      const parts = name.split(' ');
      return { name, givenName: parts.slice(0, -1).join(' ') || null, familyName: parts.at(-1)!, orcid: null, affiliations: [], providerIds: {} };
    });
  }
  if (r.publicationYear === null && r.dates.published) r.publicationYear = Number(r.dates.published.slice(0, 4));
  return r;
}
