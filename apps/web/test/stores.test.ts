import { beforeEach, describe, expect, it } from 'vitest';
import type { CompileJob } from '@research-studio/shared-types';
import { isActive, useCompile } from '../src/stores/compile';
import { isDirty, useEditor } from '../src/stores/editor';

function job(patch: Partial<CompileJob> = {}): CompileJob {
  return {
    id: 'job-1',
    projectId: 'p1',
    status: 'queued',
    engine: 'pdflatex',
    mainFile: 'main.tex',
    createdAt: '2026-11-02T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    pdfAvailable: false,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    statusMessage: null,
    ...patch,
  };
}

describe('compile store', () => {
  beforeEach(() => useCompile.setState({ jobs: {}, output: {}, pdfJob: {} }));

  it('does not regress a job when a late queued response arrives after compile.started', () => {
    const { upsert } = useCompile.getState();
    upsert(job({ status: 'running' }));
    upsert(job({ status: 'queued' }));
    expect(useCompile.getState().jobs.p1?.status).toBe('running');
    expect(isActive(useCompile.getState().jobs.p1)).toBe(true);
  });

  it('ignores updates for older jobs and tracks the latest PDF', () => {
    const { upsert } = useCompile.getState();
    upsert(job({ id: 'job-2', createdAt: '2026-11-02T10:05:00.000Z', status: 'succeeded', pdfAvailable: true }));
    upsert(job({ id: 'job-1', status: 'failed' }));
    expect(useCompile.getState().jobs.p1?.id).toBe('job-2');
    expect(useCompile.getState().pdfJob.p1).toBe('job-2');
  });

  it('resets live output when a new job starts and drops output from other jobs', () => {
    const { upsert, append } = useCompile.getState();
    useCompile.getState().setOutput('p1', 'old output');
    upsert(job({ status: 'running' }));
    expect(useCompile.getState().output.p1).toBe('');
    append('p1', 'job-1', 'Latexmk: ');
    append('p1', 'other-job', 'ignored');
    append('p1', 'job-1', 'done');
    expect(useCompile.getState().output.p1).toBe('Latexmk: done');
  });
});

describe('editor store', () => {
  beforeEach(() => useEditor.getState().reset('p1'));

  const open = (path: string, content = 'x') =>
    useEditor.getState().openBuffer({ path, kind: 'tex', content, hash: `h-${path}` });

  it('tracks dirty state against the saved content', () => {
    open('main.tex', 'a');
    useEditor.getState().setContent('main.tex', 'ab');
    expect(isDirty(useEditor.getState().buffers['main.tex'])).toBe(true);
    useEditor.getState().markSaved('main.tex', 'ab', 'h2');
    const b = useEditor.getState().buffers['main.tex'];
    expect(isDirty(b)).toBe(false);
    expect(b?.baseHash).toBe('h2');
  });

  it('keeps content and flags a conflict on a rejected save', () => {
    open('main.tex', 'a');
    useEditor.getState().setContent('main.tex', 'mine');
    useEditor.getState().markError('main.tex', 'changed on disk', true);
    const b = useEditor.getState().buffers['main.tex'];
    expect(b?.conflict).toBe(true);
    expect(b?.content).toBe('mine');
  });

  it('remaps tabs and buffers when a folder is renamed', () => {
    open('chapters/one.tex');
    open('chapters/two.tex');
    open('chapters-extra/three.tex');
    useEditor.getState().renamePath('chapters', 'parts');
    const s = useEditor.getState();
    expect(s.tabs).toEqual(['parts/one.tex', 'parts/two.tex', 'chapters-extra/three.tex']);
    expect(s.active).toBe('chapters-extra/three.tex');
    expect(s.buffers['parts/one.tex']?.path).toBe('parts/one.tex');
  });

  it('closes tabs for deleted folders and picks a new active tab', () => {
    open('main.tex');
    open('chapters/one.tex');
    useEditor.getState().removePath('chapters');
    const s = useEditor.getState();
    expect(s.tabs).toEqual(['main.tex']);
    expect(s.active).toBe('main.tex');
    expect(s.buffers['chapters/one.tex']).toBeUndefined();
  });

  it('bumps the external version when reloading from disk', () => {
    open('main.tex', 'a');
    useEditor.getState().replaceFromDisk({ path: 'main.tex', content: 'from disk', hash: 'h9' });
    const b = useEditor.getState().buffers['main.tex'];
    expect(b?.externalVersion).toBe(1);
    expect(b?.content).toBe('from disk');
    expect(isDirty(b)).toBe(false);
  });

  it('flags a disk change or deletion without touching unsaved edits, until the user decides', () => {
    open('main.tex', 'a');
    useEditor.getState().setContent('main.tex', 'mine');
    useEditor.getState().markDiskConflict('main.tex', 'deleted');
    let b = useEditor.getState().buffers['main.tex'];
    expect(b).toMatchObject({ conflict: true, diskState: 'deleted', content: 'mine', savedContent: 'a' });
    useEditor.getState().markDiskConflict('main.tex', 'changed');
    expect(useEditor.getState().buffers['main.tex']?.diskState).toBe('changed');
    // Keeping mine (a successful save) clears it.
    useEditor.getState().markSaved('main.tex', 'mine', 'h3');
    b = useEditor.getState().buffers['main.tex'];
    expect(b).toMatchObject({ conflict: false, diskState: null });
    // So does reloading.
    useEditor.getState().markDiskConflict('main.tex', 'changed');
    useEditor.getState().replaceFromDisk({ path: 'main.tex', content: 'theirs', hash: 'h4' });
    expect(useEditor.getState().buffers['main.tex']).toMatchObject({ conflict: false, diskState: null, content: 'theirs' });
  });
});
