import { Columns2, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import type { ArtifactVersion, VisualArtifact, VisualTask } from '@research-studio/api-contracts';
import { Badge, Button, cn, PanelHeading, Spinner } from '@research-studio/ui';
import { PdfDocumentView } from '../documents/PdfDocumentView';
import { useAssetUrl, usePreviewPdf } from './hooks';
import { COMPILE_TEXT, explanationOf, STATUS_TEXT, TASK_LABEL } from './model';

/**
 * The centre: the input image and the compiled result, side by side or one
 * at a time. A result is shown as compiled only when the isolated compile
 * succeeded; otherwise the reason is shown instead of a picture.
 */
export function PreviewPane({
  assetId,
  task,
  artifact,
  version,
  onChoose,
  onCancel,
  onRetry,
}: {
  assetId: string | null;
  task: VisualTask | null;
  artifact: VisualArtifact | null;
  version: ArtifactVersion | null;
  onChoose: (t: VisualTask['taskType']) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [mode, setMode] = useState<'both' | 'input' | 'result'>('both');
  const [scale, setScale] = useState(1.6);
  const url = useAssetUrl(assetId);
  const compiled = version?.compilationStatus === 'succeeded' && !!version.previewAssetId;
  const pdf = usePreviewPdf(artifact?.id ?? null, version?.versionNumber ?? null, compiled);
  const explanation = explanationOf(version);
  const status = version ? COMPILE_TEXT[version.compilationStatus] : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper" data-testid="visual-preview">
      <PanelHeading className="text-ink-muted flex items-center gap-2">
        Preview
        {status ? (
          <Badge className="text-ink" tone={status.tone} data-testid="compile-status">
            {status.label}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.6, s - 0.2))}>
            <Minus />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(4, s + 0.2))}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Side by side" aria-pressed={mode === 'both'} onClick={() => setMode(mode === 'both' ? 'result' : 'both')}>
            <Columns2 />
          </Button>
        </div>
      </PanelHeading>
      {task && !['completed'].includes(task.status) ? (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-rule bg-raised px-3 py-2 text-ui" role="status" data-testid="task-status">
          {task.status === 'queued' || task.status === 'running' ? <Spinner /> : null}
          <span className="font-medium">{STATUS_TEXT[task.status]}</span>
          <span className="text-ink-muted">{task.progress ?? task.error ?? ''}</span>
          {task.status === 'needs_input' ? (
            <span className="flex flex-wrap items-center gap-1">
              The image could be:
              {(task.choices ?? []).map((c) => (
                <Button key={c} size="sm" onClick={() => onChoose(c)} data-testid={`choose-${c}`}>
                  {TASK_LABEL[c]}
                </Button>
              ))}
            </span>
          ) : null}
          {task.status === 'queued' || task.status === 'running' || task.status === 'needs_input' ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" className="ml-auto" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ) : null}
      <div className={cn('grid min-h-0 flex-1 gap-2 px-3 pb-3', mode === 'both' && url ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1')}>
        {url && mode !== 'result' ? (
          <figure className="flex min-h-0 flex-col rounded-md border border-rule bg-white">
            <figcaption className="border-b border-rule px-2 py-1 text-[11px] text-ink-muted">Input</figcaption>
            <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-2" tabIndex={0} role="region" aria-label="Input image">
              <img src={url} alt="Input" style={{ maxWidth: `${scale * 50}%` }} className="h-auto" />
            </div>
          </figure>
        ) : null}
        {mode !== 'input' ? (
          <figure className="flex min-h-0 flex-col rounded-md border border-rule bg-white" data-testid="result-view">
            <figcaption className="border-b border-rule px-2 py-1 text-[11px] text-ink-muted">{version ? `Result, version ${version.versionNumber}` : 'Result'}</figcaption>
            <div className="min-h-0 flex-1 overflow-auto p-2" data-pdf-scroller tabIndex={0} role="region" aria-label="Compiled result">
              {explanation ? (
                <ExplanationView e={explanation} />
              ) : !version ? (
                <p className="p-4 text-ui text-ink-muted">Run a task to see the reconstruction here.</p>
              ) : version.compilationStatus === 'compiling' ? (
                <div className="grid h-full place-items-center">
                  <Spinner />
                </div>
              ) : compiled && pdf.doc ? (
                <PdfDocumentView doc={pdf.doc} scale={scale} />
              ) : compiled ? (
                <Spinner />
              ) : (
                <div className="p-4 text-ui text-ink-muted" data-testid="not-compiled">
                  {version.compilationStatus === 'failed'
                    ? 'The source did not compile; see the log below. Nothing is shown as a result until it compiles.'
                    : version.compilationStatus === 'invalid'
                      ? 'The source was refused before compiling (see Validation below).'
                      : 'Not compiled yet.'}
                </div>
              )}
            </div>
          </figure>
        ) : null}
      </div>
    </div>
  );
}

function ExplanationView({ e }: { e: NonNullable<ReturnType<typeof explanationOf>> }) {
  return (
    <div className="flex flex-col gap-3 p-2 text-ui" data-testid="explanation">
      <section>
        <h3 className="mb-1 font-medium">Observed in the image</h3>
        <ul className="list-disc pl-5">
          {e.observations.map((o, i) => (
            <li key={i}>
              <span className="text-ink-muted">{o.kind}:</span> {o.text}
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-md border border-warning/50 bg-warning-soft/40 p-2">
        <h3 className="mb-1 font-medium">Interpretation (the model’s reading, check it)</h3>
        <ul className="list-disc pl-5">
          {e.interpretation.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </section>
      {e.caption ? (
        <section>
          <h3 className="mb-1 font-medium">Draft caption</h3>
          <p>{e.caption}</p>
        </section>
      ) : null}
      {e.uncertainties.length ? (
        <section>
          <h3 className="mb-1 font-medium">Uncertain</h3>
          <ul className="list-disc pl-5">
            {e.uncertainties.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
