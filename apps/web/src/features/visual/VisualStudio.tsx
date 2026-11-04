import { CheckCircle2, ChevronLeft, Copy, Download, FileInput, Hammer, Lightbulb, PanelLeft, PanelRight, RefreshCw, ScanSearch, Send, Shapes, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { VisualTaskType } from '@research-studio/shared-types';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
  Select,
  Spinner,
  Tooltip,
} from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { BottomPanel } from './BottomPanel';
import { ConsentDialog } from './ConsentDialog';
import { InputPanel, type TaskSettings } from './InputPanel';
import { InsertDialog } from './InsertDialog';
import { consentRequest, errorText, isFinished, PRESETS, TASK_LABEL, type ConsentRequest } from './model';
import { PreviewPane } from './PreviewPane';
import { invalidateArtifact, useArtifact, useArtifacts, useVersions, useVisualTask } from './queries';
import { SourcePanel } from './SourcePanel';

const WIDE = '(min-width: 1100px)';
const SETTINGS_KEY = 'rs.visual.settings';

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(WIDE);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true),
  );
}

function loadSettings(): TaskSettings {
  const base: TaskSettings = { taskType: 'auto', providerId: '', model: '', layout: 'preserve', text: '', imageDetail: 'auto' };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<TaskSettings>;
    return { ...base, providerId: saved.providerId ?? '', model: saved.model ?? '' };
  } catch {
    return base;
  }
}

/**
 * Visual Studio (M4): turn images into editable LaTeX. Input on the left,
 * preview in the centre with results below, source on the right. Panels
 * resize and collapse; on narrow screens they become tabs. Every task runs
 * in the background; the page stays usable while it runs.
 */
export function VisualStudio({ projectId, backLabel, onBack }: { projectId: string | null; backLabel: string; onBack: () => void }) {
  const wide = useWide();
  const [settings, setSettings] = useState<TaskSettings>(loadSettings);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [consent, setConsent] = useState<{ request: ConsentRequest; proceed: () => Promise<void> } | null>(null);
  const [starting, setStarting] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [refining, setRefining] = useState(false);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [narrowTab, setNarrowTab] = useState<'input' | 'preview' | 'source' | 'details'>('input');

  const task = useVisualTask(taskId).data ?? null;
  const art = useArtifact(artifactId);
  const versions = useVersions(artifactId).data ?? [];
  const history = useArtifacts(projectId);
  const artifact = art.data?.artifact ?? null;
  const version = selected ? (versions.find((v) => v.versionNumber === selected) ?? art.data?.version ?? null) : (art.data?.version ?? null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ providerId: settings.providerId, model: settings.model }));
    } catch {
      /* private mode */
    }
  }, [settings.providerId, settings.model]);

  // A finished task opens its artifact.
  useEffect(() => {
    if (task?.status === 'completed' && task.artifactId && task.artifactId !== artifactId) {
      setArtifactId(task.artifactId);
      setSelected(null);
      if (!wide) setNarrowTab('preview');
    }
  }, [task?.status, task?.artifactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useCallback(
    async (file: File) => {
      try {
        const r = await runtime().visual.upload(file, file.name || 'pasted.png', 'clipboard', projectId ?? undefined);
        setAssetId(r.working.id);
      } catch (e) {
        toast.error(errorText(e));
      }
    },
    [projectId],
  );

  // Ctrl+V anywhere outside a text field pastes an image.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName) || t.closest('.monaco-editor'))) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void upload(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [upload]);

  /** Run something that may need consent; on a CONSENT_REQUIRED refusal, ask and run again with consent. */
  const withConsent = async (run: (consent: boolean) => Promise<void>) => {
    try {
      await run(false);
    } catch (e) {
      const request = consentRequest(e);
      if (request) setConsent({ request, proceed: () => run(true) });
      else toast.error(errorText(e));
    }
  };

  const start = async (overrides: Partial<TaskSettings> & { taskType?: VisualTaskType } = {}) => {
    const s = { ...settings, ...overrides };
    setStarting(true);
    await withConsent(async (ok) => {
      const r = await runtime().visual.createTask({
        taskType: s.taskType,
        assetId: s.taskType === 'text-to-diagram' ? null : assetId,
        text: s.text.trim() || null,
        projectId,
        layout: s.layout,
        imageDetail: s.imageDetail,
        providerId: s.providerId,
        model: s.model.trim(),
        consent: ok,
      });
      setTaskId(r.task.id);
    });
    setStarting(false);
  };

  const refine = async (text: string) => {
    if (!artifact || !text.trim()) return;
    setRefining(true);
    await withConsent(async (ok) => {
      const r = await runtime().visual.refine(artifact.id, { instruction: text, providerId: settings.providerId, model: settings.model.trim(), consent: ok });
      invalidateArtifact(artifact.id);
      setSelected(null);
      setInstruction('');
      const extra = [...r.topologyChanges.map((t) => `Topology: ${t}`), ...r.ambiguities.map((a) => `Unclear: ${a}`)];
      toast.success(`${r.summary || 'Changed'} (version ${r.version.versionNumber})${extra.length ? `. ${extra.join(' ')}` : ''}`);
    });
    setRefining(false);
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      if (artifact) invalidateArtifact(artifact.id);
      toast.success(done);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const exportAs = async (format: 'tex' | 'standalone' | 'csv' | 'json') => {
    if (!artifact || !version) return;
    try {
      const text = await runtime().visual.export(artifact.id, version.versionNumber, format);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'figure'}${format === 'standalone' ? '-standalone' : ''}.${format === 'standalone' ? 'tex' : format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const running = starting || (!!task && !isFinished(task) && task.status !== 'needs_input');
  const approved = !!artifact && !!version && artifact.approval === 'approved' && artifact.approvedVersion === version.versionNumber;
  const canApprove = !!version && (artifact?.artifactType === 'explanation' || version.compilationStatus === 'succeeded');
  const imageAsset = assetId ?? artifact?.sourceAssetId ?? null;

  const input = <InputPanel projectId={projectId} assetId={assetId} onAsset={setAssetId} settings={settings} onSettings={(p) => setSettings((s) => ({ ...s, ...p }))} onRun={() => void start()} running={running} />;
  const preview = (
    <PreviewPane
      assetId={imageAsset}
      task={task}
      artifact={artifact}
      version={version}
      onChoose={(t) => taskId && void runtime().visual.chooseTaskType(taskId, t).catch((e: unknown) => toast.error(errorText(e)))}
      onCancel={() => taskId && void runtime().visual.cancelTask(taskId).catch((e: unknown) => toast.error(errorText(e)))}
      onRetry={() => void start()}
    />
  );
  const source = <SourcePanel artifact={artifact} version={version} isCurrent={!!artifact && version?.versionNumber === artifact.currentVersion} />;
  const bottom = <BottomPanel artifact={artifact} version={version} versions={versions} onSelectVersion={setSelected} />;

  return (
    <main className="flex h-dvh flex-col bg-paper" data-testid="visual-studio">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-ink-muted">
          <ChevronLeft /> {backLabel}
        </Button>
        <h1 className="flex items-center gap-2 font-display text-[19px] leading-none text-ink">
          <Shapes className="size-[18px] text-accent" aria-hidden /> Visual Studio
        </h1>
        {history.data?.length ? (
          <Select
            aria-label="Open an earlier result"
            className="ml-2 w-auto max-w-[260px]"
            value={artifactId ?? ''}
            onChange={(e) => {
              setArtifactId(e.target.value || null);
              setSelected(null);
              setTaskId(null);
            }}
          >
            <option value="">Earlier results…</option>
            {history.data.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} (v{a.currentVersion})
              </option>
            ))}
          </Select>
        ) : null}
        {wide ? (
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip content={showLeft ? 'Hide input' : 'Show input'}>
              <Button variant="ghost" size="icon" aria-label="Toggle input panel" aria-pressed={showLeft} onClick={() => setShowLeft((v) => !v)}>
                <PanelLeft />
              </Button>
            </Tooltip>
            <Tooltip content={showRight ? 'Hide source' : 'Show source'}>
              <Button variant="ghost" size="icon" aria-label="Toggle source panel" aria-pressed={showRight} onClick={() => setShowRight((v) => !v)}>
                <PanelRight />
              </Button>
            </Tooltip>
          </div>
        ) : null}
      </header>

      {artifact && version ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-rule bg-panel px-2 py-1" role="toolbar" aria-label="Result actions">
          <span className="mr-1 max-w-[30ch] truncate text-ui font-medium" title={artifact.title}>
            {artifact.title}
          </span>
          <span className="mr-2 text-[12px] text-ink-muted">
            {TASK_LABEL[(task?.resolvedType ?? task?.taskType ?? 'auto') as VisualTaskType] && task ? `${TASK_LABEL[(task.resolvedType ?? task.taskType) as VisualTaskType]} · ` : ''}version {version.versionNumber}
            {version.versionNumber !== artifact.currentVersion ? ` of ${artifact.currentVersion}` : ''}
          </span>
          <form
            className="flex min-w-[220px] flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void refine(instruction);
            }}
          >
            <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Improve: “make the coupler dashed”, “label the drive line”" aria-label="Describe a change" maxLength={4000} data-testid="refine-input" />
            <Button type="submit" size="sm" disabled={!instruction.trim() || refining || !settings.providerId} data-testid="refine">
              {refining ? <Spinner /> : <Send />} Improve
            </Button>
          </form>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={refining || !settings.providerId}>
                <Wand2 /> Simplify / style
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => void refine(p.instruction)}>
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {imageAsset ? (
            <>
              <Tooltip content="Reconstruct again from the image">
                <Button size="sm" onClick={() => void start({ taskType: task?.resolvedType ?? settings.taskType })} disabled={running}>
                  <RefreshCw /> Reconstruct
                </Button>
              </Tooltip>
              <Tooltip content="Reconstruct with the image at full detail">
                <Button size="sm" onClick={() => void start({ taskType: task?.resolvedType ?? settings.taskType, imageDetail: 'high' })} disabled={running}>
                  <ScanSearch /> Precise
                </Button>
              </Tooltip>
              <Button size="sm" onClick={() => void start({ taskType: 'explanation' })} disabled={running}>
                <Lightbulb /> Explain
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={() => void act(() => runtime().visual.compile(artifact.id, version.versionNumber), 'Compiling…')} disabled={version.compilationStatus === 'compiling' || artifact.artifactType === 'explanation'}>
            <Hammer /> Compile
          </Button>
          <Button
            size="sm"
            variant={approved ? 'ghost' : 'secondary'}
            disabled={approved || !canApprove}
            title={canApprove ? undefined : 'Only a version that compiled can be approved'}
            onClick={() => void act(() => runtime().visual.approve(artifact.id, version.versionNumber), `Version ${version.versionNumber} approved`)}
            data-testid="approve"
          >
            <CheckCircle2 /> {approved ? 'Approved' : 'Approve'}
          </Button>
          <Button size="sm" variant="primary" disabled={!approved} title={approved ? undefined : 'Approve this version first'} onClick={() => setInsertOpen(true)} data-testid="open-insert">
            <FileInput /> Insert
          </Button>
          <Tooltip content="Copy the source">
            <Button size="icon-sm" variant="ghost" aria-label="Copy the source" onClick={() => void navigator.clipboard?.writeText(version.sourceCode).then(() => toast.success('Copied'))}>
              <Copy />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Export">
                <Download />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => void exportAs('tex')}>LaTeX snippet (.tex)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportAs('standalone')}>Standalone document (.tex)</DropdownMenuItem>
              {artifact.artifactType === 'plot' ? <DropdownMenuItem onSelect={() => void exportAs('csv')}>Data with origins (.csv)</DropdownMenuItem> : null}
              <DropdownMenuItem onSelect={() => void exportAs('json')}>Structure (.json)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {wide ? (
        <ResizableGroup orientation="horizontal" className="min-h-0 flex-1">
          {showLeft ? (
            <>
              <ResizablePanel defaultSize="22%" minSize="16%" maxSize="40%" id="v-left">
                {input}
              </ResizablePanel>
              <ResizableHandle />
            </>
          ) : null}
          <ResizablePanel minSize="30%" id="v-center">
            <ResizableGroup orientation="vertical">
              <ResizablePanel defaultSize="68%" minSize="25%" id="v-preview">
                {preview}
              </ResizablePanel>
              <ResizableHandle orientation="horizontal" />
              <ResizablePanel defaultSize="32%" minSize="12%" id="v-bottom">
                {bottom}
              </ResizablePanel>
            </ResizableGroup>
          </ResizablePanel>
          {showRight ? (
            <>
              <ResizableHandle />
              <ResizablePanel defaultSize="30%" minSize="20%" maxSize="50%" id="v-right">
                {source}
              </ResizablePanel>
            </>
          ) : null}
        </ResizableGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <nav aria-label="Visual Studio panels" className="flex shrink-0 border-b border-rule">
            {(['input', 'preview', 'source', 'details'] as const).map((t) => (
              <button key={t} type="button" aria-current={narrowTab === t ? 'page' : undefined} onClick={() => setNarrowTab(t)} className={cn('flex-1 py-2 text-ui capitalize text-ink-muted', narrowTab === t && 'border-b-2 border-accent text-ink')}>
                {t}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1">{narrowTab === 'input' ? input : narrowTab === 'preview' ? preview : narrowTab === 'source' ? source : bottom}</div>
        </div>
      )}

      <ConsentDialog
        request={consent?.request ?? null}
        onCancel={() => setConsent(null)}
        onConfirm={() => {
          const c = consent;
          setConsent(null);
          if (c) void c.proceed().catch((e: unknown) => toast.error(errorText(e)));
        }}
      />
      {artifact && version && insertOpen ? <InsertDialog open onClose={() => setInsertOpen(false)} artifact={artifact} versionNumber={version.versionNumber} defaultProjectId={projectId} /> : null}
    </main>
  );
}
