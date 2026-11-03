import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeStagingDir, StagingWorkspace } from '../src';

let tmp: string;
let project: string;
let stagingRoot: string;
let outside: string;

/** Directory link: a junction on Windows (no privileges needed), a symlink elsewhere. */
async function linkDir(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rs-staging-')));
  project = path.join(tmp, 'project');
  stagingRoot = path.join(tmp, 'data', 'agent-workspaces');
  outside = path.join(tmp, 'outside');
  await mkdir(path.join(project, 'sections'), { recursive: true });
  await writeFile(path.join(project, 'main.tex'), 'main\n');
  await writeFile(path.join(project, 'sections', 'a.tex'), 'aaa\n');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'keep.txt'), 'must survive');
});
afterEach(() => rm(tmp, { recursive: true, force: true, maxRetries: 5 }));

const workspace = (over: Partial<{ projectRoot: string; stagingRoot: string; sessionId: string }> = {}) =>
  new StagingWorkspace({ projectRoot: project, stagingRoot, sessionId: 'conv1', ...over });

describe('staging containment', () => {
  it.each(['..', '../x', 'a/b', 'a\\b', '', 'A', '-x', 'x'.repeat(65)])('rejects the session id %j', (sessionId) => {
    expect(() => workspace({ sessionId })).toThrow(/session id/);
  });

  it('places each session in its own directory under the staging root', async () => {
    const a = workspace({ sessionId: 'conv-a' });
    const b = workspace({ sessionId: 'conv-b' });
    expect(a.dir).toBe(path.join(stagingRoot, 'conv-a'));
    await a.prepare();
    await b.prepare();
    await writeFile(path.join(a.dir, 'main.tex'), 'changed by a\n');
    expect((await b.diff()).changes).toEqual([]);
  });

  it('rejects a staging root inside the project, including one named ..staging', () => {
    for (const root of [path.join(project, '..staging'), path.join(project, '...data', 'stage'), path.join(project, 'sections')]) {
      expect(() => workspace({ stagingRoot: root })).toThrow(/outside the project/);
    }
  });

  it('rejects a project inside the staging root', () => {
    expect(() => workspace({ stagingRoot: tmp })).toThrow(/outside the project/);
  });

  it('accepts a sibling whose name only shares a prefix with the project', async () => {
    const ws = workspace({ stagingRoot: `${project}-staging` });
    await expect(ws.prepare()).resolves.toMatchObject({ files: 2 });
  });

  it('detects a staging root that reaches into the project through a link', async (ctx) => {
    if (!(await linkDir(project, path.join(tmp, 'disguised')))) return ctx.skip();
    const ws = workspace({ stagingRoot: path.join(tmp, 'disguised', 'stage') });
    await expect(ws.prepare()).rejects.toThrow(/outside the project/);
    expect(existsSync(path.join(project, 'stage'))).toBe(false);
  });

  it('does not follow links the agent creates, and reports them', async (ctx) => {
    const ws = workspace();
    await ws.prepare();
    if (!(await linkDir(outside, path.join(ws.dir, 'escape')))) return ctx.skip();
    const { changes, ignored } = await ws.diff();
    expect(changes).toEqual([]);
    expect(ignored).toEqual([{ path: 'escape', reason: 'link (not followed)' }]);
  });

  it('removing a copy never deletes what links inside it point to', async (ctx) => {
    const ws = workspace();
    await ws.prepare();
    if (!(await linkDir(outside, path.join(ws.dir, 'escape')))) return ctx.skip();
    await linkDir(project, path.join(ws.dir, 'project-link'));
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('must survive');
    expect(await readFile(path.join(project, 'main.tex'), 'utf8')).toBe('main\n');
  });

  it('when the session directory itself was replaced by a link, only the link is removed', async (ctx) => {
    await mkdir(stagingRoot, { recursive: true });
    if (!(await linkDir(project, path.join(stagingRoot, 'conv1')))) return ctx.skip();
    const ws = workspace();
    await expect(ws.prepare()).rejects.toThrow(/outside/);
    await removeStagingDir(stagingRoot, path.join(stagingRoot, 'conv1'));
    expect(existsSync(path.join(stagingRoot, 'conv1'))).toBe(false);
    expect(await readFile(path.join(project, 'main.tex'), 'utf8')).toBe('main\n');
  });

  it('refuses to remove anything that is not strictly inside the staging root', async () => {
    for (const dir of [stagingRoot, path.dirname(stagingRoot), project, path.join(stagingRoot, '..', 'other')]) {
      await expect(removeStagingDir(stagingRoot, dir)).rejects.toThrow(/outside the staging root/);
    }
    expect(existsSync(path.join(project, 'main.tex'))).toBe(true);
  });
});
