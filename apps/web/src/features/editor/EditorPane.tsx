import Editor, { type OnMount } from '@monaco-editor/react';
import { AlertTriangle, BookMarked, Bot, FileCode2, FileText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { classifyFile, editorLanguageFor } from '@research-studio/document-engine';
import type { Diagnostic } from '@research-studio/shared-types';
import { Button, cn, Kbd } from '@research-studio/ui';
import { useSettings } from '../../lib/queries';
import { WRITING_ACTIONS } from '@research-studio/ai-core';
import { useResolvedTheme } from '../../lib/theme';
import { ask } from '../assistant/actions';
import { AssistantDock } from '../assistant/AssistantDock';
import { useCompile } from '../../stores/compile';
import { isDirty, useEditor } from '../../stores/editor';
import { useLayout } from '../../stores/layout';
import { compileProject, forwardSearch, overwriteOnDisk, reloadFromDisk, saveFile } from '../workspace/actions';
import { CompareDialog } from './CompareDialog';
import { useEvidenceRequest, useMarkers } from '../evidence-review/state';
import { monaco, setupMonaco } from './monaco-setup';

setupMonaco();

const modelUri = (projectId: string, path: string) => monaco.Uri.parse(`file:///${projectId}/${path}`);

function TabIcon({ path }: { path: string }) {
  const kind = classifyFile(path);
  if (kind === 'bib') return <BookMarked className="size-3.5 text-warning" />;
  if (kind === 'tex') return <FileCode2 className="size-3.5 text-accent" />;
  return <FileText className="size-3.5 text-ink-faint" />;
}

/** The assistant's tab when it is docked as a tab; it closes the assistant, not a file. */
function AssistantTab({ selected }: { selected: boolean }) {
  const { setAssistantFront, toggle } = useLayout();
  return (
    <div
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-testid="tab-assistant"
      onClick={() => setAssistantFront(true)}
      onAuxClick={(e) => e.button === 1 && toggle('assistant', false)}
      onKeyDown={(e) => e.key === 'Enter' && setAssistantFront(true)}
      className={cn(
        'group relative flex shrink-0 cursor-default items-center gap-1.5 border-r border-rule pl-3 pr-1.5 text-ui',
        selected ? 'bg-panel text-ink' : 'text-ink-muted hover:bg-panel/60 hover:text-ink',
      )}
    >
      {selected ? <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" /> : null}
      <Bot className="size-3.5 text-accent" />
      <span>Assistant</span>
      <button
        type="button"
        aria-label="Close assistant"
        onClick={(e) => {
          e.stopPropagation();
          toggle('assistant', false);
        }}
        className="ml-0.5 grid size-5 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Tabs() {
  const { tabs, active, buffers, activate, closeTab } = useEditor();
  const assistantTab = useLayout((s) => s.assistant && s.assistantDock === 'tab');
  const assistantFront = useLayout((s) => s.assistantFront);
  const setAssistantFront = useLayout((s) => s.setAssistantFront);
  const show = (path: string) => {
    activate(path);
    setAssistantFront(false);
  };
  const close = async (path: string) => {
    if (isDirty(buffers[path])) await saveFile(path);
    closeTab(path);
  };
  return (
    <div role="tablist" aria-label="Open files" className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper">
      {tabs.map((path) => {
        const b = buffers[path];
        const name = path.split('/').pop();
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const selected = path === active && !(assistantTab && assistantFront);
        return (
          <div
            key={path}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={path}
            data-testid={`tab-${path}`}
            onClick={() => show(path)}
            onAuxClick={(e) => e.button === 1 && void close(path)}
            onKeyDown={(e) => e.key === 'Enter' && show(path)}
            className={cn(
              'group relative flex min-w-0 max-w-56 cursor-default items-center gap-1.5 border-r border-rule pl-3 pr-1.5 text-ui',
              selected ? 'bg-panel text-ink' : 'text-ink-muted hover:bg-panel/60 hover:text-ink',
            )}
          >
            {selected ? <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" /> : null}
            <TabIcon path={path} />
            <span className="truncate">{name}</span>
            {dir ? <span className="truncate text-2xs text-ink-faint">{dir}</span> : null}
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                void close(path);
              }}
              className="ml-0.5 grid size-5 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink"
            >
              {b && (b.saving || isDirty(b)) ? (
                <span className={cn('size-2 rounded-full', b.conflict ? 'bg-danger' : 'bg-ink-muted', 'group-hover:hidden')} />
              ) : null}
              <X className={cn('size-3.5', b && (b.saving || isDirty(b)) ? 'hidden group-hover:block' : '')} />
            </button>
          </div>
        );
      })}
      {assistantTab ? <AssistantTab selected={assistantFront} /> : null}
    </div>
  );
}

/** Shown while the open file changed (or was deleted) on disk and the editor has unsaved edits. */
function ConflictBar({ projectId, path, deleted }: { projectId: string; path: string; deleted: boolean }) {
  const [comparing, setComparing] = useState(false);
  const closeTab = useEditor((s) => s.closeTab);
  return (
    <div className="flex items-center gap-2 border-b border-rule bg-warning-soft px-3 py-1.5 text-ui text-warning" data-testid="conflict-bar">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="mr-auto">
        <strong className="font-semibold">{path}</strong>{' '}
        {deleted
          ? 'was deleted on disk. Your unsaved edits are still here.'
          : 'changed on disk while you had unsaved edits. Nothing has been overwritten; saving is paused.'}
      </span>
      {deleted ? (
        <Button size="sm" onClick={() => closeTab(path)}>
          Close without saving
        </Button>
      ) : (
        <>
          <Button size="sm" onClick={() => setComparing(true)} data-testid="conflict-compare">
            Compare
          </Button>
          <Button size="sm" onClick={() => void reloadFromDisk(path)}>
            Discard mine and reload
          </Button>
        </>
      )}
      <Button size="sm" variant="primary" onClick={() => void overwriteOnDisk(path)}>
        Keep mine and save
      </Button>
      {comparing ? <CompareDialog projectId={projectId} path={path} open onClose={() => setComparing(false)} /> : null}
    </div>
  );
}

function EmptyEditor() {
  const openPalette = useLayout((s) => s.openPalette);
  return (
    <div className="grid h-full place-items-center bg-panel">
      <div className="max-w-xs text-center">
        <p className="font-display text-[22px] italic leading-7 text-ink-muted">No file open</p>
        <p className="mt-2 text-ui text-ink-faint">
          Pick a file in the explorer, or press <Kbd>Ctrl P</Kbd> to find one by name.
        </p>
        <Button className="mt-4" size="sm" onClick={() => openPalette('files')}>
          Find a file
        </Button>
      </div>
    </div>
  );
}

function toMarker(d: Diagnostic): MonacoEditor.IMarkerData {
  const line = d.line ?? 1;
  return {
    severity:
      d.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : d.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
    message: d.context ? `${d.message}\n${d.context}` : d.message,
    source: d.source,
    startLineNumber: line,
    endLineNumber: line,
    startColumn: 1,
    endColumn: 1000,
  };
}

export function EditorPane({ projectId }: { projectId: string }) {
  const { active, buffers, reveal, setContent, setCursor, setSelection } = useEditor();
  const settings = useSettings();
  const theme = useResolvedTheme();
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const buffer = active ? buffers[active] : undefined;
  // Quiet evidence indicators: a thin mark beside lines whose claims need attention, only while the evidence panel is open.
  const evidenceOpen = useLayout((s) => s.evidence);
  const markers = useMarkers(projectId, evidenceOpen).data;
  const marks = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const [mounted, setMounted] = useState(0);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    marks.current ??= editor.createDecorationsCollection([]);
    const list = evidenceOpen && active ? (markers?.files[active] ?? []) : [];
    const cls = (status: string) =>
      status === 'potentially_contradicted' ? 'rs-ev-mark rs-ev-conflict' : status === 'needs_revalidation' ? 'rs-ev-mark rs-ev-stale' : status === 'supporting_evidence_found' || status === 'user_reviewed' ? 'rs-ev-mark rs-ev-ok' : status === 'not_assessable' ? '' : 'rs-ev-mark rs-ev-open';
    marks.current.set(
      list
        .filter((m) => cls(m.status))
        .map((m) => ({ range: new monaco.Range(m.fromLine, 1, m.toLine, 1), options: { linesDecorationsClassName: cls(m.status), linesDecorationsTooltip: 'Claim: see the evidence panel' } })),
    );
  }, [markers, active, evidenceOpen, mounted]);
  const job = useCompile((s) => s.jobs[projectId]);
  const assistantOpen = useLayout((s) => s.assistant);
  // Room below the last line so it can be scrolled above the docked assistant.
  const codeBottomPadding = useLayout((s) => (!s.assistant || s.assistantDock !== 'overlay' ? 10 : s.assistantOverlayPx + 10));

  // Autosave after a pause in typing.
  const content = buffer?.content;
  useEffect(() => {
    if (!active || !settings.autosave || !buffer || !isDirty(buffer) || buffer.conflict) return;
    const timer = setTimeout(() => {
      void saveFile(active).then((ok) => {
        if (ok && settings.compileOnSave) void compileProject();
      });
    }, settings.autosaveDelayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, content, settings.autosave, settings.autosaveDelayMs, settings.compileOnSave]);

  // Reloads from disk replace the model content while keeping the model (and undo stack).
  const externalVersion = buffer?.externalVersion ?? 0;
  useEffect(() => {
    if (!active || !buffer || externalVersion === 0) return;
    const model = monaco.editor.getModel(modelUri(projectId, active));
    if (model && model.getValue() !== buffer.content) model.setValue(buffer.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalVersion, active, projectId]);

  // Diagnostics → editor markers for every open model of this project.
  const diagnostics = job?.diagnostics;
  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      const prefix = `file:///${projectId}/`;
      const uri = model.uri.toString(true);
      if (!uri.startsWith(prefix)) continue;
      const path = uri.slice(prefix.length);
      monaco.editor.setModelMarkers(model, 'latex', (diagnostics ?? []).filter((d) => d.file === path).map(toMarker));
    }
  }, [diagnostics, projectId, active]);

  // Reveal requests (diagnostics, outline, SyncTeX inverse search).
  useEffect(() => {
    const editor = editorRef.current;
    if (!reveal || !editor || reveal.path !== active) return;
    const position = { lineNumber: reveal.line, column: reveal.column ?? 1 };
    editor.setPosition(position);
    editor.revealLineInCenter(reveal.line, monaco.editor.ScrollType.Smooth);
    useLayout.getState().setAssistantFront(false);
    editor.focus();
  }, [reveal, active]);

  // Insert requests (citations from the References panel): typed at the selection, one undo step.
  const insertion = useEditor((s) => s.insertion);
  useEffect(() => {
    const editor = editorRef.current;
    if (!insertion || !editor || insertion.path !== active) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.pushUndoStop();
    editor.executeEdits('rs.insert', [{ range: selection, text: insertion.text, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    useLayout.getState().setAssistantFront(false);
    editor.focus();
    useEditor.setState({ insertion: null });
  }, [insertion, active]);

  // Dispose this project's models when leaving the workspace.
  useEffect(
    () => () => {
      for (const model of monaco.editor.getModels()) {
        if (model.uri.toString(true).startsWith(`file:///${projectId}/`)) model.dispose();
      }
    },
    [projectId],
  );

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    const { KeyMod, KeyCode } = monaco;
    editor.addAction({ id: 'rs.save', label: 'Save file', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS], run: () => {
      const path = useEditor.getState().active;
      if (path) void saveFile(path);
    } });
    editor.addAction({ id: 'rs.compile', label: 'Compile project', keybindings: [KeyMod.CtrlCmd | KeyCode.Enter], run: () => void compileProject() });
    editor.addAction({ id: 'rs.forward', label: 'Show position in PDF (SyncTeX)', keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ], contextMenuGroupId: 'navigation', run: () => void forwardSearch() });
    editor.addAction({ id: 'rs.quickOpen', label: 'Go to file', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyP], run: () => useLayout.getState().openPalette('files') });
    editor.addAction({ id: 'rs.commands', label: 'Show all commands', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP], run: () => useLayout.getState().openPalette('commands') });
    editor.addAction({ id: 'rs.toggleExplorer', label: 'Toggle explorer', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyB], run: () => useLayout.getState().toggle('explorer') });
    editor.addAction({ id: 'rs.toggleProblems', label: 'Toggle problems panel', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyJ], run: () => useLayout.getState().toggle('diagnostics') });

    // Selected-text actions: open the assistant and run the action on the selection.
    for (const action of ['explain', 'improve-wording', 'check-notation'] as const) {
      editor.addAction({
        id: `rs.ai.${action}`,
        label: `Assistant: ${WRITING_ACTIONS[action].label}`,
        contextMenuGroupId: '9_assistant',
        precondition: 'editorHasSelection',
        run: () => {
          useLayout.getState().showAssistant();
          void ask(projectId, action, '');
        },
      });
    }

    editor.addAction({
      id: 'rs.evidence.check',
      label: 'Check evidence for the selection',
      contextMenuGroupId: '9_assistant',
      precondition: 'editorHasSelection',
      run: () => {
        useLayout.getState().toggle('evidence', true);
        useEvidenceRequest.getState().request();
      },
    });
    marks.current = null;
    setMounted((n) => n + 1);

    editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, column: e.position.column }));
    editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel();
      const file = useEditor.getState().active;
      if (!model || !file || e.selection.isEmpty()) return setSelection(null);
      setSelection({
        file,
        fromLine: e.selection.startLineNumber,
        toLine: e.selection.endLineNumber,
        startColumn: e.selection.startColumn,
        endColumn: e.selection.endColumn,
        // The runtime checks this against the saved file to detect a stale selection.
        text: model.getValueInRange(e.selection),
      });
    });
  };

  const options = useMemo<MonacoEditor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontFamily: "'Atkinson Hyperlegible Mono Variable', 'Atkinson Hyperlegible Mono', ui-monospace, monospace",
      fontSize: settings.editorFontSize,
      lineHeight: Math.round(settings.editorFontSize * 1.6),
      wordWrap: settings.editorWordWrap ? 'on' : 'off',
      wrappingIndent: 'same',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      padding: { top: 10, bottom: codeBottomPadding },
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      unicodeHighlight: { ambiguousCharacters: false },
      guides: { indentation: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggest: { showWords: false, snippetsPreventQuickSuggestions: false },
      tabSize: 2,
      automaticLayout: true,
      fixedOverflowWidgets: true,
      ariaLabel: 'LaTeX source editor',
    }),
    [settings.editorFontSize, settings.editorWordWrap, codeBottomPadding],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <Tabs />
      {buffer?.conflict ? <ConflictBar projectId={projectId} path={buffer.path} deleted={buffer.diskState === 'deleted'} /> : null}
      <div className="relative min-h-0 flex-1">
        <div className="h-full" data-testid="editor">
          {buffer ? (
            <Editor
              key={projectId}
              path={modelUri(projectId, buffer.path).toString()}
              defaultValue={buffer.content}
              defaultLanguage={editorLanguageFor(buffer.path)}
              language={editorLanguageFor(buffer.path)}
              theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
              onChange={(value) => setContent(buffer.path, value ?? '')}
              onMount={onMount}
              options={options}
              loading={<div className="h-full bg-panel" />}
            />
          ) : (
            <EmptyEditor />
          )}
        </div>
        {assistantOpen ? <AssistantDock projectId={projectId} /> : null}
      </div>
    </div>
  );
}
