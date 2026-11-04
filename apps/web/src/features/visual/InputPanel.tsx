import { useQuery } from '@tanstack/react-query';
import { Clipboard, Contrast, FileImage, FileText, ImageUp, Play, RotateCw, ScanLine, Sparkles, SunMedium, Undo2 } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import type { VisualAsset } from '@research-studio/api-contracts';
import type { FileTreeNode, VisualTaskType } from '@research-studio/shared-types';
import { Badge, Button, cn, FieldHint, Label, PanelHeading, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { useAssetUrl } from './hooks';
import { errorText, LAYOUTS, needsImage, provenanceText, TASK_OPTIONS, type LayoutMode } from './model';
import { PdfRegionDialog } from './PdfRegionDialog';
import { useVisualAsset, useVisualProviders } from './queries';

export interface TaskSettings {
  taskType: VisualTaskType;
  providerId: string;
  model: string;
  layout: LayoutMode;
  text: string;
  imageDetail: 'low' | 'high' | 'auto';
}

const IMAGE_FILE = /\.(png|jpe?g|webp|svg)$/i;

function imagesIn(node: FileTreeNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === 'file' && IMAGE_FILE.test(node.path)) out.push(node.path);
  for (const c of node.children ?? []) imagesIn(c, out);
  return out;
}

/**
 * The left panel: where the image comes from (upload, paste, drop, project
 * file, PDF region), its preprocessing (each step a traceable variant; the
 * original is kept), and what to do with it.
 */
export function InputPanel({
  projectId,
  assetId,
  onAsset,
  settings,
  onSettings,
  onRun,
  running,
}: {
  projectId: string | null;
  assetId: string | null;
  onAsset: (id: string | null) => void;
  settings: TaskSettings;
  onSettings: (patch: Partial<TaskSettings>) => void;
  onRun: () => void;
  running: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const detail = useVisualAsset(assetId);
  const asset = detail.data?.asset ?? null;
  const url = useAssetUrl(assetId);
  const providers = useVisualProviders();
  const tree = useQuery({ queryKey: ['tree', projectId], queryFn: () => runtime().tree(projectId!), enabled: !!projectId });
  const projectImages = imagesIn(tree.data?.tree);
  const provider = providers.data?.providers.find((p) => p.id === settings.providerId) ?? null;

  const add = async (fn: () => Promise<{ asset: VisualAsset; working: VisualAsset; removed: string[] }>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.removed.length) toast.info(`The SVG was sanitised (${r.removed.length} unsafe part${r.removed.length === 1 ? '' : 's'} removed) and converted to PNG for the model.`);
      onAsset(r.working.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = (f: File, source: 'upload' | 'clipboard' = 'upload') => add(() => runtime().visual.upload(f, f.name || 'pasted.png', source, projectId ?? undefined));

  const paste = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return void upload(new File([await item.getType(type)], 'pasted.png', { type }), 'clipboard');
      }
      toast.info('The clipboard holds no image. You can also press Ctrl+V anywhere in the Visual Studio.');
    } catch {
      toast.info('Press Ctrl+V (or ⌘V) to paste an image.');
    }
  };

  const variant = async (operations: Parameters<ReturnType<typeof runtime>['visual']['variant']>[1], label: string) => {
    if (!asset) return;
    setBusy(true);
    try {
      const r = await runtime().visual.variant(asset.id, operations, label);
      onAsset(r.asset.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/') || IMAGE_FILE.test(x.name));
    if (f) void upload(f);
  };

  const imageTask = needsImage(settings.taskType);
  const canRun = !!settings.providerId && !!settings.model.trim() && (imageTask ? !!assetId : !!settings.text.trim()) && !running;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel" data-testid="visual-input">
      <PanelHeading>Input</PanelHeading>
      <div className="flex flex-col gap-3 px-3 pb-4">
        <div
          className={cn('grid min-h-36 place-items-center rounded-md border border-dashed border-rule-strong bg-sunken/40 p-2 text-center', over && 'border-accent bg-accent/5')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="drop-zone"
        >
          {busy ? (
            <Spinner />
          ) : url && asset ? (
            <figure className="flex w-full flex-col items-center gap-1">
              <img src={url} alt="Input image" className="max-h-48 max-w-full object-contain" data-testid="input-image" />
              <figcaption className="text-[11px] text-ink-muted">
                {provenanceText(asset)} · {asset.width}×{asset.height}
              </figcaption>
            </figure>
          ) : (
            <p className="text-ui text-ink-muted">Drop an image here, paste one, or choose a source below.</p>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          aria-label="Upload image"
          data-testid="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <Button onClick={() => file.current?.click()}>
            <ImageUp /> Upload
          </Button>
          <Button onClick={() => void paste()}>
            <Clipboard /> Paste
          </Button>
          <Button onClick={() => setRegionOpen(true)} className="col-span-2">
            <FileText /> Region of a library PDF
          </Button>
        </div>
        {projectId && projectImages.length ? (
          <div>
            <Label htmlFor="project-image">Image from the project</Label>
            <Select id="project-image" value="" onChange={(e) => e.target.value && void add(() => runtime().visual.fromProject(projectId, e.target.value))}>
              <option value="">Choose a file…</option>
              {projectImages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {asset ? (
          <section aria-label="Preprocessing" className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
              <FileImage className="size-3.5" aria-hidden /> Preprocessing
              {asset.kind === 'variant' ? <Badge>variant</Badge> : <Badge tone="success">original</Badge>}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" onClick={() => void variant([{ op: 'rotate', degrees: 90 }], 'Rotated')}>
                <RotateCw /> Rotate
              </Button>
              <Button size="sm" onClick={() => void variant([{ op: 'auto-orient' }, { op: 'normalize' }], 'Deskewed and normalised')}>
                <ScanLine /> Normalise
              </Button>
              <Button size="sm" onClick={() => void variant([{ op: 'contrast', factor: 1.6 }], 'More contrast')}>
                <Contrast /> Contrast
              </Button>
              <Button size="sm" onClick={() => void variant([{ op: 'grayscale' }], 'Greyscale')}>
                <SunMedium /> Greyscale
              </Button>
              <Button size="sm" onClick={() => void variant([{ op: 'sharpen' }, { op: 'upscale', factor: 2 }], 'Enhanced')}>
                <Sparkles /> Enhance
              </Button>
              {asset.kind === 'variant' ? (
                <Button size="sm" variant="ghost" onClick={() => onAsset(asset.originalAssetId)}>
                  <Undo2 /> Original
                </Button>
              ) : null}
            </div>
            <FieldHint>Each step makes a new image; the original is kept and stays linked. Colour is kept unless you choose greyscale.</FieldHint>
          </section>
        ) : null}

        <hr className="border-rule" />
        <div>
          <Label htmlFor="task-type">Task</Label>
          <Select id="task-type" value={settings.taskType} onChange={(e) => onSettings({ taskType: e.target.value as VisualTaskType })} data-testid="task-type">
            {TASK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <FieldHint>{TASK_OPTIONS.find((o) => o.value === settings.taskType)?.hint}</FieldHint>
        </div>
        {settings.taskType === 'diagram' || settings.taskType === 'text-to-diagram' ? (
          <div>
            <Label htmlFor="layout">Layout</Label>
            <Select id="layout" value={settings.layout} onChange={(e) => onSettings({ layout: e.target.value as LayoutMode })}>
              {LAYOUTS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor="task-text">{imageTask ? 'Context (optional)' : 'Describe the diagram'}</Label>
          <textarea
            id="task-text"
            rows={imageTask ? 2 : 5}
            maxLength={8000}
            className="w-full rounded-ctl border border-rule bg-raised px-2 py-1.5 text-ui text-ink outline-none focus:border-accent"
            placeholder={imageTask ? 'e.g. “circuit QED, the dashed box is the readout resonator”' : 'e.g. “A transmon coupled capacitively to a λ/4 resonator, read out through a Purcell filter”'}
            value={settings.text}
            onChange={(e) => onSettings({ text: e.target.value })}
            data-testid="task-text"
          />
        </div>
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <div>
            <Label htmlFor="provider">Provider</Label>
            <Select
              id="provider"
              value={settings.providerId}
              onChange={(e) => {
                const p = providers.data?.providers.find((x) => x.id === e.target.value);
                onSettings({ providerId: e.target.value, model: p?.defaultModel ?? '' });
              }}
              data-testid="provider"
            >
              <option value="">Choose…</option>
              {providers.data?.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.usable}>
                  {p.displayName} ({p.privacyMode === 'local' ? 'local' : 'cloud'}){p.problem ? `, ${p.problem}` : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="model">Model</Label>
            <input
              id="model"
              className="h-7 w-full rounded-ctl border border-rule bg-raised px-2 font-mono text-[12px] text-ink outline-none focus:border-accent"
              value={settings.model}
              onChange={(e) => onSettings({ model: e.target.value })}
              placeholder={provider?.kind === 'ollama' ? 'llava, qwen2.5vl…' : 'model name'}
              data-testid="model"
            />
          </div>
        </div>
        {provider ? (
          <FieldHint>
            {provider.privacyMode === 'local' ? 'Runs on this computer; nothing leaves it.' : `Runs at ${provider.host ?? provider.displayName}; you confirm before anything is sent.`}
            {!providers.data?.compileAvailable ? ' No LaTeX toolchain was found, so results cannot be compiled or approved.' : ''}
          </FieldHint>
        ) : providers.data && !providers.data.providers.length ? (
          <FieldHint>Add a model provider in the assistant settings first (Ollama with a vision model runs locally).</FieldHint>
        ) : null}
        {imageTask ? (
          <label className="flex items-center gap-2 text-ui">
            <input type="checkbox" checked={settings.imageDetail === 'high'} onChange={(e) => onSettings({ imageDetail: e.target.checked ? 'high' : 'auto' })} />
            Precise (send the image at full detail)
          </label>
        ) : null}
        <Button variant="primary" size="lg" disabled={!canRun} onClick={onRun} data-testid="run-task">
          {running ? <Spinner /> : <Play />} {settings.taskType === 'text-to-diagram' ? 'Generate' : 'Reconstruct'}
        </Button>
      </div>
      <PdfRegionDialog open={regionOpen} onClose={() => setRegionOpen(false)} onTaken={(id) => onAsset(id)} />
    </div>
  );
}
