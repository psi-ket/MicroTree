import { LATEX_ENGINES, type LatexEngine, type ToolchainStatus } from '@research-studio/shared-types';
import { buildSanitizedEnv, findExecutable, runProcess } from './process';

export interface ToolchainPaths {
  latexmk: string | null;
  synctex: string | null;
  engines: Record<LatexEngine, string | null>;
}

export interface Toolchain {
  paths: ToolchainPaths;
  status: ToolchainStatus;
}

export interface ToolchainOverrides {
  latexmk?: string | undefined;
  synctex?: string | undefined;
}

async function latexmkVersion(latexmk: string): Promise<string | null> {
  try {
    const result = await runProcess({
      command: latexmk,
      args: ['-v'],
      cwd: process.cwd(),
      env: buildSanitizedEnv(),
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024,
    });
    return /Version\s+([\d.]+[a-z]?)/i.exec(result.output)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Locate latexmk, synctex and the TeX engines on PATH (or at configured paths). */
export async function detectToolchain(overrides: ToolchainOverrides = {}): Promise<Toolchain> {
  const [latexmk, synctex, ...engines] = await Promise.all([
    findExecutable(overrides.latexmk ?? 'latexmk'),
    findExecutable(overrides.synctex ?? 'synctex'),
    ...LATEX_ENGINES.map((e) => findExecutable(e)),
  ]);
  const enginePaths = Object.fromEntries(
    LATEX_ENGINES.map((e, i) => [e, engines[i] ?? null]),
  ) as Record<LatexEngine, string | null>;
  const version = latexmk ? await latexmkVersion(latexmk) : null;
  return {
    paths: { latexmk: latexmk ?? null, synctex: synctex ?? null, engines: enginePaths },
    status: {
      latexmk: { available: latexmk !== null, version, path: latexmk ?? null },
      synctex: { available: synctex !== null, path: synctex ?? null },
      engines: Object.fromEntries(
        LATEX_ENGINES.map((e) => [e, enginePaths[e] !== null]),
      ) as Record<LatexEngine, boolean>,
    },
  };
}
