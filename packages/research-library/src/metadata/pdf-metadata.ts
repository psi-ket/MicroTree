import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { LibraryError } from '../errors/library-errors';

/**
 * What the library reads from a PDF: the document information dictionary,
 * XMP metadata and the text of the first pages (for DOIs, arXiv IDs and the
 * title). Parsing runs in a worker thread with a memory cap and a timeout, so
 * a hostile or broken file cannot exhaust or stall the runtime. pdf.js runs
 * with JavaScript evaluation, XFA, font loading and scripting disabled; nothing
 * in the file is executed.
 */
export interface PdfMetadata {
  pageCount: number;
  info: {
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
    creator: string | null;
    producer: string | null;
  };
  /** Selected XMP properties (`dc:title`, `prism:doi`, …; names lower-cased, lists joined with "; ") when present. */
  xmp: Record<string, string>;
  /** Text of the first pages, in reading order as pdf.js extracts it (bounded). */
  text: string;
  /** Text in the largest font on page 1: a title guess used only as a search query. */
  largestText: string;
}

export interface PdfReadOptions {
  /** Pages whose text is extracted (default 2). */
  maxPages?: number;
  /** Characters of text kept (default 20 000). */
  maxChars?: number;
  timeoutMs?: number;
  /** Old-generation heap limit for the worker. */
  memoryMb?: number;
  signal?: AbortSignal;
}

// Plain CommonJS so it runs with `eval: true` from source and from the bundled build.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let task;
  try {
    const pdfjs = await import(workerData.pdfjsUrl);
    task = pdfjs.getDocument({
      data: new Uint8Array(workerData.bytes),
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: false,
      verbosity: 0,
    });
    const doc = await task.promise;
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta && meta.info) || {};
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);
    const xmp = {};
    if (meta && meta.metadata) {
      // Iterable of [name, value] in current pdf.js (names lower-cased; rdf lists become arrays); getAll() in older versions.
      const md = meta.metadata;
      const entries = typeof md[Symbol.iterator] === 'function' ? [...md] : typeof md.getAll === 'function' ? Object.entries(md.getAll() || {}) : [];
      for (const [k, v] of entries) {
        const value = typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('; ') : null;
        if (value && /^(dc:|prism:|pdf:|pdfx:|xmp:)/i.test(k)) xmp[String(k).toLowerCase()] = value.slice(0, 2000);
      }
    }
    let text = '';
    let largestText = '';
    const pages = Math.min(doc.numPages, workerData.maxPages);
    for (let p = 1; p <= pages && text.length < workerData.maxChars; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str === 'string') text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      if (p === 1) {
        // The text set in the largest font on the first page (usually the title).
        const sized = content.items
          .filter((i) => typeof i.str === 'string' && i.str.trim() && Array.isArray(i.transform))
          .map((i) => ({ str: i.str, size: Math.hypot(i.transform[2], i.transform[3]) }));
        const max = sized.reduce((m, i) => Math.max(m, i.size), 0);
        if (max > 0) largestText = sized.filter((i) => i.size >= max * 0.92).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      }
      text += '\n\f\n';
      page.cleanup();
    }
    parentPort.postMessage({
      ok: true,
      pageCount: doc.numPages,
      info: { title: pick(info.Title), author: pick(info.Author), subject: pick(info.Subject), keywords: pick(info.Keywords), creator: pick(info.Creator), producer: pick(info.Producer) },
      xmp,
      text: text.slice(0, workerData.maxChars),
      largestText,
    });
  } catch (err) {
    parentPort.postMessage({ ok: false, name: (err && err.name) || 'Error', message: String((err && err.message) || err).slice(0, 500) });
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
})();
`;

let pdfjsUrl: string | null = null;
function pdfjsLocation(): string {
  pdfjsUrl ??= pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
  return pdfjsUrl;
}

/** At most this many PDFs are parsed at the same time. */
const MAX_PARALLEL = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Parse a PDF in a worker. Throws `UNSUPPORTED_MEDIA_TYPE` for files pdf.js cannot read, and `TIMEOUT` when it takes too long. */
export function readPdf(bytes: Uint8Array, options: PdfReadOptions = {}): Promise<PdfMetadata> {
  return slot(
    () =>
      new Promise<PdfMetadata>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new LibraryError('BAD_REQUEST', 'Cancelled'));
          return;
        }
        const copy = new Uint8Array(bytes); // the worker gets its own buffer
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: {
            pdfjsUrl: pdfjsLocation(),
            bytes: copy.buffer,
            maxPages: options.maxPages ?? 2,
            maxChars: options.maxChars ?? 20_000,
          },
          transferList: [copy.buffer],
          resourceLimits: { maxOldGenerationSizeMb: options.memoryMb ?? 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
          stdout: true,
          stderr: true,
        });
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          void worker.terminate();
          fn();
        };
        const timer = setTimeout(
          () => finish(() => reject(new LibraryError('TIMEOUT', 'Reading the PDF took too long; the file may be damaged or unusually complex'))),
          options.timeoutMs ?? 20_000,
        );
        const onAbort = () => finish(() => reject(new LibraryError('BAD_REQUEST', 'Cancelled')));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.once('message', (msg: { ok: true } & PdfMetadata | { ok: false; name: string; message: string }) => {
          if (msg.ok) {
            const { ok: _ok, ...meta } = msg;
            if (meta.pageCount < 1) finish(() => reject(new LibraryError('UNSUPPORTED_MEDIA_TYPE', 'The PDF has no pages')));
            else finish(() => resolve(meta));
            return;
          }
          const reason =
            msg.name === 'PasswordException'
              ? 'The PDF is password-protected and cannot be read'
              : msg.name === 'InvalidPDFException'
                ? 'The file is not a valid PDF'
                : `The PDF could not be read: ${msg.message}`;
          finish(() => reject(new LibraryError('UNSUPPORTED_MEDIA_TYPE', reason)));
        });
        worker.once('error', (err) => {
          const memory = /memory|heap/i.test(String(err?.message));
          finish(() =>
            reject(new LibraryError('UNSUPPORTED_MEDIA_TYPE', memory ? 'The PDF needs too much memory to read' : `The PDF could not be read: ${String(err?.message ?? err)}`)),
          );
        });
        worker.once('exit', (code) => {
          if (code !== 0) finish(() => reject(new LibraryError('UNSUPPORTED_MEDIA_TYPE', 'The PDF reader stopped unexpectedly')));
        });
      }),
  );
}
