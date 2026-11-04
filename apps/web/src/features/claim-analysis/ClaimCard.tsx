import { CheckCheck, ChevronDown, ChevronRight, Pencil, RefreshCw, Scissors, Search, Sparkles, Quote, Ban } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ClaimView, EvidenceRecordView } from '@research-studio/api-contracts';
import { Badge, Button, cn, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { CitationRecommendations } from '../citation-intelligence/CitationRecommendations';
import { ConflictView } from '../evidence-review/ConflictView';
import { EvidenceItem } from '../evidence-review/EvidenceItem';
import { STATUS_LABEL, STATUS_TONE } from '../evidence-review/labels';
import type { ModelChoice } from '../evidence-review/ModelPicker';
import { evidenceKeys, privacyRefusal, useClaim, useJob, withConsent } from '../evidence-review/state';

export interface PdfTarget {
  itemId: string;
  attachmentId: string;
  title: string;
  page: number | null;
  record: EvidenceRecordView;
}

function countsText(c: ClaimView): string {
  const parts = [
    c.counts.direct_support ? `${c.counts.direct_support} states it` : null,
    c.counts.partial_support ? `${c.counts.partial_support} partly` : null,
    c.counts.indirect_support + c.counts.context_only ? `${c.counts.indirect_support + c.counts.context_only} context` : null,
    c.counts.contradiction ? `${c.counts.contradiction} may contradict` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * One claim: its text (from the manuscript, unchanged), type and status,
 * then its evidence grouped as support, context and possible disagreement,
 * each passage shown individually; conflicts side by side; citations.
 */
export function ClaimCard({ projectId, claim, model, onOpenPdf, defaultOpen = false }: { projectId: string; claim: ClaimView; model: ModelChoice | null; onOpenPdf: (t: PdfTarget) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(claim.claimText);
  const [busy, setBusy] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const detail = useClaim(open ? claim.id : null);
  const running = !!job && (job.status === 'queued' || job.status === 'running');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: evidenceKeys.claim(claim.id) });
    void queryClient.invalidateQueries({ queryKey: evidenceKeys.claims(projectId) });
  };
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      refresh();
    } catch (err) {
      toast.error(privacyRefusal(err) ?? errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const assessAll = () =>
    withConsent(
      async (consent) => {
        if (!model) throw new Error('Choose a model for assessment');
        const r = await runtime().evidence.assessAll(claim.id, { ...model, consent, retrieve: { scope: { kind: 'library' } } });
        setJobId(r.job.id);
        setOpen(true);
      },
      (err) => toast.error(privacyRefusal(err) ?? errorMessage(err)),
    );
  const assessOne = (e: EvidenceRecordView) =>
    withConsent(
      async (consent) => {
        if (!model) throw new Error('Choose a model for assessment');
        const r = await runtime().evidence.assess(e.id, { ...model, consent });
        setJobId(r.job.id);
      },
      (err) => toast.error(privacyRefusal(err) ?? errorMessage(err)),
    );
  const openPdf = (e: EvidenceRecordView) => {
    if (!e.source.libraryItemId || !e.source.attachmentId) return;
    onOpenPdf({ itemId: e.source.libraryItemId, attachmentId: e.source.attachmentId, title: e.source.title, page: e.source.pageStart, record: e });
  };

  const ev = detail.data?.evidence ?? [];
  const group = (pred: (e: EvidenceRecordView) => boolean) => ev.filter(pred);
  const supporting = group((e) => e.effective === 'direct_support' || e.effective === 'partial_support');
  const context = group((e) => e.effective === 'indirect_support' || e.effective === 'context_only');
  const conflicting = group((e) => e.effective === 'contradiction');
  const unassessed = group((e) => !e.effective || e.effective === 'not_assessed' || e.effective === 'insufficient' || e.effective === 'irrelevant');
  const changed = claim.anchor.mappingStatus === 'needs_revalidation' || claim.anchor.mappingStatus === 'modified';

  return (
    <article className="rounded-md border border-rule bg-panel" data-testid="claim-card" data-claim-id={claim.id}>
      <header className="flex items-start gap-1 p-2">
        <button type="button" className="mt-0.5 text-ink-muted" aria-expanded={open} aria-label={open ? 'Hide evidence' : 'Show evidence'} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act('edit', () => runtime().evidence.updateClaim(claim.id, { claimText: text })).then(() => setEditing(false));
              }}
            >
              <textarea aria-label="Claim text" className="w-full rounded-ctl border border-rule bg-raised p-1.5 text-ui" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex gap-1">
                <Button size="sm" type="submit">
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className={cn('text-ui text-ink', claim.reviewState === 'excluded' && 'line-through opacity-70')} data-testid="claim-text">
              {claim.claimText}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
            <Badge className="text-ink" tone={STATUS_TONE[claim.status]} data-testid="claim-status">
              {STATUS_LABEL[claim.status]}
            </Badge>
            <span>{claim.claimType}</span>
            {claim.atomicity !== 'atomic' ? <span>· {claim.atomicity}</span> : null}
            {claim.reviewState === 'proposed' ? <span>· proposed</span> : claim.reviewState === 'approved' ? <span>· approved</span> : null}
            {claim.anchor.lines ? <span>· line {claim.anchor.lines.from}</span> : <span>· not found in the text</span>}
            {countsText(claim) ? <span>· {countsText(claim)}</span> : null}
            {claim.cited.length ? <span>· cites {claim.cited.join(', ')}</span> : null}
          </div>
          {changed && claim.anchor.previousText ? (
            <p className="mt-1 rounded-ctl bg-warning-soft/40 px-1.5 py-1 text-[11px]">
              The text changed{claim.anchor.mappingStatus === 'needs_revalidation' ? ' in substance; earlier assessments no longer count' : ''}. Before: “{claim.anchor.previousText.slice(0, 200)}”
            </p>
          ) : null}
        </div>
      </header>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {claim.reviewState === 'proposed' ? (
          <Button size="sm" variant="ghost" onClick={() => void act('approve', () => runtime().evidence.updateClaim(claim.id, { reviewState: 'approved' }))}>
            <CheckCheck /> Approve
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void act('exclude', () => runtime().evidence.updateClaim(claim.id, claim.reviewState === 'excluded' ? { reviewState: 'approved' } : { reviewState: 'excluded', exclusionReason: 'Needs no external source' }))}>
          <Ban /> {claim.reviewState === 'excluded' ? 'Include' : 'Needs no source'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit claim">
          <Pencil />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Split claim"
          onClick={() => {
            const parts = window.prompt('Split into parts, separated by |', claim.claimText.replace(/, and /, ' | '))?.split('|').map((p) => p.trim()).filter((p) => p.length > 2);
            if (parts && parts.length > 1) void act('split', () => runtime().evidence.splitClaim(claim.id, parts));
          }}
        >
          <Scissors />
        </Button>
        <Button size="sm" onClick={() => void act('retrieve', () => runtime().evidence.retrieve(claim.id, {}).then(() => setOpen(true)))} disabled={busy === 'retrieve'} data-testid="find-evidence">
          {busy === 'retrieve' ? <Spinner /> : <Search />} Find evidence
        </Button>
        <Button size="sm" onClick={() => void assessAll()} disabled={running || !model} title={model ? undefined : 'Choose a model first'} data-testid="assess-claim">
          {running ? <Spinner /> : <Sparkles />} Assess
        </Button>
        {claim.status === 'needs_revalidation' ? (
          <Button size="sm" onClick={() => void act('revalidate', () => runtime().evidence.revalidate(claim.id, {}))}>
            <RefreshCw /> Check again
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void act('reviewed', () => runtime().evidence.updateClaim(claim.id, { userReviewed: claim.status !== 'user_reviewed' }))}>
          {claim.status === 'user_reviewed' ? 'Unmark reviewed' : 'Mark reviewed'}
        </Button>
      </div>
      {running && job ? (
        <p className="px-2 pb-2 text-[12px] text-ink-muted" role="status">
          {job.progress.message ?? 'Working'} ({job.progress.done}/{job.progress.total})
        </p>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2 border-t border-rule p-2" data-testid="claim-evidence">
          {detail.isLoading ? <Spinner /> : null}
          {detail.data && !ev.length ? <p className="text-[12px] text-ink-muted">No evidence retrieved yet. “Find evidence” searches your library’s full text.</p> : null}
          {supporting.length ? (
            <section aria-label="Supporting literature" className="flex flex-col gap-1.5">
              <h4 className="text-[12px] font-medium">Supporting literature ({supporting.length})</h4>
              {supporting.map((e) => (
                <EvidenceItem key={e.id} e={e} onOpenPdf={openPdf} onAssess={(x) => void assessOne(x)} />
              ))}
            </section>
          ) : null}
          {conflicting.length ? (
            <section aria-label="Possibly conflicting literature" className="flex flex-col gap-1.5">
              <h4 className="text-[12px] font-medium text-danger">Possibly conflicting literature ({conflicting.length})</h4>
              {conflicting.map((e) => (
                <EvidenceItem key={e.id} e={e} onOpenPdf={openPdf} onAssess={(x) => void assessOne(x)} />
              ))}
            </section>
          ) : null}
          {detail.data?.conflicts.filter((c) => c.status === 'current').map((c) => <ConflictView key={c.id} conflict={c} evidence={ev} />)}
          {context.length ? (
            <section aria-label="Context" className="flex flex-col gap-1.5">
              <h4 className="text-[12px] font-medium">Context ({context.length})</h4>
              {context.map((e) => (
                <EvidenceItem key={e.id} e={e} onOpenPdf={openPdf} onAssess={(x) => void assessOne(x)} />
              ))}
            </section>
          ) : null}
          {unassessed.length ? (
            <details>
              <summary className="cursor-pointer text-[12px] font-medium">Other candidates ({unassessed.length})</summary>
              <div className="mt-1 flex flex-col gap-1.5">
                {unassessed.map((e) => (
                  <EvidenceItem key={e.id} e={e} onOpenPdf={openPdf} onAssess={(x) => void assessOne(x)} />
                ))}
              </div>
            </details>
          ) : null}
          {supporting.length ? (
            <div className="flex flex-col gap-1">
              <Button size="sm" className="self-start" onClick={() => void act('recommend', () => runtime().evidence.recommend(claim.id))} data-testid="recommend-citations">
                <Quote /> Recommend citations
              </Button>
              <CitationRecommendations projectId={projectId} claimId={claim.id} recommendations={detail.data?.recommendations ?? []} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
