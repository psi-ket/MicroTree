import { parseBibtex } from '@research-studio/document-engine';
import { StudioError, type ProjectReferenceSettings } from '@research-studio/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectLibraryService, citeText, textHash, type ProjectFilesPort } from '../src/projects/project-library-service';
import { createTestLibrary, type TestLibrary } from './fixtures/library';
import { fakeWork } from './fixtures/works';

/** In-memory project files with the runtime's compare-and-swap rule. */
class MemoryFiles implements ProjectFilesPort {
  files = new Map<string, string>();
  writes = 0;
  async listFiles() {
    return [...this.files.keys()];
  }
  async read(_p: string, path: string) {
    const content = this.files.get(path);
    return content === undefined ? null : { content, hash: textHash(content) };
  }
  async write(_p: string, path: string, content: string, baseHash: string | null) {
    const current = this.files.get(path);
    if ((current === undefined ? null : textHash(current)) !== baseHash) throw new StudioError('CONFLICT', 'changed');
    this.files.set(path, content);
    this.writes++;
  }
}

const shor = fakeWork({ title: 'Scheme for reducing decoherence in quantum computer memory', authors: [['Peter W.', 'Shor']], year: 1995, doi: '10.1103/physreva.52.r2493', venue: 'Physical Review A', publicationType: 'journal-article' });
const steane = fakeWork({ title: 'Error Correcting Codes in Quantum Theory', authors: [['Andrew', 'Steane']], year: 1996, doi: '10.1103/physrevlett.77.793', publicationType: 'journal-article', venue: 'Physical Review Letters' });
const knill = fakeWork({ title: 'Theory of quantum error-correcting codes', authors: [['Emanuel', 'Knill']], year: 1997, doi: '10.1103/physreva.55.900', publicationType: 'journal-article' });

let t: TestLibrary;
let files: MemoryFiles;
let refs: ProjectLibraryService;
let settings: Map<string, ProjectReferenceSettings>;
let project: string;
const ids: Record<string, string> = {};

beforeEach(async () => {
  t = await createTestLibrary();
  files = new MemoryFiles();
  settings = new Map();
  refs = new ProjectLibraryService(t.library, files, { get: (p) => settings.get(p) ?? null, set: (p, s) => settings.set(p, s) });
  project = t.addProject('Thesis');
  ids.shor = (await t.library.addWork(shor)).item.id;
  ids.steane = (await t.library.addWork(steane)).item.id;
  ids.knill = (await t.library.addWork(knill)).item.id;
});
afterEach(async () => {
  await t.close();
});

describe('project references', () => {
  it('writes cite commands for BibTeX and BibLaTeX styles', () => {
    expect(citeText('citep', ['shor1995scheme', 'steane1996error'])).toBe('\\citep{shor1995scheme,steane1996error}');
    expect(citeText('parencite', ['a'])).toBe('\\parencite{a}');
  });

  it('creates the .bib file from linked papers after a preview', async () => {
    refs.link(project, [ids.shor!, ids.steane!]);
    const preview = await refs.preview(project);
    expect(preview).toMatchObject({ path: 'references.bib', baseHash: null, original: '' });
    expect(preview.changes.map((c) => [c.citationKey, c.kind])).toEqual([
      ['shor1995scheme', 'add-entry'],
      ['steane1996error', 'add-entry'],
    ]);
    expect(files.writes).toBe(0);
    await refs.apply(project, { baseHash: preview.baseHash });
    const written = files.files.get('references.bib')!;
    expect(written).toBe(preview.proposed);
    expect(parseBibtex(written).entries.map((e) => e.key)).toEqual(['shor1995scheme', 'steane1996error']);
  });

  it('merges into an existing file by key and DOI, keeps custom fields, and reports collisions', async () => {
    const original = [
      '% my bibliography',
      '@article{shor1995scheme,',
      '  title = {Scheme for reducing decoherence in quantum computer memory},',
      '  author = {Shor, P. W.},',
      '  doi = {10.1103/PhysRevA.52.R2493},',
      '  mynote = {keep me},',
      '}',
      '',
      '@article{steane96,',
      '  title = {Error Correcting Codes in Quantum Theory},',
      '  doi = {10.1103/PhysRevLett.77.793}',
      '}',
      '',
      '@book{knill1997theory, title = {A completely different book}, year = 2001}',
      '',
    ].join('\n');
    files.files.set('refs.bib', original);
    await refs.updateSettings(project, { bibFile: 'refs.bib' });
    refs.link(project, [ids.shor!, ids.steane!, ids.knill!]);
    const preview = await refs.preview(project);
    const byKey = Object.fromEntries(preview.changes.map((c) => [c.citationKey, c]));
    expect(byKey.shor1995scheme).toMatchObject({ kind: 'add-fields', applicable: true });
    expect(byKey.shor1995scheme!.fields).toEqual(expect.arrayContaining(['journal', 'year']));
    expect(byKey.shor1995scheme!.fields).not.toContain('title');
    expect(byKey.steane1996error).toMatchObject({ kind: 'existing-key-for-doi', existingKey: 'steane96', applicable: false });
    expect(byKey.knill1997theory).toMatchObject({ kind: 'key-collision', applicable: false });

    // Only the reviewed, applicable changes are written; existing values stay as they were.
    await refs.apply(project, { baseHash: preview.baseHash });
    const after = files.files.get('refs.bib')!;
    expect(after.startsWith('% my bibliography\n')).toBe(true);
    const entries = parseBibtex(after).entries;
    expect(entries.map((e) => e.key)).toEqual(['shor1995scheme', 'steane96', 'knill1997theory']);
    const shorEntry = entries[0]!;
    expect(shorEntry.fields.find((f) => f.name === 'author')!.value).toBe('Shor, P. W.');
    expect(shorEntry.fields.find((f) => f.name === 'mynote')!.value).toBe('keep me');
    expect(shorEntry.fields.find((f) => f.name === 'journal')!.value).toBe('Physical Review A');
    expect(after).toContain('@book{knill1997theory, title = {A completely different book}, year = 2001}');
    // A second preview has nothing left to do.
    const again = await refs.preview(project);
    expect(again.changes.filter((c) => c.applicable)).toEqual([]);
  });

  it('applies only the selected changes', async () => {
    refs.link(project, [ids.shor!, ids.steane!]);
    const preview = await refs.preview(project);
    const changeIds = [preview.changes[1]!.id];
    // The preview of a selection shows exactly what applying it writes.
    const selected = await refs.preview(project, { changeIds });
    expect(selected.changes).toEqual(preview.changes);
    const { applied } = await refs.apply(project, { baseHash: null, changeIds });
    expect(applied.map((c) => c.citationKey)).toEqual(['steane1996error']);
    expect(parseBibtex(files.files.get('references.bib')!).entries.map((e) => e.key)).toEqual(['steane1996error']);
    expect(files.files.get('references.bib')).toBe(selected.proposed);
  });

  it('refuses to apply a preview of a file that changed since', async () => {
    files.files.set('references.bib', '@misc{a, title={A}}\n');
    refs.link(project, [ids.shor!]);
    const preview = await refs.preview(project);
    files.files.set('references.bib', '@misc{a, title={A}}\n@misc{b, title={B}}\n');
    await expect(refs.apply(project, { baseHash: preview.baseHash })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'STALE_PREVIEW' } });
    expect(files.files.get('references.bib')).toBe('@misc{a, title={A}}\n@misc{b, title={B}}\n');
  });

  it('only adds papers attached to the project, and only to .bib files inside it', async () => {
    await expect(refs.preview(project, { itemIds: [ids.shor!] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(refs.updateSettings(project, { bibFile: '../outside.bib' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(refs.updateSettings(project, { bibFile: 'main.tex' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('shows each cited key with where it is defined and which library item it is', async () => {
    files.files.set('main.tex', '\\documentclass{article}\n\\begin{document}\nSee \\citep{shor1995scheme, missing2020}.\n% \\cite{commented}\n\\textcite[p.~3]{onlybib}\n\\end{document}\n');
    files.files.set('chapters/two.tex', 'Again \\cite{shor1995scheme}.\n');
    files.files.set('references.bib', '@misc{onlybib, title={X}}\n@article{shor1995scheme, title={Scheme for reducing decoherence in quantum computer memory}}\n');
    refs.link(project, [ids.shor!, ids.steane!]);
    const r = await refs.references(project);
    expect(r.items.map((i) => i.id).sort()).toEqual([ids.shor!, ids.steane!].sort());
    expect(r.bibFiles).toEqual(['references.bib']);
    const byKey = Object.fromEntries(r.citations.map((c) => [c.key, c]));
    expect(byKey.shor1995scheme).toMatchObject({ status: 'library-and-bib', libraryItemId: ids.shor, definedIn: ['references.bib'] });
    expect(byKey.shor1995scheme!.occurrences).toEqual([
      { file: 'main.tex', line: 3 },
      { file: 'chapters/two.tex', line: 1 },
    ]);
    expect(byKey.missing2020).toMatchObject({ status: 'unresolved', libraryItemId: null });
    expect(byKey.onlybib).toMatchObject({ status: 'bib-only' });
    expect(byKey.steane1996error).toMatchObject({ status: 'library-only', occurrences: [] });
    expect(byKey.commented).toBeUndefined();
  });

  it('keeps the cite command per project', async () => {
    expect((await refs.settings(project)).citeCommand).toBe('cite');
    await refs.updateSettings(project, { citeCommand: 'parencite' });
    expect(await refs.settings(project)).toEqual({ bibFile: 'references.bib', citeCommand: 'parencite' });
  });
});
