import { create } from 'zustand';
import type { FileKind } from '@research-studio/shared-types';

export interface Buffer {
  path: string;
  kind: FileKind;
  content: string;
  /** Content as last saved to (or loaded from) disk. */
  savedContent: string;
  /** sha256 of the on-disk version this buffer is based on. */
  baseHash: string;
  saving: boolean;
  /**
   * The file changed on disk while this buffer had unsaved edits (noticed by
   * the watcher, or by the runtime refusing a save). Saving is paused until
   * the user decides; the buffer is never replaced automatically.
   */
  conflict: boolean;
  /** What happened on disk, when `conflict` is set. */
  diskState: 'changed' | 'deleted' | null;
  error: string | null;
  /** Bumped whenever content is replaced from outside the editor (reload). */
  externalVersion: number;
}

export interface Reveal {
  path: string;
  line: number;
  column?: number;
  nonce: number;
}

interface EditorState {
  projectId: string | null;
  tabs: string[];
  active: string | null;
  buffers: Record<string, Buffer>;
  reveal: Reveal | null;
  /** Text to type at the cursor of the active file (e.g. a `\cite{…}` from the References panel). */
  insertion: { path: string; text: string; nonce: number } | null;
  cursor: { line: number; column: number } | null;
  selection: EditorSelection | null;

  reset(projectId: string | null): void;
  openBuffer(file: { path: string; kind: FileKind; content: string; hash: string }): void;
  activate(path: string): void;
  closeTab(path: string): void;
  setContent(path: string, content: string): void;
  markSaving(path: string, saving: boolean): void;
  markSaved(path: string, content: string, hash: string): void;
  markError(path: string, error: string | null, conflict?: boolean): void;
  /** The file changed or was deleted on disk while the buffer has unsaved edits. */
  markDiskConflict(path: string, state: 'changed' | 'deleted'): void;
  replaceFromDisk(file: { path: string; content: string; hash: string }): void;
  renamePath(from: string, to: string): void;
  removePath(path: string): void;
  revealAt(path: string, line: number, column?: number): void;
  insertAtCursor(text: string): boolean;
  setCursor(cursor: EditorState['cursor']): void;
  setSelection(selection: EditorState['selection']): void;
}

/** The editor's selection: 1-based Monaco positions (end column is exclusive). */
export interface EditorSelection {
  file: string;
  fromLine: number;
  toLine: number;
  startColumn: number;
  endColumn: number;
  text: string;
}

export const isDirty = (b: Buffer | undefined) => !!b && b.content !== b.savedContent;

const remap = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;

export const useEditor = create<EditorState>((set) => ({
  projectId: null,
  tabs: [],
  active: null,
  buffers: {},
  reveal: null,
  insertion: null,
  cursor: null,
  selection: null,

  reset: (projectId) => set({ projectId, tabs: [], active: null, buffers: {}, reveal: null, insertion: null, cursor: null, selection: null }),

  openBuffer: (file) =>
    set((s) => {
      const existing = s.buffers[file.path];
      const buffers = existing
        ? s.buffers
        : {
            ...s.buffers,
            [file.path]: {
              path: file.path,
              kind: file.kind,
              content: file.content,
              savedContent: file.content,
              baseHash: file.hash,
              saving: false,
              conflict: false,
              diskState: null,
              error: null,
              externalVersion: 0,
            },
          };
      const tabs = s.tabs.includes(file.path) ? s.tabs : [...s.tabs, file.path];
      return { buffers, tabs, active: file.path };
    }),

  activate: (path) => set({ active: path }),

  closeTab: (path) =>
    set((s) => {
      const index = s.tabs.indexOf(path);
      const tabs = s.tabs.filter((t) => t !== path);
      const { [path]: _closed, ...buffers } = s.buffers;
      const active = s.active === path ? (tabs[Math.max(0, index - 1)] ?? null) : s.active;
      return { tabs, buffers, active };
    }),

  setContent: (path, content) =>
    set((s) => {
      const b = s.buffers[path];
      if (!b || b.content === content) return s;
      return { buffers: { ...s.buffers, [path]: { ...b, content, error: null } } };
    }),

  markSaving: (path, saving) =>
    set((s) => {
      const b = s.buffers[path];
      return b ? { buffers: { ...s.buffers, [path]: { ...b, saving } } } : s;
    }),

  markSaved: (path, content, hash) =>
    set((s) => {
      const b = s.buffers[path];
      if (!b) return s;
      return {
        buffers: { ...s.buffers, [path]: { ...b, savedContent: content, baseHash: hash, saving: false, conflict: false, diskState: null, error: null } },
      };
    }),

  markError: (path, error, conflict = false) =>
    set((s) => {
      const b = s.buffers[path];
      return b ? { buffers: { ...s.buffers, [path]: { ...b, saving: false, error, conflict, diskState: conflict ? 'changed' : b.diskState } } } : s;
    }),

  markDiskConflict: (path, diskState) =>
    set((s) => {
      const b = s.buffers[path];
      return b ? { buffers: { ...s.buffers, [path]: { ...b, conflict: true, diskState, error: null } } } : s;
    }),

  replaceFromDisk: (file) =>
    set((s) => {
      const b = s.buffers[file.path];
      if (!b) return s;
      return {
        buffers: {
          ...s.buffers,
          [file.path]: {
            ...b,
            content: file.content,
            savedContent: file.content,
            baseHash: file.hash,
            conflict: false,
            diskState: null,
            error: null,
            externalVersion: b.externalVersion + 1,
          },
        },
      };
    }),

  renamePath: (from, to) =>
    set((s) => {
      const buffers: Record<string, Buffer> = {};
      for (const [path, b] of Object.entries(s.buffers)) {
        const next = remap(path, from, to);
        buffers[next ?? path] = next ? { ...b, path: next } : b;
      }
      const tabs = s.tabs.map((t) => remap(t, from, to) ?? t);
      const active = s.active ? (remap(s.active, from, to) ?? s.active) : null;
      return { buffers, tabs, active };
    }),

  removePath: (path) =>
    set((s) => {
      const gone = (p: string) => p === path || p.startsWith(`${path}/`);
      const tabs = s.tabs.filter((t) => !gone(t));
      const buffers = Object.fromEntries(Object.entries(s.buffers).filter(([p]) => !gone(p)));
      const active = s.active && gone(s.active) ? (tabs[tabs.length - 1] ?? null) : s.active;
      return { tabs, buffers, active };
    }),

  revealAt: (path, line, column) => set({ reveal: { path, line, ...(column ? { column } : {}), nonce: Date.now() } }),
  /** False when no file is open to type into. */
  insertAtCursor: (text) => {
    const { active } = useEditor.getState();
    if (!active) return false;
    set({ insertion: { path: active, text, nonce: Date.now() } });
    return true;
  },
  setCursor: (cursor) => set({ cursor }),
  setSelection: (selection) => set({ selection }),
}));
