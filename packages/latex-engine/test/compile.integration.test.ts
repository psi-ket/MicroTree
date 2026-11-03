/**
 * Integration tests against the real TeX toolchain. They are skipped (with a
 * visible notice) only when latexmk is not installed on the machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LatexEngine } from '@research-studio/shared-types';
import {
  buildLatexmkArgs,
  buildSanitizedEnv,
  compileProject,
  findEscapingLinks,
  MAX_LOG_BYTES,
  detectToolchain,
  synctexForward,
  synctexInverse,
  validateMainFile,
  type Toolchain,
} from '../src';

let toolchain: Toolchain;
let base: string;

beforeAll(async () => {
  toolchain = await detectToolchain();
  base = await mkdtemp(path.join(os.tmpdir(), 'rs-latex-'));
  if (!toolchain.paths.latexmk) console.warn('latexmk not found: skipping TeX integration tests');
}, 30_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(name: string, files: Record<string, string>): Promise<string> {
  const root = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return root;
}

const compile = (root: string, extra: { timeoutMs?: number; signal?: AbortSignal; engine?: LatexEngine; env?: NodeJS.ProcessEnv } = {}) =>
  compileProject({
    latexmkPath: toolchain.paths.latexmk!,
    projectRoot: root,
    mainFile: 'main.tex',
    engine: extra.engine ?? 'pdflatex',
    timeoutMs: extra.timeoutMs ?? 90_000,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.env ? { env: extra.env } : {}),
  });

/** TeX source paths use forward slashes on every platform. */
const texPath = (p: string) => p.replace(/\\/g, '/');

describe('validateMainFile', () => {
  it.each(['-shell-escape.tex', 'a;b.tex', '$(id).tex', 'a`b`.tex', "it's.tex", 'main.md', '../main.tex'])(
    'rejects %s',
    (name) => {
      expect(() => validateMainFile(name)).toThrow();
    },
  );

  it('accepts ordinary names', () => {
    expect(validateMainFile('thesis/main file-v2.tex')).toBe('thesis/main file-v2.tex');
  });

  it('builds hardened arguments', () => {
    expect(buildLatexmkArgs('xelatex', 'main.tex')).toEqual([
      '-norc',
      '-pdfxe',
      '-f',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-outdir=.rs-build',
      'main.tex',
    ]);
  });
});

describe('toolchain', () => {
  it('detects the installed toolchain', () => {
    expect(toolchain.status.latexmk.available).toBe(toolchain.paths.latexmk !== null);
  });
});

const MAIN = String.raw`\documentclass{article}
\begin{document}
Hello world.

\input{sections/intro}

See~\cite{knuth}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;

describe('compileProject (real latexmk)', () => {
  it('compiles a multi-file project with BibTeX', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('ok', {
      'main.tex': MAIN,
      'sections/intro.tex': 'Introduction paragraph.\n',
      'refs.bib': '@book{knuth, author={Knuth}, title={TAOCP}, publisher={AW}, year=1968}\n',
    });
    const outcome = await compile(root);
    expect(outcome.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.pdfAvailable).toBe(true);
    expect(existsSync(outcome.artifacts.synctexPath)).toBe(true);
    expect(existsSync(path.join(root, '.rs-build', 'main.bbl'))).toBe(true);

    // SyncTeX forward: line 3 of main.tex is "Hello world." on page 1.
    if (toolchain.paths.synctex) {
      const ctxBase = { synctexPath: toolchain.paths.synctex, projectRoot: root, mainFile: 'main.tex' };
      const rects = await synctexForward({ ...ctxBase, file: 'main.tex', line: 3, column: 1 });
      expect(rects.length).toBeGreaterThan(0);
      expect(rects[0]!.page).toBe(1);
      const introRects = await synctexForward({ ...ctxBase, file: 'sections/intro.tex', line: 1, column: 1 });
      expect(introRects.length).toBeGreaterThan(0);

      // Inverse: the centre of the first rect maps back to main.tex line 3.
      const r = rects[0]!;
      const loc = await synctexInverse({ ...ctxBase, page: 1, x: r.x + 5, y: r.y + r.height / 2 });
      expect(loc).toEqual({ file: 'main.tex', line: 3, column: expect.any(Number) });
    }
  }, 120_000);

  it('reports errors with file and line', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('err', {
      'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\end{document}\n',
      'body.tex': 'Fine line.\n\\undefinedmacro\n',
    });
    const outcome = await compile(root);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', file: 'body.tex', line: 2, message: 'Undefined control sequence.' }),
    );
  }, 120_000);

  it('blocks shell escape, latexmkrc execution and writes outside the project', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const marker = path.join(base, 'pwned-shell.txt');
    const rcMarker = path.join(base, 'pwned-rc.txt');
    const escapeTarget = path.join(base, 'escaped');
    const perlPath = rcMarker.replace(/\\/g, '/');
    const root = await project('evil', {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\immediate\write18{echo pwned > "${marker.replace(/\\/g, '/')}"}
\newwrite\out
\immediate\openout\out=../escaped.tex
\immediate\write\out{escaped}
\immediate\closeout\out
x
\end{document}
`,
      latexmkrc: `open(my $fh, '>', '${perlPath}'); print $fh "pwned"; close($fh);\n`,
      '.latexmkrc': `open(my $fh, '>', '${perlPath}'); print $fh "pwned"; close($fh);\n`,
    });
    const outcome = await compile(root);
    // Fully disabled, not TeX Live's default "restricted" mode.
    const log = readFileSync(outcome.artifacts.logPath, 'utf8');
    expect(log).toMatch(/runsystem\(echo pwned[^\n]*\)\.\.\.disabled\.\r?$/m);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(rcMarker)).toBe(false);
    expect(existsSync(`${escapeTarget}.tex`)).toBe(false);
    expect(outcome.output).toMatch(/Rc files read:\s+NONE/);
  }, 120_000);

  it('kills runaway compilations at the timeout', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('loop', {
      'main.tex': '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n',
    });
    const started = Date.now();
    const outcome = await compile(root, { timeoutMs: 4_000 });
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ source: 'runtime', severity: 'error' }));
  }, 60_000);

  it('can be cancelled', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('cancel', {
      'main.tex': '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n',
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const outcome = await compile(root, { timeoutMs: 60_000, signal: controller.signal });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.timedOut).toBe(false);
  }, 60_000);

  it('fails clearly when the main file is missing', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('nomain', { 'other.tex': 'x' });
    await expect(compile(root)).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('TeX environment', () => {
  it('passes no secrets and restricts reads per engine', () => {
    const env = buildSanitizedEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y', RS_PAIRING_TOKEN: 't', TEXMFOUTPUT: '/' }, 'xelatex');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.RS_PAIRING_TOKEN).toBeUndefined();
    expect(env.TEXMFOUTPUT).toBe('');
    expect(env).toMatchObject({ shell_escape: 'f', openout_any: 'p', openin_any: 'p' });
    expect(buildSanitizedEnv({}, 'pdflatex').openin_any).toBe('p');
    expect(buildSanitizedEnv({}, 'lualatex').openin_any).toBe('a');
  });
});

describe('links out of the project', () => {
  it('finds links (also in the build directory) that resolve outside, and allows links inside', async () => {
    const outside = path.join(base, 'outside-dir');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.tex'), 'TOPSECRET\n');
    const root = await project('linked', { 'main.tex': 'x', 'sections/a.tex': 'a', '.rs-build/keep': '' });
    await symlink(path.join(root, 'sections'), path.join(root, 'alias'), 'junction');
    expect(await findEscapingLinks(root)).toEqual([]);
    await symlink(outside, path.join(root, 'shared'), 'junction');
    await symlink(outside, path.join(root, '.rs-build', 'out'), 'junction');
    expect(await findEscapingLinks(root)).toEqual(['.rs-build/out', 'shared']);
    // Refused before TeX runs.
    await expect(
      compileProject({ latexmkPath: path.join(base, 'never-run'), projectRoot: root, mainFile: 'main.tex', engine: 'pdflatex', timeoutMs: 1_000 }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/links that point outside/) }));
  });
});

describe('TeX sandbox (real latexmk)', () => {
  const SECRET = 'TOPSECRET-OUTSIDE-THE-PROJECT';

  for (const engine of ['pdflatex', 'xelatex'] as const) it(`${engine} cannot read files outside the project`, async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const secret = path.join(base, `secret-${engine}.tex`);
    await writeFile(secret, `${SECRET}\n`);
    const abs = texPath(secret);
    const root = await project(`read-${engine}`, {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\IfFileExists{${abs}}{\typeout{RS-ABS-READABLE}}{\typeout{RS-ABS-BLOCKED}}
\IfFileExists{../secret-${engine}.tex}{\typeout{RS-REL-READABLE}}{\typeout{RS-REL-BLOCKED}}
\newread\rsin
\immediate\openin\rsin=${abs}
\ifeof\rsin\typeout{RS-OPENIN-BLOCKED}\else\read\rsin to\rsline\typeout{RS-GOT:\rsline}\fi
x
\end{document}
`,
    });
    const outcome = await compile(root, { engine });
    const log = readFileSync(outcome.artifacts.logPath, 'utf8');
    expect(log).toContain('RS-ABS-BLOCKED');
    expect(log).toContain('RS-REL-BLOCKED');
    expect(log).toContain('RS-OPENIN-BLOCKED');
    expect(log).not.toContain(SECRET);
    expect(outcome.pdfAvailable).toBe(true);
    // Auxiliary files stay in the build directory.
    expect((await readdir(root)).sort()).toEqual(['.rs-build', 'main.tex']);
  }, 120_000);

  it('cannot write to an absolute path outside the project', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const target = path.join(base, 'abs-escaped.tex');
    const root = await project('write-abs', {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\newwrite\rsout
\immediate\openout\rsout=${texPath(target)}
\immediate\write\rsout{escaped}
\immediate\closeout\rsout
x
\end{document}
`,
    });
    await compile(root);
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  it('lualatex gets no secrets from the environment and cannot run commands', async (ctx) => {
    if (!toolchain.paths.latexmk || !toolchain.status.engines.lualatex) return ctx.skip();
    const root = await project('lua-env', {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\directlua{texio.write_nl("RS-ENV:" .. tostring(os.getenv("OPENAI_API_KEY")))}
\directlua{pcall(os.execute, "echo pwned > pwned-lua.txt")}
\directlua{pcall(function() local p = io.popen("echo pwned > pwned-popen.txt"); if p then p:close() end end)}
x
\end{document}
`,
    });
    const outcome = await compile(root, { engine: 'lualatex', env: { ...process.env, OPENAI_API_KEY: 'sk-must-not-reach-tex-0123456789' } });
    const log = readFileSync(outcome.artifacts.logPath, 'utf8');
    expect(log).toContain('RS-ENV:nil');
    expect(log).not.toContain('sk-must-not-reach-tex');
    expect(existsSync(path.join(root, 'pwned-lua.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'pwned-popen.txt'))).toBe(false);
    expect(outcome.pdfAvailable).toBe(true);
  }, 120_000);

  it('stops the whole process tree on cancel and leaves no stray files', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const root = await project('cancel-tree', {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\loop\message{still running}\iftrue\repeat
\end{document}
`,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_000);
    const outcome = await compile(root, { timeoutMs: 60_000, signal: controller.signal });
    expect(outcome.cancelled).toBe(true);
    // If TeX were still alive its log would keep growing.
    await new Promise((r) => setTimeout(r, 500));
    const size = async () => (existsSync(outcome.artifacts.logPath) ? (await stat(outcome.artifacts.logPath)).size : 0);
    const first = await size();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await size()).toBe(first);
    expect((await readdir(root)).sort()).toEqual(['.rs-build', 'main.tex']);
  }, 60_000);

  it('reads at most the first 8 MB of a huge log and says so', async (ctx) => {
    if (!toolchain.paths.latexmk) return ctx.skip();
    const line = 'abcdefghij'.repeat(20);
    const root = await project('huge-log', {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\newcount\rsn
\loop\message{${line}}\advance\rsn by 1\ifnum\rsn<60000\repeat
x
\end{document}
`,
    });
    const outcome = await compile(root);
    expect((await stat(outcome.artifacts.logPath)).size).toBeGreaterThan(MAX_LOG_BYTES);
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', source: 'runtime', message: expect.stringMatching(/only its first 8 MB/) }));
  }, 120_000);
});
