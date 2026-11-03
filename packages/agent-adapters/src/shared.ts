import path from 'node:path';
import type { AgentEvent } from '@research-studio/ai-core';
import { isStrictlyWithin } from '@research-studio/document-engine/node';
import type { ProcessEvent } from './process';

/** Project-relative POSIX path when `file` is inside `root`, else the input unchanged. */
export function relativeTo(file: string, root: string): string {
  if (!path.isAbsolute(file)) return file.split(path.sep).join('/');
  if (!isStrictlyWithin(root, file)) return file;
  return path.relative(root, file).split(path.sep).join('/');
}

/** A short, display-safe description of a tool call's input. */
export function describeTool(input: unknown, root: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof i[key] === 'string') return relativeTo(i[key], root);
  }
  for (const key of ['pattern', 'command', 'query']) {
    if (typeof i[key] === 'string') return String(i[key]).slice(0, 200);
  }
  return null;
}

/** Map a process exit plus the protocol's own verdict to the final `done` event. */
export function finishEvent(
  exit: Extract<ProcessEvent, { type: 'exit' }>,
  protocolOk: boolean,
  result: string | null,
  protocolError: string | null,
  deniedTools: string[] = [],
): Extract<AgentEvent, { type: 'done' }> {
  if (exit.cancelled) return { type: 'done', status: 'cancelled', result, error: null };
  if (exit.timedOut) return { type: 'done', status: 'timed-out', result, error: 'The agent exceeded its time limit and was stopped.' };
  if (exit.spawnError) return { type: 'done', status: 'failed', result: null, error: `Could not start the agent: ${exit.spawnError}` };
  if (protocolOk && exit.exitCode === 0) {
    return {
      type: 'done',
      status: 'completed',
      result,
      error: deniedTools.length ? `Denied by permissions: ${[...new Set(deniedTools)].join(', ')}` : null,
    };
  }
  const stderr = exit.stderrTail.trim().split('\n').slice(-5).join('\n');
  return {
    type: 'done',
    status: 'failed',
    result,
    error: protocolError ?? (stderr || `The agent exited with code ${exit.exitCode ?? 'unknown'}.`),
  };
}
