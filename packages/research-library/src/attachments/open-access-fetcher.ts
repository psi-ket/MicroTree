import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { ScholarlyWork } from '@research-studio/shared-types';
import { LibraryCancelledError, LibraryError } from '../errors/library-errors';

/**
 * Downloads an open-access PDF that a scholarly provider listed for a work.
 * Only `https` URLs taken from the work itself are fetched (never a URL typed
 * into the browser); every connection, including each redirect, is checked
 * against private, loopback and link-local addresses at connect time, so DNS
 * answers cannot point the runtime at the local network. No cookies, no
 * credentials, no attempt to get past a login or paywall: anything but a PDF
 * response is reported as unavailable.
 */

// Two lists: Node matches IPv4 addresses against IPv4-mapped IPv6 rules, so one list would block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped addresses are judged by their IPv4 part.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blockedV6.check(address, 'ipv6');
  }
  return !blockedV4.check(address, 'ipv4');
}

/** URLs the library may download for a work: its open-access PDF and its PDF link (arXiv), https only. */
export function openAccessPdfUrls(work: ScholarlyWork): string[] {
  const out: string[] = [];
  for (const u of [work.openAccess.pdfUrl, work.urls.pdf]) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' && !url.username && !url.password && !out.includes(url.href)) out.push(url.href);
    } catch {
      /* not a URL */
    }
  }
  return out;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Tests only: allow plain http to loopback addresses. */
  allowLoopbackHttp?: boolean;
}

export interface FetchedFile {
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  /** File name from Content-Disposition or the URL path (untrusted; sanitised by the caller). */
  suggestedName: string;
  body: AsyncIterable<Uint8Array>;
}

function safeLookup(allowLoopback: boolean) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { all: true, family: typeof options.family === 'number' ? options.family : 0 }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const ok = addresses.filter((a) => isPublicAddress(a.address) || (allowLoopback && (a.address === '127.0.0.1' || a.address === '::1')));
      if (!ok.length) {
        const e = new Error(`Refusing to connect to ${hostname}: it resolves to a private or reserved address`) as NodeJS.ErrnoException;
        e.code = 'EADDRBLOCKED';
        return callback(e, '', 0);
      }
      if (options.all) return callback(null, ok);
      return callback(null, ok[0]!.address, ok[0]!.family);
    });
  };
}

function fileNameFrom(res: IncomingMessage, url: URL): string {
  const cd = res.headers['content-disposition'] ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  try {
    if (star) return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
  } catch {
    /* fall through */
  }
  if (plain) return plain[1]!.trim();
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last) || 'download.pdf';
  } catch {
    return last || 'download.pdf';
  }
}

/** Fetch `start` (which must come from `openAccessPdfUrls`). Resolves once a PDF response has started. */
export function fetchOpenAccessPdf(start: string, options: FetchOptions): Promise<FetchedFile> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const allowLoopback = options.allowLoopbackHttp === true;

  const once = (url: URL, hops: number): Promise<FetchedFile> =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new LibraryCancelledError());
      const insecureOk = allowLoopback && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
      if (url.protocol !== 'https:' && !insecureOk) return reject(new LibraryError('BAD_REQUEST', 'Only https links are downloaded'));
      if (url.username || url.password) return reject(new LibraryError('BAD_REQUEST', 'Links with credentials are not downloaded'));
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          lookup: safeLookup(allowLoopback) as never,
          headers: { accept: 'application/pdf', 'user-agent': options.userAgent ?? 'ResearchStudio (personal reference library)' },
          timeout: timeoutMs,
          signal: options.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (hops >= maxRedirects) return reject(new LibraryError('PROVIDER_ERROR', 'Too many redirects while downloading the PDF'));
            let next: URL;
            try {
              next = new URL(res.headers.location, url);
            } catch {
              return reject(new LibraryError('PROVIDER_ERROR', 'The PDF link redirected to an invalid address'));
            }
            return resolve(once(next, hops + 1));
          }
          if (status !== 200) {
            res.resume();
            const reason = status === 401 || status === 403 ? 'the publisher requires access' : `the server answered ${status}`;
            return reject(new LibraryError('PROVIDER_ERROR', `The open-access PDF is not available: ${reason}`));
          }
          const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (contentType && contentType !== 'application/pdf' && contentType !== 'application/octet-stream' && contentType !== 'binary/octet-stream') {
            res.resume();
            // Usually an HTML landing or login page.
            return reject(new LibraryError('PROVIDER_ERROR', `The link did not return a PDF (it returned ${contentType})`));
          }
          const length = Number(res.headers['content-length']);
          if (Number.isFinite(length) && length > options.maxBytes) {
            res.resume();
            return reject(new LibraryError('PAYLOAD_TOO_LARGE', 'The PDF is larger than the library limit'));
          }
          resolve({ url: url.href, contentType, suggestedName: fileNameFrom(res, url), body: res });
        },
      );
      req.on('timeout', () => req.destroy(new LibraryError('TIMEOUT', 'The download timed out')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (options.signal?.aborted) return reject(new LibraryCancelledError());
        if (err instanceof LibraryError) return reject(err);
        if (err.code === 'EADDRBLOCKED') return reject(new LibraryError('FORBIDDEN', err.message));
        reject(new LibraryError('PROVIDER_ERROR', `The download failed: ${err.message}`));
      });
      req.end();
    });

  let first: URL;
  try {
    first = new URL(start);
  } catch {
    return Promise.reject(new LibraryError('BAD_REQUEST', 'Invalid link'));
  }
  return once(first, 0);
}
