import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@research-studio/database';
import { buildDiagram, buildEquation, buildPlot, type ArtifactPayload } from '@research-studio/visual-engine';
import { ArtifactService, contentHash, lineDiff, loadedPackages, ProjectInsertionService, type InsertionFilesPort } from '../src';
import { eq, LINEAR_PLOT, QUBIT_RESONATOR } from '../../visual-engine/test/fixtures/structures';

const ts = '2026-11-04T10:00:00.000Z';
let handle: DatabaseHandle;
let artifacts: ArtifactService;
let files: Map<string, string>;
let insertion: ProjectInsertionService;
let failOn: string | null;

const MAIN = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nIntro.\n\\end{document}\n';

/** An in-memory project with the same compare-and-swap rules as ProjectService. */
const port: InsertionFilesPort = {
  listFiles: async () => [...files.keys()],
  read: async (_p, path) => (files.has(path) ? { content: files.get(path)!, hash: contentHash(files.get(path)!) } : null),
  write: async (_p, path, content, baseHash) => {
    if (path === failOn) throw new Error(`disk error writing ${path}`);
    const cur = files.get(path);
    if (baseHash === null && cur !== undefined) throw new Error('exists');
    if (baseHash !== null && (cur === undefined || contentHash(cur) !== baseHash)) throw new Error('stale');
    files.set(path, content);
    return { hash: contentHash(content) };
  },
  delete: async (_p, path) => void files.delete(path),
};

beforeEach(() => {
  handle = createDatabase(':memory:');
  handle.sqlite.prepare("INSERT INTO projects (id, name, slug, root_path, created_at, updated_at) VALUES ('p1', 'P', 'p', '/tmp/p', ?, ?)").run(ts, ts);
  artifacts = new ArtifactService(handle.db);
  files = new Map([['main.tex', MAIN]]);
  insertion = new ProjectInsertionService(handle.db, port);
  failOn = null;
});
afterEach(() => handle.close());

function approved(payload: ArtifactPayload) {
  const { artifact, version } = artifacts.create(payload, { projectId: 'p1', sourceAssetId: null, taskId: null, origin: 'model', changeDescription: 'Reconstructed' });
  artifacts.setCompilation(version.id, { status: 'succeeded' });
  return { artifact: artifacts.approve(artifact.id, 1), version: artifacts.current(artifact.id) };
}

const opts = { targetFile: 'main.tex', afterLine: null, directory: 'figures', label: null, caption: 'Coupling scheme.', addPreamble: false, mainFile: 'main.tex' };

describe('artifact versions', () => {
  it('adds versions instead of overwriting, restores by copying, and compares', () => {
    const { artifact } = artifacts.create(buildEquation(eq('a + b', 'equation')), { projectId: null, sourceAssetId: 'vas_1', taskId: 'vtk_1', origin: 'model', changeDescription: 'Reconstructed' });
    artifacts.addVersion(artifact.id, buildEquation(eq('a + c', 'equation')), 'manual', 'Fixed a symbol');
    const v3 = artifacts.restore(artifact.id, 1);
    expect(v3).toMatchObject({ versionNumber: 3, origin: 'restore', changeDescription: 'Restored version 1' });
    expect(v3.sourceCode).toBe(artifacts.version(artifact.id, 1)!.sourceCode);
    expect(artifacts.versions(artifact.id).map((v) => [v.versionNumber, v.origin])).toEqual([
      [3, 'restore'],
      [2, 'manual'],
      [1, 'model'],
    ]);
    expect(artifacts.require(artifact.id)).toMatchObject({ currentVersion: 3, sourceAssetId: 'vas_1' });
    expect(lineDiff('x\na + b\ny', 'x\na + c\ny')).toEqual([
      { kind: 'same', text: 'x' },
      { kind: 'removed', text: 'a + b' },
      { kind: 'added', text: 'a + c' },
      { kind: 'same', text: 'y' },
    ]);
  });

  it('marks invalid source and approves only a compiled version', () => {
    const { artifact, version } = artifacts.create(buildEquation(eq('\\frac{a}{b', 'equation')), { projectId: null, sourceAssetId: null, taskId: null, origin: 'model', changeDescription: 'x' });
    expect(version.compilationStatus).toBe('invalid');
    expect(version.warnings.some((w) => w.startsWith('Invalid:'))).toBe(true);
    expect(() => artifacts.approve(artifact.id, 1)).toThrow(/compile it first/);
  });
});

describe('project insertion', () => {
  it('plans an equation insertion as a reviewable change and applies it', async () => {
    const { artifact, version } = approved(buildEquation(eq('H = \\sum_i h_i Z_i', 'equation')));
    const plan = await insertion.plan('p1', artifact, version, { ...opts, label: 'eq:h' });
    expect(plan.createdFiles).toEqual([]);
    expect(plan.modifiedFiles[0]!.after).toContain('\\begin{equation}\n\\label{eq:h}\nH = \\sum_i h_i Z_i\n\\end{equation}\n\n\\end{document}');
    expect(files.get('main.tex')).toBe(MAIN); // planning changes nothing
    const done = await insertion.apply('p1', plan);
    expect(files.get('main.tex')).toBe(plan.modifiedFiles[0]!.after);
    expect(done.status).toBe('applied');
  });

  it('creates a separate figure file with a unique name and asks before changing the preamble', async () => {
    files.set('figures/transmon-coupled-to-a-resonator.tex', 'existing');
    const { artifact, version } = approved(buildDiagram(QUBIT_RESONATOR));
    const plan = await insertion.plan('p1', artifact, version, opts);
    expect(plan.createdFiles.map((f) => f.path)).toEqual(['figures/transmon-coupled-to-a-resonator-2.tex']);
    expect(plan.snippet).toContain('\\input{figures/transmon-coupled-to-a-resonator-2.tex}');
    expect(plan.snippet).toContain('\\caption{Coupling scheme.}');
    expect(plan.missingPackages).toEqual(['tikz']);
    expect(plan.warnings.join(' ')).toMatch(/does not load tikz/);
    expect(plan.modifiedFiles.map((m) => m.path)).toEqual(['main.tex']);
    expect(plan.modifiedFiles[0]!.after).not.toContain('\\usepackage{tikz}');
    const withPreamble = await insertion.plan('p1', artifact, version, { ...opts, addPreamble: true });
    expect(withPreamble.modifiedFiles).toHaveLength(1);
    expect(withPreamble.modifiedFiles[0]!.after).toMatch(/\\usepackage\{tikz\}\n\\usetikzlibrary\{[^}]+\}\n\\begin\{document\}/);
    expect(files.get('figures/transmon-coupled-to-a-resonator.tex')).toBe('existing');
  });

  it('writes plot source and CSV with project paths', async () => {
    const { artifact, version } = approved(buildPlot(LINEAR_PLOT));
    const plan = await insertion.plan('p1', artifact, version, { ...opts, targetFile: null });
    const [csv, tex] = plan.createdFiles;
    expect(csv!.path).toMatch(/^figures\/.*-data\.csv$/);
    expect(tex!.content).toContain(`{${csv!.path}}`);
    expect(tex!.content).not.toContain('plot-data.csv');
    await insertion.apply('p1', plan);
    expect(files.get(csv!.path)).toBe(version.dataCsv);
  });

  it('refuses unapproved versions, stale targets, and undoes partial writes', async () => {
    const { artifact, version } = artifacts.create(buildEquation(eq('x', 'inline')), { projectId: 'p1', sourceAssetId: null, taskId: null, origin: 'model', changeDescription: 'x' });
    await expect(insertion.plan('p1', artifact, version, opts)).rejects.toThrow(/Approve this version/);
    const a = approved(buildDiagram(QUBIT_RESONATOR));
    const plan = await insertion.plan('p1', a.artifact, a.version, opts);
    files.set('main.tex', `${MAIN}% edited meanwhile\n`);
    await expect(insertion.apply('p1', plan)).rejects.toThrow(/stale/);
    expect([...files.keys()]).toEqual(['main.tex']); // the figure file written first was removed again
    files.set('main.tex', MAIN);
    failOn = 'main.tex';
    await expect(insertion.apply('p1', await insertion.plan('p1', a.artifact, a.version, opts))).rejects.toThrow(/disk error/);
    expect([...files.keys()]).toEqual(['main.tex']);
  });

  it('rolls back an insertion, but not over later edits', async () => {
    const { artifact, version } = approved(buildDiagram(QUBIT_RESONATOR));
    const done = await insertion.apply('p1', await insertion.plan('p1', artifact, version, { ...opts, addPreamble: true }));
    expect(files.size).toBe(2);
    const ok = await insertion.rollback(done.id);
    expect(ok).toEqual({ restored: ['main.tex'], removed: ['figures/transmon-coupled-to-a-resonator.tex'] });
    expect(files.get('main.tex')).toBe(MAIN);
    await expect(insertion.rollback(done.id)).rejects.toThrow(/already rolled back/);
    const again = await insertion.apply('p1', await insertion.plan('p1', artifact, version, opts));
    files.set('main.tex', `${files.get('main.tex')}\n% my own edit`);
    await expect(insertion.rollback(again.id)).rejects.toThrow(/changed after the insertion[\s\S]*main.tex/);
    expect(files.get('main.tex')).toContain('my own edit');
  });

  it('reads packages from a preamble', () => {
    expect([...loadedPackages('\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath, pgfplots}\n% \\usepackage{x}\n\\begin{document}\\usepackage{late}')].sort()).toEqual(['amsmath', 'inputenc', 'pgfplots', 'tikz']);
  });
});
