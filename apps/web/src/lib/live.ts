import { useEffect } from 'react';
import { toast } from 'sonner';
import { RuntimeApiError, type ServerEvent } from '@research-studio/api-contracts';
import type { FileChange } from '@research-studio/shared-types';
import { upsertMessage, upsertProposal } from '../features/assistant/actions';
import { useAssistant } from '../features/assistant/state';
import { saveAll } from '../features/workspace/actions';
import { useCompile } from '../stores/compile';
import { isDirty, useEditor } from '../stores/editor';
import { dropSession, onUnauthorized, reconnectWithRememberedToken, runtime, useConnection } from './connection';
import { upsertLibraryJob } from '../features/library/jobs';
import { invalidateDocuments, invalidateLibrary, keys, queryClient } from './queries';
import { RuntimeSocket } from './socket';

let recovering: Promise<void> | null = null;

/**
 * The session was rejected (expired, revoked, or the runtime restarted).
 * Re-pair in place with a remembered token so open work stays on screen;
 * otherwise return to the connect screen.
 */
export function recoverSession(): Promise<void> {
  recovering ??= (async () => {
    if (await reconnectWithRememberedToken(true)) {
      void queryClient.invalidateQueries();
      // Retry saves that failed while the session was gone.
      if (useEditor.getState().projectId) void saveAll();
      return;
    }
    dropSession('Your session ended (the runtime may have restarted). Pair again to continue.');
  })().finally(() => {
    recovering = null;
  });
  return recovering;
}

/**
 * Bring open buffers up to date with files changed by someone else (another
 * client, or a program outside Research Studio). A buffer without unsaved
 * edits follows the disk; one with unsaved edits is never replaced: it is
 * flagged as a conflict and the user decides (compare, reload or keep).
 */
export async function syncChangedFiles(projectId: string, paths: string[], changes: FileChange[] = []) {
  if (useEditor.getState().projectId !== projectId) return;
  // A renamed file keeps its buffer (and any unsaved edits) under the new name.
  for (const change of changes) {
    if (change.change !== 'renamed' || !change.from || !useEditor.getState().buffers[change.from]) continue;
    useEditor.getState().renamePath(change.from, change.path);
    toast.info(`${change.from} was renamed to ${change.path} outside Research Studio`);
  }
  const renamedFrom = new Set(changes.flatMap((c) => (c.change === 'renamed' && c.from ? [c.from] : [])));
  for (const path of paths) {
    if (renamedFrom.has(path)) continue;
    const buffer = useEditor.getState().buffers[path];
    if (!buffer) continue;
    const dirty = isDirty(buffer);
    try {
      const file = await runtime().readFile(projectId, path);
      if (file.hash === buffer.baseHash) continue;
      if (dirty) useEditor.getState().markDiskConflict(path, 'changed');
      else useEditor.getState().replaceFromDisk(file);
    } catch (err) {
      if (!(err instanceof RuntimeApiError && err.status === 404)) continue;
      if (dirty) {
        useEditor.getState().markDiskConflict(path, 'deleted');
      } else {
        useEditor.getState().removePath(path);
        toast.info(`${path} was deleted outside Research Studio`);
      }
    }
  }
}

function handle(event: ServerEvent) {
  switch (event.type) {
    case 'compile.queued':
    case 'compile.started':
      useCompile.getState().upsert(event.job);
      break;
    case 'compile.finished':
      useCompile.getState().upsert(event.job);
      void queryClient.invalidateQueries({ queryKey: keys.jobs(event.job.projectId) });
      break;
    case 'compile.output':
      useCompile.getState().append(event.projectId, event.jobId, event.chunk);
      break;
    case 'files.changed': {
      void queryClient.invalidateQueries({ queryKey: keys.tree(event.projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.symbols(event.projectId) });
      const own = event.originSessionId !== null && event.originSessionId === useConnection.getState().sessionId;
      if (!own) void syncChangedFiles(event.projectId, event.paths, event.changes);
      break;
    }
    case 'project.updated':
      queryClient.setQueryData(keys.project(event.project.id), event.project);
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      break;
    case 'project.deleted':
      queryClient.removeQueries({ queryKey: keys.project(event.projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      break;
    case 'ai.message.delta':
      useAssistant.getState().appendDelta(event.messageId, event.text);
      break;
    case 'ai.message.updated':
      upsertMessage(event.projectId, event.message);
      if (event.message.status !== 'streaming') useAssistant.getState().endStream(event.message.id);
      break;
    case 'ai.proposal.updated':
      upsertProposal(event.proposal);
      break;
    case 'ai.agent.event':
      useAssistant.getState().agentEvent(event.conversationId, event.run, event.activity);
      break;
    case 'library.job':
      upsertLibraryJob(event.job);
      break;
    case 'library.changed':
      invalidateLibrary();
      break;
    case 'documents.job':
      if (['completed', 'partial', 'needs_ocr', 'failed', 'cancelled'].includes(event.job.status)) invalidateDocuments(event.job.attachmentId);
      else queryClient.setQueryData(keys.documents.status(event.job.attachmentId), (old: unknown) => (old && typeof old === 'object' ? { ...old, job: event.job } : old));
      void queryClient.invalidateQueries({ queryKey: keys.documents.jobs });
      void queryClient.invalidateQueries({ queryKey: keys.documents.index });
      break;
    case 'retrieval.changed':
      void queryClient.invalidateQueries({ queryKey: keys.documents.index });
      break;
    case 'hello':
    case 'pong':
    case 'session.expired':
      break;
  }
}

/** Keeps a live WebSocket open while connected and routes runtime events into the stores. */
export function useLiveUpdates(): void {
  const connected = useConnection((s) => s.status === 'connected');
  const epoch = useConnection((s) => s.sessionEpoch);
  useEffect(() => {
    const off = onUnauthorized(() => void recoverSession());
    return off;
  }, []);
  useEffect(() => {
    if (!connected) return;
    const socket = new RuntimeSocket(() => void recoverSession());
    const offEvents = socket.subscribe(handle);
    const offReconnect = socket.onReconnect(() => {
      // Events may have been missed while disconnected.
      void queryClient.invalidateQueries();
      const projectId = useEditor.getState().projectId;
      if (projectId) {
        const paths = Object.keys(useEditor.getState().buffers);
        void syncChangedFiles(projectId, paths);
      }
    });
    // Report external changes for the open project.
    socket.watch(useEditor.getState().projectId);
    const offEditor = useEditor.subscribe((s) => socket.watch(s.projectId));
    // Fallback for changes the watcher cannot see (network drives, a sleeping laptop): re-check open files on focus.
    let lastCheck = 0;
    const recheck = () => {
      const projectId = useEditor.getState().projectId;
      if (document.visibilityState !== 'visible' || !projectId || Date.now() - lastCheck < 2_000) return;
      lastCheck = Date.now();
      void syncChangedFiles(projectId, Object.keys(useEditor.getState().buffers));
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    socket.start();
    return () => {
      offEvents();
      offReconnect();
      offEditor();
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
      socket.stop();
    };
  }, [connected, epoch]);
}
