import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { areDisjoint, assertDisjoint, ContainmentError, isWithin, PathGuard, resolveWithin } from '../src/node';

const { win32, posix } = path;

describe('isWithin (segment-aware, lexical)', () => {
  it.each([
    ['child directory', '/srv/stage', '/srv/stage/conv1', true],
    ['the root itself', '/srv/stage', '/srv/stage', true],
    ['parent directory', '/srv/stage', '/srv', false],
    ['sibling directory', '/srv/stage', '/srv/stage2', false],
    ['sibling sharing a prefix', '/srv/stage', '/srv/stage-old/x', false],
    ['directory named ..staging', '/srv/stage', '/srv/stage/..staging', true],
    ['directory named ...data', '/srv/stage', '/srv/stage/...data', true],
    ['traversal', '/srv/stage', '/srv/stage/a/../../etc', false],
    ['absolute path elsewhere', '/srv/stage', '/etc/passwd', false],
  ])('posix: %s', (_name, root, candidate, expected) => {
    expect(isWithin(root, candidate, posix)).toBe(expected);
  });

  it.each([
    ['child', 'C:\\data\\stage', 'C:\\data\\stage\\conv1', true],
    ['mixed separators', 'C:\\data\\stage', 'C:/data/stage/conv1', true],
    ['case-insensitive', 'C:\\Data\\Stage', 'c:\\data\\stage\\conv1', true],
    ['traversal with mixed separators', 'C:\\data\\stage', 'C:\\data\\stage/conv1\\..\\../secret', false],
    ['traversal with forward slashes', 'C:\\data\\stage', 'C:/data/stage/../stage2', false],
    ['..staging inside', 'C:\\data\\stage', 'C:\\data\\stage\\..staging', true],
    ['other drive', 'C:\\data\\stage', 'D:\\data\\stage\\x', false],
    ['UNC path', 'C:\\data\\stage', '\\\\server\\share\\stage', false],
    ['sibling with prefix', 'C:\\data\\stage', 'C:\\data\\stage2', false],
  ])('win32: %s', (_name, root, candidate, expected) => {
    expect(isWithin(root, candidate, win32)).toBe(expected);
  });

  it('only treats backslashes as separators on Windows', () => {
    // On POSIX `..\x` is an ordinary file name inside the root.
    expect(isWithin('/srv/stage', '/srv/stage/..\\x', posix)).toBe(true);
    expect(isWithin('C:\\srv\\stage', 'C:\\srv\\stage\\..\\x', win32)).toBe(false);
  });

  it('detects overlapping trees in both directions', () => {
    expect(areDisjoint('/a/project', '/a/data/stage', posix)).toBe(true);
    expect(areDisjoint('/a/project', '/a/project/..stage', posix)).toBe(false);
    expect(areDisjoint('/a/project/sub', '/a/project', posix)).toBe(false);
  });
});

describe('resolveWithin / assertDisjoint (real file system)', () => {
  let tmp: string;
  let root: string;
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

  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rs-contain-')));
    root = path.join(tmp, 'stage');
    outside = path.join(tmp, 'outside');
    await mkdir(path.join(root, 'conv1', 'sub'), { recursive: true });
    await mkdir(path.join(root, '..staging'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('accepts children, including names that start with two dots, and paths that do not exist yet', async () => {
    expect(await resolveWithin(root, 'conv1/sub')).toBe(path.join(root, 'conv1', 'sub'));
    expect(await resolveWithin(root, '..staging')).toBe(path.join(root, '..staging'));
    expect(await resolveWithin(root, '...data/new/file.txt')).toBe(path.join(root, '...data', 'new', 'file.txt'));
  });

  it('rejects parent, sibling, traversal and absolute paths outside the root', async () => {
    for (const candidate of ['..', '../outside', 'conv1/../../outside/secret.txt', 'conv1\\..\\..\\outside', outside, path.join(tmp, 'stage2')]) {
      await expect(resolveWithin(root, candidate)).rejects.toBeInstanceOf(ContainmentError);
    }
  });

  it('rejects a link that points outside the root, and accepts one that stays inside', async (ctx) => {
    if (!(await linkDir(outside, path.join(root, 'escape')))) return ctx.skip();
    await expect(resolveWithin(root, 'escape')).rejects.toThrow(/resolves outside/);
    await expect(resolveWithin(root, 'escape/secret.txt')).rejects.toThrow(/resolves outside/);
    await expect(resolveWithin(root, 'escape/not-yet-created.txt')).rejects.toThrow(/resolves outside/);
    await linkDir(path.join(root, 'conv1'), path.join(root, 'alias'));
    expect(await resolveWithin(root, 'alias/sub')).toBe(path.join(root, 'conv1', 'sub'));
  });

  it('fails closed when the root itself cannot be resolved', async () => {
    await expect(resolveWithin(path.join(tmp, 'missing-root'), 'x')).rejects.toBeInstanceOf(ContainmentError);
  });

  it('refuses overlapping trees, also when a link hides the overlap', async (ctx) => {
    const project = path.join(tmp, 'project');
    await mkdir(project, { recursive: true });
    await expect(assertDisjoint(project, path.join(project, '..stage'), 'overlap')).rejects.toThrow('overlap');
    await expect(assertDisjoint(project, path.join(tmp, 'data', 'stage'), 'overlap')).resolves.toBeUndefined();
    if (!(await linkDir(project, path.join(tmp, 'project-link')))) return ctx.skip();
    await expect(assertDisjoint(project, path.join(tmp, 'project-link', 'stage'), 'overlap')).rejects.toThrow('overlap');
  });

  it('PathGuard accepts project files whose names start with two dots', async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.resolve('..staging')).resolves.toMatchObject({ abs: path.join(root, '..staging') });
    expect(guard.toProjectPath(path.join(root, '..staging'))).toBe('..staging');
    expect(guard.toProjectPath(path.join(tmp, 'outside', 'secret.txt'))).toBeNull();
  });
});
