/**
 * External file changes: edits made outside Research Studio are reported as
 * `files.changed` events with `source: "external"` and per-file details; the
 * runtime's own writes and ignored folders are not reported again.
 */
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@research-studio/api-contracts';
import type { Project } from '@research-studio/shared-types';
import { createTestRuntime, ORIGIN, type TestRuntime } from './helpers';

let rt: TestRuntime;
let project: Project;
let events: Extract<ServerEvent, { type: 'files.changed' }>[] = [];
const api = (p: string) => `/api/v1${p}`;
const disk = (rel: string) => path.join(project.rootPath, ...rel.split('/'));

beforeAll(async () => {
  rt = await createTestRuntime();
  rt.events.subscribe((e) => {
    if (e.type === 'files.changed') events.push(e);
  });
  project = (await rt.request('POST', api('/projects'), { body: { name: 'Watched', template: 'empty' } })).json<{ project: Project }>().project;
  await rt.request('PUT', api(`/projects/${project.id}/files/content`), { body: { path: 'main.tex', content: 'Hello.\n' } });
  await rt.watcher.watch(project.id, 'test');
});
afterAll(() => rt.dispose());
beforeEach(async () => {
  await rt.watcher.flush(project.id);
  events = [];
});

/** Changes reported for external edits once the watcher has caught up. */
async function external() {
  await new Promise((r) => setTimeout(r, 250));
  await rt.watcher.flush(project.id);
  return events.filter((e) => e.source === 'external').flatMap((e) => e.changes ?? []);
}

describe('external file changes', () => {
  it('reports added, changed and deleted files', async () => {
    await writeFile(disk('added.tex'), 'new file');
    expect(await external()).toEqual([{ path: 'added.tex', change: 'added' }]);
    events = [];
    await writeFile(disk('added.tex'), 'edited elsewhere');
    expect(await external()).toEqual([{ path: 'added.tex', change: 'changed' }]);
    events = [];
    await rm(disk('added.tex'));
    expect(await external()).toEqual([{ path: 'added.tex', change: 'deleted' }]);
    const event = events.find((e) => e.source === 'external')!;
    expect(event).toMatchObject({ projectId: project.id, originSessionId: null, paths: ['added.tex'] });
  });

  it('reports a rename (also into a new folder) as one change', async () => {
    await writeFile(disk('draft.tex'), 'Draft text.\n');
    await external();
    events = [];
    await rename(disk('draft.tex'), disk('final.tex'));
    expect(await external()).toEqual([{ path: 'final.tex', change: 'renamed', from: 'draft.tex' }]);
    events = [];
    await mkdir(disk('chapters'));
    await rename(disk('final.tex'), disk('chapters/one.tex'));
    expect(await external()).toEqual([{ path: 'chapters/one.tex', change: 'renamed', from: 'final.tex' }]);
    expect(events.find((e) => e.source === 'external')!.paths.sort()).toEqual(['chapters/one.tex', 'final.tex']);
  });

  it('ignores a touch that does not change the content', async () => {
    const later = new Date(Date.now() + 60_000);
    await utimes(disk('main.tex'), later, later);
    expect(await external()).toEqual([]);
  });

  it('does not report the runtime’s own writes again', async () => {
    const res = await rt.request('PUT', api(`/projects/${project.id}/files/content`), { body: { path: 'main.tex', content: 'Saved in the editor.\n' } });
    expect(res.statusCode).toBe(200);
    expect(await external()).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ source: 'runtime', paths: ['main.tex'] })]);
  });

  it('ignores the build folder, temporary files and node_modules', async () => {
    await mkdir(disk('.rs-build'), { recursive: true });
    await writeFile(disk('.rs-build/main.aux'), 'aux');
    await writeFile(disk('main.tex.rs-tmp-abc123'), 'partial');
    await mkdir(disk('node_modules/x'), { recursive: true });
    await writeFile(disk('node_modules/x/index.js'), '');
    expect(await external()).toEqual([]);
    await rm(disk('main.tex.rs-tmp-abc123'));
  });

  it('stops reporting once nobody watches the project', async () => {
    rt.watcher.unwatch(project.id, 'test');
    expect(rt.watcher.isWatching(project.id)).toBe(false);
    await writeFile(disk('unwatched.tex'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
    await rt.watcher.watch(project.id, 'test');
  });
});

describe('watching over the WebSocket', () => {
  it('watches while the socket asks for it and stops when it closes', async () => {
    rt.watcher.unwatch(project.id, 'test');
    await rt.app.listen({ host: '127.0.0.1', port: 0 });
    const address = rt.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const { ticket } = (await rt.request('POST', api('/auth/ws-ticket'))).json<{ ticket: string }>();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?ticket=${ticket}`, { headers: { origin: ORIGIN } });
    const received: ServerEvent[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as ServerEvent));
    await new Promise((r) => ws.once('open', r));

    ws.send(JSON.stringify({ type: 'project.watch', projectId: project.id }));
    const deadline = Date.now() + 5_000;
    while (!rt.watcher.isWatching(project.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(rt.watcher.isWatching(project.id)).toBe(true);
    await rt.watcher.flush(project.id);

    await writeFile(disk('from-git.tex'), 'checked out');
    await external();
    expect(received).toContainEqual(expect.objectContaining({ type: 'files.changed', source: 'external', changes: [{ path: 'from-git.tex', change: 'added' }] }));

    // An invalid project id closes nothing and watches nothing.
    ws.send(JSON.stringify({ type: 'project.watch', projectId: 'no-such-project' }));
    ws.close();
    await new Promise((r) => ws.once('close', r));
    const until = Date.now() + 5_000;
    while (rt.watcher.isWatching(project.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(rt.watcher.isWatching(project.id)).toBe(false);
  });
});
