/**
 * End-to-end runtime workflow over HTTP: projects, files, uploads, real
 * latexmk compilation, SyncTeX, and persistence across a restart.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CompileJob, FileTreeNode, Project } from '@research-studio/shared-types';
import type { ServerEvent } from '@research-studio/api-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRuntime, multipart, PNG_BYTES, toolchain, type TestRuntime } from './helpers';

let rt: TestRuntime;
let project: Project;
let hasTex = false;

beforeAll(async () => {
  rt = await createTestRuntime();
  hasTex = (await toolchain()).paths.latexmk !== null;
});

afterAll(async () => {
  await rt.dispose();
});

const flatten = (node: FileTreeNode): string[] =>
  node.children?.flatMap((c) => [c.path, ...flatten(c)]) ?? [];

async function compileAndWait(projectId: string): Promise<CompileJob> {
  const finished = new Promise<CompileJob>((resolve) => {
    const off = rt.events.subscribe((e: ServerEvent) => {
      if (e.type === 'compile.finished' && e.job.projectId === projectId) {
        off();
        resolve(e.job);
      }
    });
  });
  const res = await rt.request('POST', `/api/v1/projects/${projectId}/compile`);
  expect(res.statusCode).toBe(202);
  return finished;
}

describe('projects and files', () => {
  it('creates a project from a template', async () => {
    const res = await rt.request('POST', '/api/v1/projects', {
      body: { name: 'Quantum Notes & Errata', template: 'article', author: 'Ada' },
    });
    expect(res.statusCode).toBe(201);
    project = res.json<{ project: Project }>().project;
    expect(project).toMatchObject({ slug: 'quantum-notes-errata', mainFile: 'main.tex', engine: 'pdflatex' });
    expect(path.dirname(project.rootPath)).toBe(rt.config.workspaceRoot);

    const tree = (await rt.request('GET', `/api/v1/projects/${project.id}/tree`)).json<{ tree: FileTreeNode }>().tree;
    expect(flatten(tree)).toEqual(['figures', 'sections', 'sections/introduction.tex', 'main.tex', 'references.bib']);

    const main = (await rt.request('GET', `/api/v1/projects/${project.id}/files/content?path=main.tex`)).json<{ content: string }>();
    expect(main.content).toContain('\\title{Quantum Notes \\& Errata}');
  });

  it('creates unique slugs for duplicate names', async () => {
    const res = await rt.request('POST', '/api/v1/projects', { body: { name: 'Quantum Notes & Errata', template: 'empty' } });
    expect(res.json<{ project: Project }>().project.slug).toBe('quantum-notes-errata-2');
    const list = (await rt.request('GET', '/api/v1/projects')).json<{ projects: Project[] }>().projects;
    expect(list).toHaveLength(2);
  });

  it('validates project input', async () => {
    const res = await rt.request('POST', '/api/v1/projects', { body: { name: '', template: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('saves with optimistic concurrency', async () => {
    const url = `/api/v1/projects/${project.id}/files/content`;
    const v1 = (await rt.request('GET', `${url}?path=sections/introduction.tex`)).json<{ hash: string }>();
    const save = await rt.request('PUT', url, {
      body: { path: 'sections/introduction.tex', content: '\\section{Intro}\\label{sec:intro}\nUpdated.\n', baseHash: v1.hash },
    });
    expect(save.statusCode).toBe(200);
    const stale = await rt.request('PUT', url, { body: { path: 'sections/introduction.tex', content: 'x', baseHash: v1.hash } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('creates, renames and deletes entries', async () => {
    const base = `/api/v1/projects/${project.id}`;
    expect((await rt.request('POST', `${base}/files`, { body: { path: 'chapters', type: 'directory' } })).statusCode).toBe(201);
    const created = await rt.request('POST', `${base}/files`, {
      body: { path: 'chapters/methods.tex', type: 'file', content: '\\section{Methods}\\label{sec:methods}\n' },
    });
    expect(created.statusCode).toBe(201);
    const dup = await rt.request('POST', `${base}/files`, { body: { path: 'chapters/methods.tex', type: 'file' } });
    expect(dup.statusCode).toBe(409);
    const binary = await rt.request('POST', `${base}/files`, { body: { path: 'x.exe', type: 'file' } });
    expect(binary.statusCode).toBe(415);

    const renamed = await rt.request('POST', `${base}/files/rename`, {
      body: { from: 'chapters/methods.tex', to: 'sections/methods.tex' },
    });
    expect(renamed.json()).toEqual({ entry: { path: 'sections/methods.tex', type: 'file' } });
    expect((await rt.request('DELETE', `${base}/files?path=chapters`)).statusCode).toBe(204);
    const tree = (await rt.request('GET', `${base}/tree`)).json<{ tree: FileTreeNode }>().tree;
    expect(flatten(tree)).not.toContain('chapters');
    expect(flatten(tree)).toContain('sections/methods.tex');
  });

  it('keeps the main file pointer when the main file is renamed', async () => {
    const base = `/api/v1/projects/${project.id}`;
    await rt.request('POST', `${base}/files/rename`, { body: { from: 'main.tex', to: 'paper.tex' } });
    expect((await rt.request('GET', base)).json<{ project: Project }>().project.mainFile).toBe('paper.tex');
    await rt.request('POST', `${base}/files/rename`, { body: { from: 'paper.tex', to: 'main.tex' } });
    expect((await rt.request('GET', base)).json<{ project: Project }>().project.mainFile).toBe('main.tex');
  });

  it('uploads images into project directories', async () => {
    const form = multipart({ directory: 'figures' }, { name: 'My Plot.PNG', bytes: PNG_BYTES, type: 'image/png' });
    const res = await rt.request('POST', `/api/v1/projects/${project.id}/uploads`, {
      body: form.body,
      headers: { 'content-type': form.contentType },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ file: { path: 'figures/My-Plot.png', size: PNG_BYTES.byteLength } });
    const raw = await rt.request('GET', `/api/v1/projects/${project.id}/files/raw?path=figures/My-Plot.png`);
    expect(raw.headers['content-type']).toBe('image/png');
    expect(raw.headers['content-security-policy']).toContain('sandbox');
    expect(raw.rawPayload.equals(Buffer.from(PNG_BYTES))).toBe(true);
  });

  it('collects labels and citation keys for completion', async () => {
    const res = await rt.request('GET', `/api/v1/projects/${project.id}/symbols`);
    const symbols = res.json<{ labels: { label: string }[]; citations: { key: string }[] }>();
    expect(symbols.labels.map((l) => l.label).sort()).toEqual(['sec:intro', 'sec:methods']);
    expect(symbols.citations.map((c) => c.key).sort()).toEqual(['knuth1984literate', 'lamport1994latex']);
  });

  it('persists settings', async () => {
    const res = await rt.request('PATCH', '/api/v1/settings', { body: { theme: 'dark', autosaveDelayMs: 2000 } });
    expect(res.json()).toMatchObject({ settings: { theme: 'dark', autosaveDelayMs: 2000, autosave: true } });
    expect((await rt.request('PATCH', '/api/v1/settings', { body: { editorFontSize: 99 } })).statusCode).toBe(400);
  });
});

describe('compilation', () => {
  it('compiles with latexmk, serves the PDF and supports SyncTeX', async (ctx) => {
    if (!hasTex) return ctx.skip();
    // Use the uploaded figure so the image path is exercised end-to-end.
    const base = `/api/v1/projects/${project.id}`;
    const main = (await rt.request('GET', `${base}/files/content?path=main.tex`)).json<{ content: string; hash: string }>();
    const content = main.content.replace(
      '\\input{sections/introduction}',
      '\\input{sections/introduction}\n\\input{sections/methods}\n\\begin{figure}[h]\\centering\\includegraphics[width=2cm]{My-Plot.png}\\caption{Plot}\\end{figure}',
    );
    await rt.request('PUT', `${base}/files/content`, { body: { path: 'main.tex', content, baseHash: main.hash } });
    await rt.request('PUT', `${base}/files/content`, {
      body: {
        path: 'sections/introduction.tex',
        content:
          '\\section{Intro}\\label{sec:intro}\nUpdated introduction with enough words to form a proper paragraph of text,\nso that SyncTeX has a well-defined box to map back to this file~\\cite{knuth1984literate}.\n\n',
      },
    });

    const outputs: string[] = [];
    const off = rt.events.subscribe((e) => {
      if (e.type === 'compile.output') outputs.push(e.chunk);
    });
    const job = await compileAndWait(project.id);
    off();
    expect(job.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(job).toMatchObject({ status: 'succeeded', pdfAvailable: true, exitCode: 0 });
    expect(outputs.join('')).toContain('Latexmk');

    const pdf = await rt.request('GET', `${base}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const detail = await rt.request('GET', `${base}/compile/jobs/${job.id}`);
    expect(detail.json<{ output: string }>().output).toContain('Latexmk');

    const forward = await rt.request('POST', `${base}/synctex/forward`, {
      body: { file: 'sections/introduction.tex', line: 2, column: 0 },
    });
    const rects = forward.json<{ rects: { page: number; x: number; y: number; height: number }[] }>().rects;
    expect(rects.length).toBeGreaterThan(0);
    const r = rects[0]!;
    const inverse = await rt.request('POST', `${base}/synctex/inverse`, {
      body: { page: r.page, x: r.x + 2, y: r.y + r.height / 2 },
    });
    expect(inverse.json()).toMatchObject({ location: { file: 'sections/introduction.tex', line: 2 } });
  }, 180_000);

  it('reports compile errors as diagnostics', async (ctx) => {
    if (!hasTex) return ctx.skip();
    const base = `/api/v1/projects/${project.id}`;
    await rt.request('PUT', `${base}/files/content`, {
      body: { path: 'sections/methods.tex', content: '\\section{Methods}\n\\badmacro\n' },
    });
    const job = await compileAndWait(project.id);
    expect(job.status).toBe('failed');
    expect(job.errorCount).toBeGreaterThan(0);
    expect(job.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', file: 'sections/methods.tex', line: 2 }),
    );
    // The PDF from the partial run is still served.
    expect((await rt.request('GET', `${base}/pdf`)).statusCode).toBe(200);
  }, 180_000);

  it('coalesces repeated compile requests and supports cancellation', async (ctx) => {
    if (!hasTex) return ctx.skip();
    const created = await rt.request('POST', '/api/v1/projects', { body: { name: 'Looping', template: 'empty' } });
    const loop = created.json<{ project: Project }>().project;
    await rt.request('PUT', `/api/v1/projects/${loop.id}/files/content`, {
      body: { path: 'main.tex', content: '\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}\n' },
    });
    const first = (await rt.request('POST', `/api/v1/projects/${loop.id}/compile`)).json<{ job: CompileJob }>().job;
    await new Promise((r) => setTimeout(r, 800));
    const second = (await rt.request('POST', `/api/v1/projects/${loop.id}/compile`)).json<{ job: CompileJob }>().job;
    const third = (await rt.request('POST', `/api/v1/projects/${loop.id}/compile`)).json<{ job: CompileJob }>().job;
    expect(second.id).not.toBe(first.id);
    expect(third.id).toBe(second.id); // queued behind the running one: coalesced
    await rt.request('POST', `/api/v1/projects/${loop.id}/compile/cancel`);
    await rt.request('POST', `/api/v1/projects/${loop.id}/compile/cancel`);
    await rt.compile.whenIdle();
    const jobs = (await rt.request('GET', `/api/v1/projects/${loop.id}/compile/jobs`)).json<{ jobs: CompileJob[] }>().jobs;
    expect(jobs.map((j) => j.status).sort()).toEqual(['cancelled', 'cancelled']);
  }, 120_000);
});

describe('persistence', () => {
  it('keeps projects, files, jobs and settings across a runtime restart', async () => {
    rt = await rt.restart();
    const list = (await rt.request('GET', '/api/v1/projects')).json<{ projects: Project[] }>().projects;
    expect(list.map((p) => p.id)).toContain(project.id);
    const file = await rt.request('GET', `/api/v1/projects/${project.id}/files/content?path=sections/introduction.tex`);
    expect(file.json<{ content: string }>().content).toContain('Updated introduction');
    expect((await rt.request('GET', '/api/v1/settings')).json()).toMatchObject({ settings: { theme: 'dark' } });
    if (hasTex) {
      const jobs = (await rt.request('GET', `/api/v1/projects/${project.id}/compile/jobs`)).json<{ jobs: CompileJob[] }>().jobs;
      expect(jobs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('removes projects, optionally deleting files', async () => {
    const res = await rt.request('DELETE', `/api/v1/projects/${project.id}?deleteFiles=true`);
    expect(res.statusCode).toBe(204);
    expect(existsSync(project.rootPath)).toBe(false);
    expect((await rt.request('GET', `/api/v1/projects/${project.id}`)).statusCode).toBe(404);
  });
});
