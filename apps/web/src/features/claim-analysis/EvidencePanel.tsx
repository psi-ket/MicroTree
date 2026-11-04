import { ListChecks, ShieldQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, cn, PanelHeading, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { useEditor } from '../../stores/editor';
import { PdfViewer } from '../library/PdfViewer';
import { EvidenceConsentDialog } from '../evidence-review/EvidenceConsentDialog';
import { ModelPicker, type ModelChoice } from '../evidence-review/ModelPicker';
import { evidenceKeys, privacyRefusal, useClaims, useEvidenceRequest, useJob, useModelFor, withConsent } from '../evidence-review/state';
import { WritingTools } from '../scientific-writing/WritingTools';
import { ClaimCard, type PdfTarget } from './ClaimCard';

/**
 * The evidence panel beside the editor. With text selected: the claims in
 * it (extracted on request; the manuscript is never changed), each with its
 * evidence, conflicts and citations, plus writing tools for the selection.
 * Without a selection: the claims of the open file.
 */
export function EvidencePanel({ projectId }: { projectId: string }) {
  const selection = useEditor((s) => (s.selection && s.selection.file === s.active ? s.selection : null));
  const active = useEditor((s) => s.active);
  const claims = useClaims(projectId);
  const [tab, setTab] = useState<'claims' | 'writing'>('claims');
  const [method, setMethod] = useState<'heuristic' | 'model'>('heuristic');
  const settingsModel = useModelFor(projectId, 'assessment');
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [pdf, setPdf] = useState<PdfTarget | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const nonce = useEvidenceRequest((s) => s.nonce);
  const lastNonce = useRef(nonce);
  useEffect(() => setModel((m) => m ?? settingsModel), [settingsModel]);

  const list = claims.data?.claims ?? [];
  const inSelection = selection ? list.filter((c) => c.anchor.filePath === selection.file && c.anchor.lines && c.anchor.lines.from <= selection.toLine && c.anchor.lines.to >= selection.fromLine) : [];
  const inFile = list.filter((c) => c.anchor.filePath === active);
  const shown = selection ? inSelection : inFile;

  const extract = async () => {
    if (!selection) return;
    setExtracting(true);
    const scope = { kind: 'selection' as const, file: selection.file, startLine: selection.fromLine, startColumn: selection.startColumn, endLine: selection.toLine, endColumn: selection.endColumn };
    await withConsent(
      async (consent) => {
        const r = await runtime().evidence.extract({ projectId, scope, method, ...(method === 'model' && model ? { model: { ...model, consent } } : {}) });
        if (r.job) setJobId(r.job.id);
        else if (!r.claims.length) toast.info(r.nonClaims.length ? 'No new claims here; the selection holds no scientific claims or they were already extracted.' : 'No claims found in the selection.');
        void queryClient.invalidateQueries({ queryKey: evidenceKeys.claims(projectId) });
      },
      (err) => toast.error(privacyRefusal(err) ?? errorMessage(err)),
    );
    setExtracting(false);
  };

  // "Check evidence" from the editor's context menu.
  useEffect(() => {
    if (nonce !== lastNonce.current) {
      lastNonce.current = nonce;
      setTab('claims');
      void extract();
    }
  }, [nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="evidence-panel">
      <PanelHeading className="flex items-center gap-1 text-ink-muted">
        <ShieldQuestion className="size-3.5" aria-hidden /> Evidence
        <nav aria-label="Evidence panel" className="ml-auto flex gap-0.5 normal-case tracking-normal">
          {(['claims', 'writing'] as const).map((t) => (
            <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)} className={cn('rounded-ctl px-1.5 py-0.5 text-[12px] font-normal text-ink-muted hover:bg-sunken', tab === t && 'bg-sunken text-ink')}>
              {t === 'claims' ? 'Claims' : 'Writing'}
            </button>
          ))}
        </nav>
      </PanelHeading>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
        {tab === 'claims' ? (
          <>
            {selection ? (
              <section className="rounded-md border border-rule bg-raised p-2" aria-label="Selected text">
                <h2 className="mb-1 text-[12px] font-medium text-ink-muted">Selected text</h2>
                <p className="max-h-28 overflow-auto whitespace-pre-wrap text-[12px]" data-testid="selected-text">
                  {selection.text}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Select aria-label="Extraction method" className="h-7 w-auto" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                    <option value="heuristic">Find claims (rules, no model)</option>
                    <option value="model">Find claims with the model</option>
                  </Select>
                  <Button size="sm" variant="primary" onClick={() => void extract()} disabled={extracting || (method === 'model' && !model)} data-testid="extract-claims">
                    {extracting || (job && job.status === 'running') ? <Spinner /> : <ListChecks />} Find claims
                  </Button>
                </div>
              </section>
            ) : (
              <p className="text-[12px] text-ink-muted">Select a sentence or paragraph to check its claims. Claims of {active ?? 'the open file'} are listed below.</p>
            )}
            <ModelPicker value={model} onChange={setModel} label="Assessment model" />
            {claims.isLoading ? <Spinner /> : null}
            {shown.map((c) => (
              <ClaimCard key={c.id} projectId={projectId} claim={c} model={model} onOpenPdf={setPdf} defaultOpen={!!selection && shown.length === 1} />
            ))}
            {!claims.isLoading && !shown.length ? <p className="text-[12px] text-ink-muted">{selection ? 'No claims extracted from this selection yet.' : 'No claims in this file yet.'}</p> : null}
          </>
        ) : (
          <WritingTools projectId={projectId} selection={selection} defaultModel={model} />
        )}
      </div>
      {pdf ? (
        <PdfViewer
          itemId={pdf.itemId}
          attachmentId={pdf.attachmentId}
          title={pdf.title}
          initialPage={pdf.page}
          highlights={pdf.record.source.coordinates}
          description={`${pdf.record.source.location}. The highlighted text is the passage used as evidence.`}
          onClose={() => setPdf(null)}
        />
      ) : null}
      <EvidenceConsentDialog />
    </div>
  );
}
