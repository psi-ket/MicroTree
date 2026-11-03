import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAuthorizedRoot, PathGuard, ProjectFs, sha256 } from '../src/node';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'rs-docengine-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'top secret');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const code = (c: string) => expect.objectContaining({ code: c });

describe('ProjectFs', () => {
  it('writes, reads and hashes text files', async () => {
    const fs = await ProjectFs.open(root);
    const written = await fs.writeText('chapters/intro.tex', 'Hello');
    expect(written.hash).toBe(sha256('Hello'));
    const read = await fs.readText('chapters/intro.tex');
    expect(read.content).toBe('Hello');
    expect(read.kind).toBe('tex');
  });

  it('enforces createOnly and optimistic concurrency', async () => {
    const fs = await ProjectFs.open(root);
    const v1 = await fs.writeText('a.tex', 'one', { createOnly: true });
    await expect(fs.writeText('a.tex', 'x', { createOnly: true })).rejects.toThrowError(code('ALREADY_EXISTS'));
    const v2 = await fs.writeText('a.tex', 'two', { baseHash: v1.hash });
    await expect(fs.writeText('a.tex', 'three', { baseHash: v1.hash })).rejects.toThrowError(code('CONFLICT'));
    await fs.writeText('a.tex', 'three', { baseHash: v2.hash });
    expect((await fs.readText('a.tex')).content).toBe('three');
  });

  it('refuses non-editable extensions and reserved dirs', async () => {
    const fs = await ProjectFs.open(root);
    await expect(fs.writeText('run.exe', 'x')).rejects.toThrowError(code('UNSUPPORTED_MEDIA_TYPE'));
    await expect(fs.writeText('.rs-build/main.tex', 'x')).rejects.toThrowError(code('PATH_VIOLATION'));
  });

  it('rejects traversal', async () => {
    const fs = await ProjectFs.open(root);
    await expect(fs.readText('../outside/secret.txt')).rejects.toThrowError(code('PATH_VIOLATION'));
    await expect(fs.writeText(path.join(outside, 'x.tex'), 'x')).rejects.toThrowError(code('PATH_VIOLATION'));
  });

  it('rejects escapes through directory links', async () => {
    // Junctions work without elevated privileges on Windows; symlinks elsewhere.
    await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const fs = await ProjectFs.open(root);
    await expect(fs.readText('link/secret.txt')).rejects.toThrowError(code('PATH_VIOLATION'));
    await expect(fs.writeText('link/new.tex', 'x')).rejects.toThrowError(code('PATH_VIOLATION'));
    await expect(fs.writeText('link/deeper/new.tex', 'x')).rejects.toThrowError(code('PATH_VIOLATION'));
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    const tree = await fs.tree();
    expect(tree.children?.some((c) => c.name === 'link')).toBe(false);
  });

  it('builds a sorted tree skipping build output', async () => {
    const fs = await ProjectFs.open(root);
    await fs.writeText('main.tex', 'x');
    await fs.writeText('sections/b.tex', 'x');
    await fs.writeText('sections/a10.tex', 'x');
    await fs.writeText('sections/a2.tex', 'x');
    await mkdir(path.join(root, '.rs-build'));
    await writeFile(path.join(root, '.rs-build', 'main.pdf'), 'x');
    const tree = await fs.tree();
    expect(tree.children?.map((c) => c.path)).toEqual(['sections', 'main.tex']);
    expect(tree.children?.[0]?.children?.map((c) => c.name)).toEqual(['a2.tex', 'a10.tex', 'b.tex']);
  });

  it('renames, makes directories and removes', async () => {
    const fs = await ProjectFs.open(root);
    await fs.writeText('old.tex', 'x');
    await fs.mkdir('figures');
    await expect(fs.mkdir('figures')).rejects.toThrowError(code('ALREADY_EXISTS'));
    await fs.rename('old.tex', 'sections/new.tex');
    expect(await fs.exists('old.tex')).toBe(false);
    expect(await fs.exists('sections/new.tex')).toBe(true);
    await expect(fs.rename('sections', 'sections/inner')).rejects.toThrowError(code('BAD_REQUEST'));
    await fs.remove('sections');
    expect(await fs.exists('sections')).toBe(false);
    await expect(fs.remove('')).rejects.toThrowError(code('PATH_VIOLATION'));
  });

  it('writes binary files without overwriting', async () => {
    const fs = await ProjectFs.open(root);
    const a = await fs.writeBinaryUnique('figures/plot.png', new Uint8Array([1]));
    const b = await fs.writeBinaryUnique('figures/plot.png', new Uint8Array([2]));
    expect(a.path).toBe('figures/plot.png');
    expect(b.path).toBe('figures/plot-1.png');
  });

  it('rejects invalid UTF-8', async () => {
    await writeFile(path.join(root, 'latin1.tex'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const fs = await ProjectFs.open(root);
    await expect(fs.readText('latin1.tex')).rejects.toThrowError(code('UNSUPPORTED_MEDIA_TYPE'));
  });
});

describe('PathGuard', () => {
  it('maps absolute tool output back to project paths', async () => {
    const guard = await PathGuard.create(root);
    expect(guard.toProjectPath(path.join(guard.root, 'sections', 'a.tex'))).toBe('sections/a.tex');
    expect(guard.toProjectPath(path.join(outside, 'secret.txt'))).toBeNull();
  });
});

describe('assertAuthorizedRoot', () => {
  it('accepts directories strictly inside an authorized root', async () => {
    await expect(assertAuthorizedRoot(root, [base])).resolves.toBeTruthy();
    await expect(assertAuthorizedRoot(base, [base])).rejects.toThrowError(code('FORBIDDEN'));
    await expect(assertAuthorizedRoot(outside, [root])).rejects.toThrowError(code('FORBIDDEN'));
  });
});
