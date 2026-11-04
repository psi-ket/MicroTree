import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileProject, runProcess } from '@research-studio/latex-engine';
import type { Diagnostic } from '@research-studio/shared-types';
import { VisualError } from '../errors/visual-errors';
import { checkLatexSafety, checkStructure, hasErrors, type LatexIssue } from './latex-safety';

export interface CompileRequest {
  /** The full standalone document. */
  document: string;
  /** Extra files next to it (CSV data), by plain file name. */
  files?: Record<string, string>;
  /** Packages the document loads, checked with kpsewhich before compiling. */
  packages: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompileResult {
  status: 'succeeded' | 'failed' | 'invalid';
  pdf: Buffer | null;
  diagnostics: Diagnostic[];
  issues: LatexIssue[];
  missingPackages: string[];
  log: string;
  durationMs: number;
}

const FILE_NAME = /^[A-Za-z0-9_-]{1,60}\.csv$/;

/**
 * Compiles generated documents in a throwaway workspace: a new owner-only
 * folder under `workRoot` (never a project), the existing hardened
 * `compileProject` (latexmk -norc, no shell escape, reads and writes only
 * below the workspace, sanitised environment, link check, time limit,
 * process-tree kill), then the folder is removed whatever happened. Packages
 * are checked first and never installed.
 */
export class IsolatedCompiler {
  private readonly available = new Map<string, boolean>();

  constructor(
    private readonly options: { latexmkPath: string | null; kpsewhichPath: string | null; workRoot: string; timeoutMs: number },
  ) {}

  get enabled(): boolean {
    return !!this.options.latexmkPath;
  }

  /** Which of the packages are missing from the TeX installation. */
  async missingPackages(packages: readonly string[]): Promise<string[]> {
    if (!this.options.kpsewhichPath) return [];
    const unknown = packages.filter((p) => !this.available.has(p) && /^[a-z]+$/.test(p));
    if (unknown.length) {
      await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
      const r = await runProcess({ command: this.options.kpsewhichPath, args: unknown.map((p) => `${p}.sty`), cwd: this.options.workRoot, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
      const found = r.output.split(/\r?\n/).map((l) => path.basename(l.trim()).replace(/\.sty$/, ''));
      for (const p of unknown) this.available.set(p, found.includes(p));
    }
    return packages.filter((p) => this.available.get(p) === false);
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    if (!this.options.latexmkPath) throw new VisualError('compile-unavailable', 'No LaTeX toolchain was found (latexmk); generated source cannot be compiled');
    const started = Date.now();
    const body = req.document.slice(req.document.indexOf('\\begin{document}') + '\\begin{document}'.length, req.document.lastIndexOf('\\end{document}'));
    const issues = [...checkLatexSafety(body), ...checkStructure(body)];
    for (const name of Object.keys(req.files ?? {})) if (!FILE_NAME.test(name)) issues.push({ severity: 'error', message: `Invalid data file name ${name.slice(0, 40)}`, at: null });
    if (hasErrors(issues)) return { status: 'invalid', pdf: null, diagnostics: [], issues, missingPackages: [], log: '', durationMs: Date.now() - started };
    const missingPackages = await this.missingPackages(req.packages);
    if (missingPackages.length) {
      return {
        status: 'failed',
        pdf: null,
        diagnostics: missingPackages.map((p) => ({ severity: 'error', source: 'runtime', message: `The LaTeX package ${p} is not installed. Install it with your TeX distribution's package manager; Research Studio does not install packages.`, file: null, line: null, context: null })),
        issues,
        missingPackages,
        log: '',
        durationMs: Date.now() - started,
      };
    }
    await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
    const dir = path.join(this.options.workRoot, `vb-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { mode: 0o700 });
    try {
      await writeFile(path.join(dir, 'main.tex'), req.document, { mode: 0o600 });
      for (const [name, content] of Object.entries(req.files ?? {})) await writeFile(path.join(dir, name), content, { mode: 0o600 });
      const outcome = await compileProject({
        latexmkPath: this.options.latexmkPath,
        projectRoot: dir,
        mainFile: 'main.tex',
        engine: 'pdflatex',
        timeoutMs: req.timeoutMs ?? this.options.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (outcome.cancelled) throw new VisualError('cancelled', 'Compilation was cancelled');
      const pdf = outcome.pdfAvailable && outcome.exitCode === 0 ? await readFile(outcome.artifacts.pdfPath) : null;
      const errors = outcome.diagnostics.filter((d) => d.severity === 'error');
      const notFound = [...outcome.output.matchAll(/File `([A-Za-z0-9_.-]+)\.sty' not found/g)].map((m) => m[1]!);
      return {
        status: pdf && !errors.length && !outcome.timedOut ? 'succeeded' : 'failed',
        pdf: errors.length ? null : pdf,
        diagnostics: outcome.diagnostics.slice(0, 200),
        issues,
        missingPackages: [...new Set(notFound)],
        log: outcome.output.slice(-20_000),
        durationMs: Date.now() - started,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
