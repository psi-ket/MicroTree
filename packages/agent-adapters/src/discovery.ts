import { access, constants, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutable } from '@research-studio/ai-core';

const IS_WINDOWS = process.platform === 'win32';

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(env: Record<string, string | undefined>): string[] {
  const value = env.PATH ?? env.Path ?? '';
  return value.split(path.delimiter).filter(Boolean);
}

/** Look up `name` on PATH without a shell. On Windows only `.exe` files count. */
export async function findOnPath(name: string, env: Record<string, string | undefined>): Promise<string | null> {
  const candidates = IS_WINDOWS ? [`${name}.exe`] : [name];
  for (const dir of pathDirs(env)) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

/**
 * An npm-installed CLI on Windows is a `.cmd` shim, which cannot be spawned
 * safely. Resolve the package's JavaScript entry point next to the shim and
 * run it with this Node binary instead (what the shim itself does).
 */
export async function findNpmScript(name: string, packageName: string, binPath: string, env: Record<string, string | undefined>): Promise<AgentExecutable | null> {
  for (const dir of pathDirs(env)) {
    const shim = path.join(dir, IS_WINDOWS ? `${name}.cmd` : name);
    if (!(await isExecutable(shim))) continue;
    const roots = [path.join(dir, 'node_modules'), path.join(dir, '..', 'lib', 'node_modules')];
    for (const root of roots) {
      const script = path.join(root, packageName, binPath);
      try {
        const pkg = JSON.parse(await readFile(path.join(root, packageName, 'package.json'), 'utf8')) as { name?: string };
        if (pkg.name !== packageName) continue;
        await access(script, constants.R_OK);
        return { command: process.execPath, prefixArgs: [await realpath(script)] };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/** An explicitly configured executable (`RS_CLAUDE_PATH`, …). Must be absolute; `.js` files run with Node. */
export async function fromConfiguredPath(file: string): Promise<AgentExecutable | { problem: string }> {
  if (!path.isAbsolute(file)) return { problem: `${file} is not an absolute path.` };
  if (!(await isExecutable(file))) return { problem: `${file} does not exist or is not executable.` };
  if (/\.(c|m)?js$/i.test(file)) return { command: process.execPath, prefixArgs: [file] };
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file)) return { problem: 'Batch files cannot be run safely; point to the .exe or .js file instead.' };
  return { command: file, prefixArgs: [] };
}
