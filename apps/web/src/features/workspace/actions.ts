import { toast } from 'sonner';
import { RuntimeApiError } from '@research-studio/api-contracts';
import { isTextKind, classifyFile } from '@research-studio/document-engine';
import type { PdfRect } from '@research-studio/shared-types';
import { runtime } from '../../lib/connection';
import { errorMessage, keys, queryClient } from '../../lib/queries';
import { useCompile } from '../../stores/compile';
import { isDirty, useEditor } from '../../stores/editor';

function projectId(): string {
  const id = useEditor.getState().projectId;
  if (!id) throw new Error('No project is open');
  return id;
}

/** Open (or focus) a file in the editor. Non-text files are not opened as buffers. */
export async function openFile(path: string, reveal?: { line: number; column?: number }): Promise<boolean> {
  const editor = useEditor.getState();
  if (!isTextKind(classifyFile(path))) return false;
  if (!editor.buffers[path]) {
    try {
      const file = await runtime().readFile(projectId(), path);
      useEditor.getState().openBuffer({ path: file.path, kind: file.kind, content: file.content, hash: file.hash });
    } catch (err) {
      toast.error(`Could not open ${path}`, { description: errorMessage(err) });
      return false;
    }
  } else {
    editor.activate(path);
  }
  if (reveal) useEditor.getState().revealAt(path, reveal.line, reveal.column);
  return true;
}

const inFlight = new Map<string, Promise<boolean>>();

/** Save one buffer. Concurrent calls for the same path are serialised. */
export async function saveFile(path: string): Promise<boolean> {
  const previous = inFlight.get(path);
  if (previous) await previous.catch(() => undefined);
  const run = (async () => {
    const buffer = useEditor.getState().buffers[path];
    if (!buffer || !isDirty(buffer) || buffer.conflict) return !buffer?.conflict;
    const content = buffer.content;
    useEditor.getState().markSaving(path, true);
    try {
      const { file } = await runtime().writeFile(projectId(), { path, content, baseHash: buffer.baseHash });
      useEditor.getState().markSaved(path, content, file.hash);
      return true;
    } catch (err) {
      const conflict = err instanceof RuntimeApiError && err.code === 'CONFLICT';
      useEditor.getState().markError(path, errorMessage(err), conflict);
      if (conflict) {
        toast.warning(`${path} changed on disk`, {
          description: 'Your edits were not saved. Choose to keep your version or reload the file.',
        });
      } else {
        toast.error(`Could not save ${path}`, { description: errorMessage(err) });
      }
      return false;
    }
  })();
  inFlight.set(path, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(path) === run) inFlight.delete(path);
  }
}

export async function saveAll(): Promise<boolean> {
  const paths = Object.values(useEditor.getState().buffers).filter(isDirty).map((b) => b.path);
  const results = await Promise.all(paths.map(saveFile));
  return results.every(Boolean);
}

/** Resolve a save conflict by overwriting the disk version with the editor content. */
export async function overwriteOnDisk(path: string): Promise<void> {
  const buffer = useEditor.getState().buffers[path];
  if (!buffer) return;
  try {
    const { file } = await runtime().writeFile(projectId(), { path, content: buffer.content });
    useEditor.getState().markSaved(path, buffer.content, file.hash);
    toast.success(`Saved your version of ${path}`);
  } catch (err) {
    toast.error(`Could not save ${path}`, { description: errorMessage(err) });
  }
}

export async function reloadFromDisk(path: string): Promise<void> {
  try {
    const file = await runtime().readFile(projectId(), path);
    useEditor.getState().replaceFromDisk({ path, content: file.content, hash: file.hash });
  } catch (err) {
    toast.error(`Could not reload ${path}`, { description: errorMessage(err) });
  }
}

export async function compileProject(): Promise<void> {
  const id = projectId();
  const saved = await saveAll();
  if (!saved) {
    toast.error('Compilation skipped', { description: 'Some files could not be saved.' });
    return;
  }
  try {
    const { job } = await runtime().compile(id);
    useCompile.getState().upsert(job);
  } catch (err) {
    toast.error('Could not start compilation', { description: errorMessage(err) });
  }
}

export async function cancelCompile(): Promise<void> {
  try {
    const { job } = await runtime().cancelCompile(projectId());
    if (job) useCompile.getState().upsert(job);
  } catch (err) {
    toast.error('Could not cancel', { description: errorMessage(err) });
  }
}

type ForwardListener = (rects: PdfRect[]) => void;
const forwardListeners = new Set<ForwardListener>();
export function onForwardSearch(listener: ForwardListener): () => void {
  forwardListeners.add(listener);
  return () => forwardListeners.delete(listener);
}

/** SyncTeX: show the cursor position of the active file in the PDF. */
export async function forwardSearch(): Promise<void> {
  const { active, cursor } = useEditor.getState();
  if (!active || !cursor) return;
  if (classifyFile(active) !== 'tex') {
    toast.info('SyncTeX works from .tex files');
    return;
  }
  try {
    const { rects } = await runtime().synctexForward(projectId(), { file: active, line: cursor.line, column: cursor.column });
    if (rects.length === 0) {
      toast.info('This line is not in the PDF yet', { description: 'Compile the project, then try again.' });
      return;
    }
    forwardListeners.forEach((l) => l(rects));
  } catch (err) {
    toast.error('SyncTeX failed', { description: errorMessage(err) });
  }
}

/** SyncTeX: jump from a PDF position to the source. */
export async function inverseSearch(page: number, x: number, y: number): Promise<void> {
  try {
    const { location } = await runtime().synctexInverse(projectId(), { page, x, y });
    if (!location) {
      toast.info('No source position found here');
      return;
    }
    await openFile(location.file, { line: location.line, column: location.column });
  } catch (err) {
    toast.error('SyncTeX failed', { description: errorMessage(err) });
  }
}

function refreshFiles(id: string) {
  void queryClient.invalidateQueries({ queryKey: keys.tree(id) });
  void queryClient.invalidateQueries({ queryKey: keys.symbols(id) });
}

export async function createEntry(path: string, type: 'file' | 'directory'): Promise<boolean> {
  const id = projectId();
  try {
    const { entry } = await runtime().createEntry(id, { path, type, content: '' });
    refreshFiles(id);
    if (type === 'file') await openFile(entry.path);
    return true;
  } catch (err) {
    toast.error(type === 'file' ? 'Could not create the file' : 'Could not create the folder', {
      description: errorMessage(err),
    });
    return false;
  }
}

export async function renameEntry(from: string, to: string): Promise<boolean> {
  const id = projectId();
  const affected = Object.values(useEditor.getState().buffers).filter(
    (b) => (b.path === from || b.path.startsWith(`${from}/`)) && isDirty(b),
  );
  for (const b of affected) await saveFile(b.path);
  try {
    const { entry } = await runtime().renameEntry(id, from, to);
    useEditor.getState().renamePath(from, entry.path);
    refreshFiles(id);
    void queryClient.invalidateQueries({ queryKey: keys.project(id) });
    return true;
  } catch (err) {
    toast.error('Could not rename', { description: errorMessage(err) });
    return false;
  }
}

export async function deleteEntry(path: string): Promise<void> {
  const id = projectId();
  try {
    await runtime().deleteEntry(id, path);
    useEditor.getState().removePath(path);
    refreshFiles(id);
    toast.success(`Deleted ${path}`);
  } catch (err) {
    toast.error('Could not delete', { description: errorMessage(err) });
  }
}

export async function uploadFiles(files: File[], directory: string): Promise<void> {
  const id = projectId();
  for (const file of files) {
    try {
      const { file: uploaded } = await runtime().upload(id, file, file.name, directory);
      toast.success(`Uploaded ${uploaded.path}`, {
        description: `Insert with \\includegraphics{${uploaded.path}}`,
      });
    } catch (err) {
      toast.error(`Could not upload ${file.name}`, { description: errorMessage(err) });
    }
  }
  refreshFiles(id);
}
