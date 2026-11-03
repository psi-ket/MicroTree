import { Play, RefreshCw, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { RetrievalProviders } from '@research-studio/api-contracts';
import { Button, Input, Label, Spinner, Switch } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateDocuments, queryClient, keys, useDocumentJobs, useIndexStatus, useRetrievalProviders } from '../../lib/queries';
import { SectionHeading, Tag } from '../literature/common';
import { isActiveDocumentJob } from './model';

const GROBID_HINT = 'docker run --rm --init --ulimit core=0 -p 127.0.0.1:8070:8070 grobid/grobid:0.9.1-crf';

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'warning' | 'danger' }) {
  return (
    <div className="rounded-md border border-rule bg-panel px-3 py-2">
      <p className="text-2xs text-ink-muted">{label}</p>
      <p className={`mt-0.5 text-[20px] tabular-nums ${tone === 'danger' && value ? 'text-danger' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

function ServiceLine({ name, s, extra }: { name: string; s: { status: string; version: string | null; message: string | null }; extra?: string }) {
  const tone = s.status === 'available' ? 'success' : s.status === 'disabled' ? 'neutral' : 'warning';
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <Tag dot={tone}>{name}</Tag>
      <span className="text-ink">{s.status === 'available' ? `available${s.version ? ` (${s.version})` : ''}` : s.status}</span>
      {extra ? <span className="text-ink-muted">{extra}</span> : null}
      {s.message ? <span className="basis-full text-ink-muted">{s.message}</span> : null}
    </li>
  );
}

function EmbeddingSettings({ providers }: { providers: RetrievalProviders }) {
  const [model, setModel] = useState(providers.settings.embeddingModel);
  useEffect(() => setModel(providers.settings.embeddingModel), [providers.settings.embeddingModel]);
  const save = async (patch: Parameters<ReturnType<typeof runtime>['retrieval']['updateSettings']>[0]) => {
    try {
      const res = await runtime().retrieval.updateSettings(patch);
      queryClient.setQueryData([...keys.documents.providers, false], res);
      invalidateDocuments();
    } catch (err) {
      toast.error('Could not save the setting', { description: errorMessage(err) });
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <label className="flex items-center gap-2 text-ui text-ink">
        <Switch checked={providers.settings.autoProcess} onCheckedChange={(v) => void save({ autoProcess: v })} aria-label="Process new PDFs automatically" />
        Process new PDFs automatically
      </label>
      <label className="flex items-center gap-2 text-ui text-ink">
        <Switch checked={providers.settings.embeddingsEnabled} onCheckedChange={(v) => void save({ embeddingsEnabled: v })} aria-label="Semantic search with local embeddings" />
        Semantic search with local embeddings (Ollama on {providers.embeddings.host})
      </label>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (model.trim() && model !== providers.settings.embeddingModel) void save({ embeddingModel: model.trim() });
        }}
      >
        <div>
          <Label htmlFor="emb-model" className="text-2xs text-ink-muted">
            Embedding model
          </Label>
          <Input id="emb-model" value={model} onChange={(e) => setModel(e.target.value)} className="h-7 w-56 text-xs" maxLength={200} />
        </div>
        <Button size="sm" type="submit" disabled={!model.trim() || model === providers.settings.embeddingModel}>
          Use this model
        </Button>
      </form>
      <p className="text-2xs text-ink-muted">Changing the model needs a reindex. The current index stays in use until the new one is complete; vectors of different models are never mixed.</p>
      {providers.embeddings.remote ? <p className="text-xs text-danger">The embedding service is on another computer: passage text is sent there.</p> : null}
    </div>
  );
}

/** Processing status of the whole library, extractor and embedding status, and the actions to fix what is missing. */
export function DashboardView() {
  const { data: status, isLoading } = useIndexStatus();
  const { data: providers, refetch, isFetching } = useRetrievalProviders(false);
  const { data: failed } = useDocumentJobs('failed');
  const { data: active } = useDocumentJobs('active');

  const act = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      invalidateDocuments();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(`Could not ${what}`, { description: errorMessage(err) });
    }
  };

  if (isLoading || !status) return <Spinner className="m-6 text-ink-muted" />;
  const d = status.documents;
  const e = status.embeddings;
  const reindexing = e.reindex?.status === 'running';
  const embedPct = e.embeddablePassages ? Math.round((e.indexedPassages / e.embeddablePassages) * 100) : 0;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto" data-testid="extraction-dashboard">
      <div className="mx-auto max-w-4xl px-4 py-5">
        <h2 className="font-display text-[19px] text-ink">Full text and search index</h2>
        <p className="mt-0.5 text-xs text-ink-muted">PDFs are processed on this computer. Extraction runs in the background; you can keep working.</p>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Processed" value={d.processed} />
          <Stat label="Waiting" value={d.waiting} />
          <Stat label="In progress" value={d.queued + d.running} />
          <Stat label="Failed" value={d.failed} tone="danger" />
          <Stat label="Need OCR" value={d.needsOcr} />
          <Stat label="With gaps" value={d.partial} />
          <Stat label="Out of date" value={d.stale} />
          <Stat label="Indexed passages" value={status.keyword.passages} />
        </div>
        <p className="mt-2 text-2xs text-ink-muted">Last indexed: {status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : 'never'}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" disabled={!d.waiting} onClick={() => void act('queue the waiting PDFs', () => runtime().documents.processAll(), 'Queued the waiting PDFs')}>
            <Play /> Process {d.waiting} waiting PDF{d.waiting === 1 ? '' : 's'}
          </Button>
        </div>

        <section className="mt-6" aria-labelledby="dash-services">
          <div className="flex items-center gap-2">
            <SectionHeading id="dash-services">Extractors and embeddings</SectionHeading>
            <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw /> Check again
            </Button>
          </div>
          {providers ? (
            <>
              <ul className="mt-2 flex flex-col gap-1.5">
                <ServiceLine name="GROBID" s={providers.grobid} extra={providers.grobid.host ? `at ${providers.grobid.host}` : undefined} />
                <ServiceLine name="PyMuPDF" s={providers.pymupdf} extra={`Python: ${providers.pymupdf.python}`} />
                <ServiceLine name="Embeddings" s={providers.embeddings} extra={providers.embeddings.enabled ? `${providers.embeddings.model}${providers.embeddings.dimensions ? `, ${providers.embeddings.dimensions} dimensions` : ''}` : undefined} />
              </ul>
              {providers.grobid.remote ? <p className="mt-2 text-xs text-danger">GROBID runs on another computer ({providers.grobid.host}): your PDFs are sent there.</p> : null}
              {providers.grobid.status === 'unavailable' ? (
                <div className="mt-2 rounded-md border border-rule p-2.5 text-xs text-ink">
                  <p>Without GROBID, PDFs are read from their page layout only (no equations, tables or reference parsing). To start a local GROBID with Docker:</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-sunken p-1.5 font-mono text-2xs">{GROBID_HINT}</pre>
                </div>
              ) : null}
              {providers.pymupdf.status === 'unavailable' ? <p className="mt-2 text-xs text-ink">Install PyMuPDF for page geometry, quality checks and the fallback: pip install pymupdf (or set RS_PYTHON).</p> : null}
              <EmbeddingSettings providers={providers} />
            </>
          ) : (
            <Spinner className="mt-2 text-ink-muted" />
          )}
        </section>

        <section className="mt-6" aria-labelledby="dash-embeddings">
          <SectionHeading id="dash-embeddings">Semantic index</SectionHeading>
          {e.activeSpace ? (
            <p className="mt-1 text-xs text-ink">
              Active index: {e.activeSpace.model} ({e.activeSpace.dimensions} dimensions{e.activeSpace.version ? `, ${e.activeSpace.version.slice(0, 19)}` : ''}) · {e.indexedPassages} of {e.embeddablePassages} passages
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">No semantic index yet. Keyword search works without one.</p>
          )}
          <div className="mt-1.5 h-1.5 max-w-md overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Semantic index progress" aria-valuenow={embedPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent" style={{ width: `${embedPct}%` }} />
          </div>
          {e.reindex ? (
            <p className="mt-1.5 text-xs text-ink" role="status">
              Reindex with {e.reindex.targetModel}: {e.reindex.status}
              {e.reindex.status === 'running' ? ` (${e.reindex.done}/${e.reindex.total})` : ''}
              {e.reindex.error ? `: ${e.reindex.error}` : ''}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={reindexing || !providers?.settings.embeddingsEnabled} onClick={() => void act('start the reindex', () => runtime().retrieval.reindex(false))}>
              <RefreshCw /> {e.activeSpace && providers && e.activeSpace.model !== providers.settings.embeddingModel ? `Reindex with ${providers.settings.embeddingModel}` : 'Index missing passages'}
            </Button>
            {reindexing ? (
              <Button variant="ghost" onClick={() => void act('cancel the reindex', () => runtime().retrieval.cancelReindex())}>
                <Square /> Cancel
              </Button>
            ) : null}
          </div>
        </section>

        {active?.length ? (
          <section className="mt-6" aria-labelledby="dash-active">
            <SectionHeading id="dash-active">In progress</SectionHeading>
            <ul className="mt-1.5 flex flex-col gap-1 text-xs">
              {active.filter(isActiveDocumentJob).map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <span className="text-ink">{j.stageLabel}</span>
                  <span className="tabular-nums text-ink-muted">{Math.round(j.progress * 100)}%</span>
                  <Button size="sm" variant="ghost" onClick={() => void act('cancel', () => runtime().documents.cancel(j.attachmentId))}>
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {failed?.length ? (
          <section className="mt-6" aria-labelledby="dash-failed">
            <SectionHeading id="dash-failed">Recent failures</SectionHeading>
            <ul className="mt-1.5 flex flex-col gap-1.5 text-xs">
              {failed.slice(0, 20).map((j) => (
                <li key={j.id} className="rounded-md border border-rule p-2">
                  <p className="text-danger">{j.error?.message ?? 'Failed'}</p>
                  <p className="mt-0.5 text-2xs text-ink-muted">
                    {j.error?.retryable ? 'Temporary problem; trying again may work. ' : 'Retrying will not help unless the PDF or the setup changes. '}
                    {new Date(j.createdAt).toLocaleString()}
                  </p>
                  <Button size="sm" variant="ghost" className="mt-1" onClick={() => void act('retry', () => runtime().documents.reprocess(j.attachmentId))}>
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
