import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import { ExtractionCancelledError, ExtractionError } from '../../errors/extraction-errors';
import { Semaphore } from '../../pipeline/concurrency';
import { PYMUPDF_WORKER_SOURCE } from './pymupdf-worker';

const Box = z.array(z.number()).length(4);
const Span = z.object({ text: z.string(), size: z.number(), flags: z.number(), font: z.string(), bbox: Box });
const Line = z.object({ bbox: Box, dir: z.array(z.number()).optional(), spans: z.array(Span) });
const Block = z.object({ bbox: Box, lines: z.array(Line) });
const Page = z.object({
  number: z.number().int().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number(),
  mediaBox: Box,
  cropBox: Box,
  imageCount: z.number().int().min(0),
  charCount: z.number().int().min(0),
  blocks: z.array(Block),
  words: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.string()])).optional(),
});
export const PyMuPdfOutputSchema = z.object({
  version: z.string(),
  pageCount: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.string().nullable()).optional(),
  pages: z.array(Page),
  truncated: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type PyMuPdfOutput = z.infer<typeof PyMuPdfOutputSchema>;
export type PyMuPdfPage = z.infer<typeof Page>;
export type PyMuPdfBlock = z.infer<typeof Block>;
export type PyMuPdfLine = z.infer<typeof Line>;

export interface PyMuPdfConfiguration {
  /** Python executable (`python3`, `python`, or a path), chosen by the operator. */
  python: string;
  timeoutMs: number;
  memoryMb: number;
  maxPages: number;
  maxOutputBytes: number;
  concurrency: number;
}

export interface PyMuPdfStatus {
  status: 'available' | 'unavailable' | 'disabled';
  version: string | null;
  message: string | null;
}

const SOURCE = 'pymupdf';

/** Variables a Python process needs to start; nothing else from the runtime's environment is passed. */
function pythonEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function run(python: string, args: string[], input: Uint8Array | null, opts: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ExtractionCancelledError(SOURCE));
    // -E: ignore PYTHON* variables. The program itself drops '' from sys.path.
    const child = spawn(python, ['-E', ...args], { shell: false, cwd: os.tmpdir(), env: pythonEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let killedFor: 'timeout' | 'cancel' | 'output' | null = null;
    const kill = (why: typeof killedFor) => {
      killedFor ??= why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    const onAbort = () => kill('cancel');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > opts.maxOutputBytes) kill('output');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4000) err += chunk.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new ExtractionError('unavailable', e.code === 'ENOENT' ? `Python was not found ("${python}")` : `Python could not be started (${e.code ?? e.message})`, SOURCE, false));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killedFor === 'cancel') return reject(new ExtractionCancelledError(SOURCE));
      if (killedFor === 'timeout') return reject(new ExtractionError('timeout', `PyMuPDF did not finish within ${Math.round(opts.timeoutMs / 1000)} s`, SOURCE, false));
      if (killedFor === 'output') return reject(new ExtractionError('invalid-output', 'PyMuPDF produced more output than the processing limit', SOURCE, false));
      resolve({ stdout: Buffer.concat(out), stderr: err, code, signal });
    });
    child.stdin.on('error', () => {
      // The process may exit before reading everything (e.g. an import error); the exit code tells the story.
    });
    if (input) child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    else child.stdin.end();
  });
}

/**
 * Runs PyMuPDF in a separate Python process for page geometry, text blocks
 * with coordinates and the text fallback. Bounded by a semaphore, a timeout,
 * an output cap and a memory cap.
 */
export class PyMuPdfClient {
  private readonly semaphore: Semaphore;
  private probed: Promise<PyMuPdfStatus> | null = null;

  constructor(readonly config: PyMuPdfConfiguration) {
    this.semaphore = new Semaphore(config.concurrency);
  }

  /** Whether Python and PyMuPDF are installed (cached; `refresh` probes again). */
  status(refresh = false): Promise<PyMuPdfStatus> {
    if (refresh || !this.probed) {
      this.probed = run(this.config.python, ['-c', 'import sys; sys.path=[p for p in sys.path if p not in ("", ".")]; import pymupdf; print(pymupdf.VersionBind)'], null, {
        timeoutMs: 15_000,
        maxOutputBytes: 4096,
      })
        .then((r): PyMuPdfStatus => {
          const version = r.stdout.toString('utf8').trim();
          if (r.code === 0 && /^[\w.+-]{1,32}$/.test(version)) return { status: 'available', version, message: null };
          return { status: 'unavailable', version: null, message: /No module named/.test(r.stderr) ? 'PyMuPDF is not installed for this Python (pip install pymupdf)' : 'PyMuPDF could not be loaded' };
        })
        .catch((e: unknown): PyMuPdfStatus => ({ status: 'unavailable', version: null, message: e instanceof Error ? e.message : String(e) }));
    }
    return this.probed;
  }

  async extract(pdf: Uint8Array, signal: AbortSignal, options: { words?: boolean } = {}): Promise<PyMuPdfOutput> {
    return this.semaphore.run(async () => {
      const opts = JSON.stringify({ memoryMb: this.config.memoryMb, maxPages: this.config.maxPages, words: options.words ?? false });
      const r = await run(this.config.python, ['-c', PYMUPDF_WORKER_SOURCE, opts], pdf, { timeoutMs: this.config.timeoutMs, maxOutputBytes: this.config.maxOutputBytes, signal });
      if (r.code !== 0) {
        if (/No module named ['"]?(pymupdf|fitz)/.test(r.stderr)) throw new ExtractionError('unavailable', 'PyMuPDF is not installed for this Python (pip install pymupdf)', SOURCE, false);
        if (/MemoryError|Cannot allocate/i.test(r.stderr) || r.signal) throw new ExtractionError('extractor-error', 'PyMuPDF ran out of its memory limit or was stopped on this document', SOURCE, false);
        throw new ExtractionError('extractor-error', `PyMuPDF failed (exit code ${r.code})`, SOURCE, false);
      }
      let json: unknown;
      try {
        json = JSON.parse(r.stdout.toString('utf8'));
      } catch {
        throw new ExtractionError('invalid-output', 'PyMuPDF output was not valid JSON', SOURCE, false);
      }
      const parsed = PyMuPdfOutputSchema.safeParse(json);
      if (!parsed.success) throw new ExtractionError('invalid-output', 'PyMuPDF output did not have the expected shape', SOURCE, false);
      const e = parsed.data.error;
      if (e) {
        const code = e.code === 'malformed' || e.code === 'unsupported' || e.code === 'too-many-pages' ? e.code : 'extractor-error';
        throw new ExtractionError(code, e.code === 'malformed' ? `PyMuPDF cannot read this PDF: ${e.message}` : e.message, SOURCE, false);
      }
      return parsed.data;
    }, signal);
  }
}
