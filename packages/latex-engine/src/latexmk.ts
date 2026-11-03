import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProjectPath } from '@research-studio/document-engine';
import { isWithin, PathGuard, realpathOfNearestExisting } from '@research-studio/document-engine/node';
import { StudioError, type Diagnostic, type LatexEngine } from '@research-studio/shared-types';
import {
  parseBiberLog,
  parseBibtexLog,
  parseLatexLog,
  parseLatexmkOutput,
  type FileResolver,
} from './log-parser';
import { buildSanitizedEnv, runProcess } from './process';

/** Build directory inside each project (reserved: clients cannot write to it). */
export const BUILD_DIR = '.rs-build';

const ENGINE_FLAGS: Record<LatexEngine, string> = {
  pdflatex: '-pdf',
  xelatex: '-pdfxe',
  lualatex: '-pdflua',
};

/**
 * latexmk assembles shell command lines internally, so the main file name is
 * restricted to characters that are inert in every shell, on top of the
 * generic path validation.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.\- ]*$/;

export function validateMainFile(input: string): string {
  const rel = normalizeProjectPath(input, { forWrite: true });
  const segments = rel.split('/');
  if (!rel.toLowerCase().endsWith('.tex') || !segments.every((s) => SAFE_SEGMENT.test(s))) {
    throw new StudioError(
      'VALIDATION_FAILED',
      'The main file must be a .tex file whose path uses only letters, digits, spaces, "_", "-" and "."',
      { mainFile: input },
    );
  }
  return rel;
}

export function buildLatexmkArgs(engine: LatexEngine, mainFile: string): string[] {
  return [
    '-norc', // never execute latexmkrc files (they are Perl), including project-local ones
    ENGINE_FLAGS[engine],
    '-f',
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    `-outdir=${BUILD_DIR}`,
    validateMainFile(mainFile),
  ];
}

export interface BuildArtifacts {
  outDir: string;
  pdfPath: string;
  logPath: string;
  blgPath: string;
  synctexPath: string;
}

export function buildArtifacts(projectRoot: string, mainFile: string): BuildArtifacts {
  const stem = path.posix.basename(mainFile).replace(/\.tex$/i, '');
  const outDir = path.join(projectRoot, BUILD_DIR);
  return {
    outDir,
    pdfPath: path.join(outDir, `${stem}.pdf`),
    logPath: path.join(outDir, `${stem}.log`),
    blgPath: path.join(outDir, `${stem}.blg`),
    synctexPath: path.join(outDir, `${stem}.synctex.gz`),
  };
}

export interface CompileOptions {
  latexmkPath: string;
  projectRoot: string;
  mainFile: string;
  engine: LatexEngine;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface CompileOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  pdfAvailable: boolean;
  artifacts: BuildArtifacts;
  diagnostics: Diagnostic[];
  output: string;
  outputTruncated: boolean;
}

/** Largest part of a .log/.blg file that is read for diagnostics. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** The first `MAX_LOG_BYTES` of a log (TeX can write logs of any size). */
async function readIfExists(file: string, maxBytes = MAX_LOG_BYTES): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

/** Most entries scanned for links before a compile; larger trees are refused. */
export const MAX_SCAN_ENTRIES = 50_000;

/**
 * Find symbolic links and junctions in the project tree (build directory
 * included) that resolve outside it. TeX follows links, so one such link
 * would let a document read or overwrite files outside the project despite
 * `openin_any`/`openout_any`. Returns project-relative paths.
 */
export async function findEscapingLinks(root: string): Promise<string[]> {
  const realRoot = await realpathOfNearestExisting(root);
  const escaping: string[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length) {
    const dir = queue.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++seen > MAX_SCAN_ENTRIES) {
        throw new StudioError('VALIDATION_FAILED', `The project has more than ${MAX_SCAN_ENTRIES.toLocaleString('en-US')} files and folders; it is too large to check before compiling.`);
      }
      const abs = path.join(dir, entry.name);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        const target = await realpathOfNearestExisting(abs);
        if (!isWithin(realRoot, target)) escaping.push(path.relative(root, abs).split(path.sep).join('/'));
      } else if (info.isDirectory()) {
        queue.push(abs);
      }
    }
  }
  return escaping.sort();
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Resolver mapping log file names to editable project paths (build outputs and system files map to null). */
export function projectFileResolver(guard: PathGuard): FileResolver {
  return (raw) => {
    const rel = guard.toProjectPath(path.resolve(guard.root, raw.replace(/^"|"$/g, '')));
    if (!rel || rel.startsWith(`${BUILD_DIR}/`)) return null;
    return rel;
  };
}

/** Run latexmk for a project and collect structured diagnostics. */
export async function compileProject(options: CompileOptions): Promise<CompileOutcome> {
  const guard = await PathGuard.create(options.projectRoot);
  const mainFile = validateMainFile(options.mainFile);
  const { abs: mainAbs } = await guard.resolve(mainFile);
  if (!(await fileExists(mainAbs))) {
    throw new StudioError('NOT_FOUND', `Main file "${mainFile}" does not exist`, { mainFile });
  }
  const artifacts = buildArtifacts(guard.root, mainFile);
  const escaping = await findEscapingLinks(guard.root);
  if (escaping.length) {
    throw new StudioError(
      'VALIDATION_FAILED',
      `The project contains links that point outside it (${escaping.slice(0, 5).join(', ')}${escaping.length > 5 ? ', …' : ''}). Remove them or replace them with copies, then compile again.`,
      { links: escaping.slice(0, 50) },
    );
  }
  await mkdir(artifacts.outDir, { recursive: true });

  const result = await runProcess({
    command: options.latexmkPath,
    args: buildLatexmkArgs(options.engine, mainFile),
    cwd: guard.root,
    env: buildSanitizedEnv(options.env, options.engine),
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
  });

  const resolve = projectFileResolver(guard);
  const diagnostics: Diagnostic[] = [];
  const log = await readIfExists(artifacts.logPath);
  if (log !== null) diagnostics.push(...parseLatexLog(log.text, resolve));
  const blg = await readIfExists(artifacts.blgPath);
  if (blg !== null) {
    diagnostics.push(...(/This is Biber/.test(blg.text) ? parseBiberLog(blg.text) : parseBibtexLog(blg.text, resolve)));
  }
  for (const [name, file] of [['TeX log', log], ['bibliography log', blg]] as const) {
    if (file?.truncated) {
      diagnostics.push({
        severity: 'warning',
        source: 'runtime',
        message: `The ${name} is larger than ${MAX_LOG_BYTES / 1024 / 1024} MB; only its first ${MAX_LOG_BYTES / 1024 / 1024} MB were checked for problems.`,
        file: null,
        line: null,
        context: null,
      });
    }
  }
  diagnostics.push(...parseLatexmkOutput(result.output));

  if (result.timedOut) {
    diagnostics.push({
      severity: 'error',
      source: 'runtime',
      message: `Compilation exceeded the ${Math.round(options.timeoutMs / 1000)} s time limit and was stopped`,
      file: null,
      line: null,
      context: null,
    });
  } else if (log === null && !result.cancelled && result.exitCode !== 0) {
    diagnostics.push({
      severity: 'error',
      source: 'latexmk',
      message: 'latexmk failed before TeX produced a log file',
      file: null,
      line: null,
      context: result.output.trim().split(/\r?\n/).slice(-12).join('\n') || null,
    });
  }

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
    pdfAvailable: await fileExists(artifacts.pdfPath),
    artifacts,
    diagnostics,
    output: result.output,
    outputTruncated: result.outputTruncated,
  };
}
