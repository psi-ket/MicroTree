import { useEffect, useMemo } from 'react';
import type { FileTreeNode } from '@research-studio/shared-types';
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
  Spinner,
  useDefaultLayout,
} from '@research-studio/ui';
import { errorMessage, useJobs, useProject, useSymbols, useTree } from '../../lib/queries';
import { openLibrary } from '../../lib/routes';
import { useCompile } from '../../stores/compile';
import { isDirty, useEditor } from '../../stores/editor';
import { useLayout } from '../../stores/layout';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import { EditorPane } from '../editor/EditorPane';
import { completionSources } from '../editor/monaco-setup';
import { Explorer } from '../explorer/Explorer';
import { CommandPalette, type PaletteCommand } from '../palette/CommandPalette';
import { PdfPane } from '../pdf/PdfPane';
import { ReferencesPanel } from '../references/ReferencesPanel';
import { SettingsDialog } from '../settings/SettingsDialog';
import { compileProject, forwardSearch, openFile, saveAll } from './actions';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';

function allFiles(node: FileTreeNode | undefined): string[] {
  if (!node) return [];
  return (node.children ?? []).flatMap((c) => (c.type === 'directory' ? allFiles(c) : [c.path]));
}

/** App-wide shortcuts. Monaco handles the same chords itself while it has focus. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.target instanceof Element && e.target.closest('.monaco-editor')) return;
      const layout = useLayout.getState();
      const key = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (key === 'enter') run(() => void compileProject());
      else if (key === 's') run(() => void saveAll());
      else if (key === 'p' && e.shiftKey) run(() => layout.openPalette('commands'));
      else if (key === 'p') run(() => layout.openPalette('files'));
      else if (key === 'b') run(() => layout.toggle('explorer'));
      else if (key === 'j' && !e.altKey) run(() => layout.toggle('diagnostics'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useUnsavedWarning() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.values(useEditor.getState().buffers).some(isDirty)) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

export function Workspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const { data: project, error } = useProject(projectId);
  const { data: tree } = useTree(projectId);
  const { data: symbols } = useSymbols(projectId);
  const { data: jobs } = useJobs(projectId);
  const layout = useLayout();
  useShortcuts();
  useUnsavedWarning();

  // Reset the editor when switching projects, then open the main file.
  const mainFile = project?.mainFile;
  useEffect(() => {
    if (useEditor.getState().projectId !== projectId) useEditor.getState().reset(projectId);
  }, [projectId]);
  useEffect(() => {
    if (mainFile && useEditor.getState().tabs.length === 0) void openFile(mainFile);
  }, [mainFile]);

  // Seed the compile store with the latest stored job (survives runtime restarts).
  const latest = jobs?.[0];
  useEffect(() => {
    if (latest) useCompile.getState().upsert(latest);
  }, [latest]);

  const files = useMemo(() => allFiles(tree), [tree]);
  useEffect(() => {
    completionSources.files = files;
    completionSources.labels = symbols?.labels ?? [];
    completionSources.citations = symbols?.citations ?? [];
  }, [files, symbols]);

  const horizontalIds = ['explorer', 'editor', 'pdf', 'references', 'assistant'].filter(
    (id) => (id !== 'explorer' || layout.explorer) && (id !== 'assistant' || layout.assistant) && (id !== 'references' || layout.references),
  );
  const horizontal = useDefaultLayout({ id: 'rs.workspace.h', panelIds: horizontalIds });
  const verticalIds = layout.diagnostics ? ['main', 'diagnostics'] : ['main'];
  const vertical = useDefaultLayout({ id: 'rs.workspace.v', panelIds: verticalIds });

  const commands: PaletteCommand[] = [
    { id: 'compile', label: 'Compile project', shortcut: 'Ctrl Enter', run: () => void compileProject() },
    { id: 'save', label: 'Save all files', shortcut: 'Ctrl S', run: () => void saveAll() },
    { id: 'files', label: 'Go to file', shortcut: 'Ctrl P', run: () => layout.openPalette('files') },
    { id: 'forward', label: 'Show cursor position in PDF', shortcut: 'Ctrl Alt J', run: () => void forwardSearch() },
    { id: 'explorer', label: 'Toggle explorer', shortcut: 'Ctrl B', run: () => layout.toggle('explorer') },
    { id: 'problems', label: 'Toggle problems panel', shortcut: 'Ctrl J', run: () => layout.toggle('diagnostics') },
    { id: 'log', label: 'Show raw compile log', run: () => { layout.toggle('diagnostics', true); layout.setBottomTab('log'); } },
    { id: 'assistant', label: 'Toggle assistant', run: () => layout.toggle('assistant') },
    { id: 'references', label: 'Toggle references', run: () => layout.toggle('references') },
    { id: 'library', label: 'Open your library', run: () => void saveAll().finally(() => openLibrary(projectId)) },
    { id: 'settings', label: 'Open settings', run: () => layout.setSettingsOpen(true) },
    { id: 'projects', label: 'Back to all projects', run: onBack },
  ];

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper p-6 text-center">
        <div>
          <p className="font-display text-[22px] italic text-ink">This project could not be opened</p>
          <p className="mt-2 text-ui text-ink-muted">{errorMessage(error)}</p>
          <button type="button" className="mt-4 text-ui text-accent underline" onClick={onBack}>
            Back to all projects
          </button>
        </div>
      </main>
    );
  }
  if (!project) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper">
        <Spinner className="text-ink-faint" />
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <TopBar project={project} onBack={onBack} />
      <div className="min-h-0 flex-1">
        <ResizableGroup
          orientation="vertical"
          id="rs.workspace.v"
          defaultLayout={vertical.defaultLayout}
          onLayoutChanged={vertical.onLayoutChanged}
        >
          <ResizablePanel id="main" minSize="30">
            <ResizableGroup
              orientation="horizontal"
              id="rs.workspace.h"
              defaultLayout={horizontal.defaultLayout}
              onLayoutChanged={horizontal.onLayoutChanged}
            >
              {layout.explorer ? (
                <>
                  <ResizablePanel id="explorer" defaultSize={240} minSize={170} maxSize="40">
                    <Explorer project={project} />
                  </ResizablePanel>
                  <ResizableHandle />
                </>
              ) : null}
              <ResizablePanel id="editor" minSize={280}>
                <EditorPane projectId={projectId} />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="pdf" minSize={240}>
                <PdfPane projectId={projectId} />
              </ResizablePanel>
              {layout.references ? (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="references" defaultSize={300} minSize={240} maxSize="40">
                    <ReferencesPanel projectId={projectId} />
                  </ResizablePanel>
                </>
              ) : null}
              {layout.assistant ? (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="assistant" defaultSize={300} minSize={240} maxSize="40">
                    <AssistantPanel projectId={projectId} />
                  </ResizablePanel>
                </>
              ) : null}
            </ResizableGroup>
          </ResizablePanel>
          {layout.diagnostics ? (
            <>
              <ResizableHandle orientation="horizontal" />
              <ResizablePanel id="diagnostics" defaultSize={190} minSize={90} maxSize="60">
                <DiagnosticsPanel projectId={projectId} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizableGroup>
      </div>
      <StatusBar projectId={projectId} />
      <CommandPalette projectId={projectId} commands={commands} />
      <SettingsDialog />
    </div>
  );
}
