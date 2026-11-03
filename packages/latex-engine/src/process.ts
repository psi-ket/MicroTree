import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

export interface RunProcessOptions {
  /** Absolute path to the executable (resolve with `findExecutable`). */
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Total stdout+stderr bytes retained in the result; the stream still reaches `onOutput`. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
}

const IS_WINDOWS = process.platform === 'win32';

/** Kill a process and all of its descendants. */
function killTree(pid: number): void {
  if (IS_WINDOWS) {
    // taskkill is the only reliable way to terminate a runscript → perl → pdflatex chain.
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Spawn a process without a shell. Arguments are passed as an array so no
 * shell interpretation happens; the caller must pass an absolute executable path.
 */
export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (!path.isAbsolute(options.command)) {
    return Promise.reject(new Error('runProcess requires an absolute executable path'));
  }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(options.command)) {
    // Batch files are always interpreted by cmd.exe and cannot be spawned safely.
    return Promise.reject(new Error('Refusing to execute a batch file'));
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let output = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (data: Buffer) => {
      const text = data.toString('utf8');
      if (!truncated) {
        if (output.length + text.length > maxBytes) {
          output += text.slice(0, Math.max(0, maxBytes - output.length));
          truncated = true;
        } else {
          output += text;
        }
      }
      options.onOutput?.(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, options.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      finish();
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        output,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Locate an executable on PATH without invoking a shell. On Windows only
 * `.exe`/`.com` files are considered (batch files cannot be spawned safely).
 */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (path.isAbsolute(name)) {
    try {
      await access(name, IS_WINDOWS ? constants.F_OK : constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? ['.exe', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        await access(candidate, IS_WINDOWS ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* keep searching */
      }
    }
  }
  return null;
}

const PASSTHROUGH_ENV = IS_WINDOWS
  ? [
      'PATH',
      'PATHEXT',
      'SystemRoot',
      'SystemDrive',
      'windir',
      'ComSpec',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'ProgramData',
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE',
      'OS',
    ]
  : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME'];

const TEX_PASSTHROUGH = [
  'TEXMFHOME',
  'TEXMFVAR',
  'TEXMFCONFIG',
  'TEXMFLOCAL',
  'TEXMFCACHE',
  'TEXINPUTS',
  'BIBINPUTS',
  'BSTINPUTS',
  'MIKTEX_USERCONFIG',
  'MIKTEX_USERDATA',
];

/**
 * Hardened TeX environment. kpathsea (TeX Live) reads texmf.cnf variables
 * from the environment, which lets us disable shell escape and restrict file
 * access regardless of the installation's configuration. MiKTeX ignores these
 * variables (see docs/security.md, T8).
 *
 * - `shell_escape=f`: no `\write18`, not even TeX Live's restricted list.
 * - `openout_any=p`: TeX writes only below the working directory (no absolute
 *   paths, no `..`, no dot files).
 * - `TEXMFOUTPUT` empty: no directory where absolute writes are allowed.
 * - `openin_any`: see `TEX_OPENIN`.
 */
export const TEX_SECURITY_ENV: Readonly<Record<string, string>> = {
  shell_escape: 'f',
  openout_any: 'p',
  // Under `openout_any=p` absolute writes are allowed below TEXMFOUTPUT; empty
  // counts as unset and overrides any value from texmf.cnf.
  TEXMFOUTPUT: '',
  max_print_line: '10000',
  error_line: '254',
  half_error_line: '238',
};

/**
 * Read policy per engine. `p` ("paranoid") stops `\input`, `\openin`,
 * BibTeX and biber from reading absolute paths or `..` paths outside the
 * project (files found through kpathsea, i.e. the TeX distribution, are still
 * readable). LuaLaTeX cannot start under `p` in TeX Live 2024 (its format
 * loader opens the class files by absolute path), so it keeps `a` and is
 * documented as able to read any file the user can.
 */
export const TEX_OPENIN: Readonly<Record<'pdflatex' | 'xelatex' | 'lualatex', 'p' | 'a'>> = {
  pdflatex: 'p',
  xelatex: 'p',
  lualatex: 'a',
};

export function buildSanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
  engine: keyof typeof TEX_OPENIN = 'pdflatex',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...PASSTHROUGH_ENV, ...TEX_PASSTHROUGH]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...TEX_SECURITY_ENV, openin_any: TEX_OPENIN[engine] };
}
