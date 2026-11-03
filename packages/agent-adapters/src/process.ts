import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AgentExecutable } from '@research-studio/ai-core';

const IS_WINDOWS = process.platform === 'win32';

export function killTree(pid: number): void {
  if (IS_WINDOWS) {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => undefined);
    return;
  }
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

export interface SpawnLinesOptions {
  executable: AgentExecutable;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Written to stdin, which is then closed. */
  stdin: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap on a single stdout line; longer lines are cut (and flagged). */
  maxLineBytes?: number;
}

export type ProcessEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'exit';
      exitCode: number | null;
      timedOut: boolean;
      cancelled: boolean;
      /** Last part of stderr, for error messages. */
      stderrTail: string;
      spawnError: string | null;
    };

function assertSpawnable(executable: AgentExecutable): void {
  if (!path.isAbsolute(executable.command)) throw new Error('Agent executables must be absolute paths');
  // Batch files are always run by cmd.exe, which re-parses arguments.
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(executable.command)) throw new Error('Refusing to execute a batch file');
}

/**
 * Run a process without a shell and yield its stdout line by line. The
 * process tree is killed on timeout, on abort, and if the consumer stops
 * iterating early. The final event is always `exit`.
 */
export async function* spawnLines(options: SpawnLinesOptions): AsyncGenerator<ProcessEvent> {
  assertSpawnable(options.executable);
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  const queue: ProcessEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: ProcessEvent) => {
    queue.push(e);
    wake?.();
    wake = null;
  };

  let stderrTail = '';
  let timedOut = false;
  let cancelled = false;
  let exited = false;

  const child = spawn(options.executable.command, [...options.executable.prefixArgs, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: !IS_WINDOWS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const kill = () => {
    if (!exited && child.pid) killTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line) push({ type: 'stdout', line });
    }
    if (buffer.length > maxLine) {
      push({ type: 'stdout', line: buffer.slice(0, maxLine) });
      buffer = '';
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderrTail = (stderrTail + text).slice(-8000);
    push({ type: 'stderr', text });
  });

  let spawnError: string | null = null;
  const finished = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      spawnError = err.message;
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  void finished.then((code) => {
    exited = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (buffer.trim()) push({ type: 'stdout', line: buffer.replace(/\r$/, '') });
    push({ type: 'exit', exitCode: code, timedOut, cancelled, stderrTail, spawnError });
  });

  child.stdin.on('error', () => undefined); // the agent may exit before reading stdin
  child.stdin.end(options.stdin ?? '');

  try {
    for (;;) {
      if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
      while (queue.length) {
        const event = queue.shift()!;
        yield event;
        if (event.type === 'exit') return;
      }
    }
  } finally {
    // Consumer stopped early (break/throw): never leave the agent running.
    if (!exited) {
      cancelled = true;
      kill();
    }
  }
}

/** Run a short command (version or auth checks) and collect its output. */
export async function runQuick(
  executable: AgentExecutable,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; error: string | null }> {
  let stdout = '';
  let stderr = '';
  for await (const e of spawnLines({ executable, args, cwd: path.dirname(executable.command), env, stdin: null, timeoutMs })) {
    if (e.type === 'stdout') stdout += `${e.line}\n`;
    else if (e.type === 'stderr') stderr += e.text;
    else return { exitCode: e.exitCode, stdout, stderr, error: e.spawnError ?? (e.timedOut ? 'timed out' : null) };
  }
  return { exitCode: null, stdout, stderr, error: 'no exit' };
}
