import { ChevronLeft, ClipboardCheck, ListChecks, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { CoverageRatio, CoverageView as CoverageData } from '@research-studio/api-contracts';
import { CLAIM_STATUSES, type ClaimStatus } from '@research-studio/shared-types';
import { Badge, Button, cn, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { ClaimCard, type PdfTarget } from '../claim-analysis/ClaimCard';
import { EvidenceConsentDialog } from '../evidence-review/EvidenceConsentDialog';
import { STATUS_LABEL } from '../evidence-review/labels';
import { ModelPicker, type ModelChoice } from '../evidence-review/ModelPicker';
import { evidenceKeys, privacyRefusal, useClaims, useCoverage, useJob, useLatestReview, useModelFor, withConsent } from '../evidence-review/state';
import { PdfViewer } from '../library/PdfViewer';
import { EvidenceSettingsDialog } from './EvidenceSettingsDialog';

type Coverage = CoverageData;

function RatioView({ r, label }: { r: CoverageRatio; label: string }) {
  return (
    <div className="rounded-md border border-rule bg-raised p-2">
      <div className="text-[12px] text-ink-muted">{label}</div>
      <div className="text-[17px] tabular-nums text-ink">
        {r.numerator} of {r.denominator}
        {r.value !== null ? <span className="ml-1 text-[12px] text-ink-muted">({Math.round(r.value * 100)}%)</span> : null}
      </div>
      <p className="text-[11px] text-ink-muted">{r.definition}</p>
    </div>
  );
}

function CoverageView({ c }: { c: Coverage }) {
  const rows: [string, number][] = [
    ['Claims extracted', c.totalClaims],
    ['Need a source', c.assessable],
    ['Need no external source', c.noEvidenceNeeded],
    ['Excluded by you', c.excluded],
    ['Assessed', c.assessed],
    ['Not yet assessed', c.notYetAssessed],
    ['Supporting evidence found', c.withSupportingEvidence],
    ['Support accepted by you', c.withAcceptedSupport],
    ['Partly supported', c.partiallySupported],
    ['Possible disagreement', c.potentiallyContradicted],
    ['Evidence insufficient', c.insufficientEvidence],
    ['Context only', c.contextualOnly],
    ['Check again (text changed)', c.needsRevalidation],
  ];
  return (
    <section aria-label="Evidence coverage" className="flex flex-col gap-2" data-testid="coverage">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-ui sm:grid-cols-3 lg:grid-cols-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-rule py-0.5">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2 sm:grid-cols-2">
        <RatioView r={c.ratios.acceptedSupportCoverage} label="Accepted supporting evidence" />
        <RatioView r={c.ratios.assessedShare} label="Assessed so far" />
      </div>
      <p className="text-[11px] text-ink-muted">These counts describe the evidence found in your library. They are not a measure of scientific correctness, and there is no overall score.</p>
    </section>
  );
}

/**
 * Evidence Review Mode: the whole manuscript's claims by section, with
 * coverage counts that state their denominators, filters by status, and an
 * editorial review job. Unresolved claims are never hidden.
 */
export function ReviewScreen({ projectId, backLabel, onBack }: { projectId: string; backLabel: string; onBack: () => void }) {
  const claims = useClaims(projectId);
  const coverage = useCoverage(projectId);
  const latest = useLatestReview(projectId);
  const [filter, setFilter] = useState<ClaimStatus | ''>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pdf, setPdf] = useState<PdfTarget | null>(null);
  const settingsModel = useModelFor(projectId, 'review');
  const assessModel = useModelFor(projectId, 'assessment');
  const [reviewModel, setReviewModel] = useState<ModelChoice | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const list = (claims.data?.claims ?? []).filter((c) => !filter || c.status === filter);
  const sections = new Map<string, typeof list>();
  for (const c of list) sections.set(c.anchor.sectionPath || '(no section)', [...(sections.get(c.anchor.sectionPath || '(no section)') ?? []), c]);

  const extractAll = async () => {
    try {
      await runtime().evidence.extract({ projectId, scope: { kind: 'manuscript' }, method: 'heuristic' });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.claims(projectId) });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.coverage(projectId) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const runReview = async () => {
    const model = reviewModel ?? settingsModel;
    await withConsent(
      async (consent) => {
        const r = await runtime().evidence.startReview(projectId, { scope: 'manuscript', introduction: !!model, conclusion: !!model, ...(model ? { model: { ...model, consent } } : {}) });
        if (r.job) setJobId(r.job.id);
      },
      (err) => toast.error(privacyRefusal(err) ?? errorMessage(err)),
    );
  };
  const review = latest.data?.review;
  const result = review?.result as { findingCounts?: Record<string, number>; introduction?: { review: Record<string, { assessment: string; comment: string } | string[]> }; conclusion?: { review: Record<string, { assessment: string; comment: string } | string[]> } } | null | undefined;

  return (
    <main className="flex h-dvh flex-col bg-paper" data-testid="evidence-review">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-ink-muted">
          <ChevronLeft /> {backLabel}
        </Button>
        <h1 className="flex items-center gap-2 font-display text-[19px] leading-none text-ink">
          <ClipboardCheck className="size-[18px] text-accent" aria-hidden /> Evidence review
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" onClick={() => void extractAll()} data-testid="extract-all">
            <ListChecks /> Find claims in the manuscript
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)} aria-label="Evidence settings">
            <Settings2 />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Delete analysis"
            onClick={() => {
              if (window.confirm('Delete all claims, evidence links and reviews of this project? Your library and the manuscript stay as they are.')) void runtime().evidence.deleteAnalysis(projectId).then(() => queryClient.invalidateQueries({ queryKey: evidenceKeys.all }));
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-3">
          {coverage.data ? <CoverageView c={coverage.data.coverage} /> : <Spinner />}
          <section aria-label="Manuscript review" className="flex flex-col gap-2 rounded-md border border-rule bg-panel p-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">Editorial review</h2>
              <div className="min-w-[260px] flex-1">
                <ModelPicker value={reviewModel ?? settingsModel} onChange={setReviewModel} label="Review model" />
              </div>
              <Button size="sm" variant="primary" onClick={() => void runReview()} disabled={!!job && job.status === 'running'} data-testid="run-review">
                {job && (job.status === 'running' || job.status === 'queued') ? <Spinner /> : null} Review manuscript
              </Button>
            </div>
            <p className="text-[11px] text-ink-muted">Without a model: coverage, sections and rule findings. With one: also suggestions on the introduction and conclusion (only those sections are sent).</p>
            {review ? (
              <div className="text-ui" data-testid="review-result">
                <p className="text-[12px] text-ink-muted">
                  {review.status} · {new Date(review.startedAt).toLocaleString()}
                  {review.modelId ? ` · ${review.modelId}` : ''}
                </p>
                {result?.findingCounts ? (
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(result.findingCounts).map(([k, v]) => (
                      <li key={k}>
                        <Badge className="text-ink">
                          {k.replace(/-/g, ' ')}: {v}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {(['introduction', 'conclusion'] as const).map((part) =>
                  result?.[part] ? (
                    <div key={part} className="mt-2">
                      <h3 className="font-medium capitalize">{part}</h3>
                      <ul className="list-disc pl-5 text-[12px]">
                        {Object.entries(result[part]!.review).map(([k, v]) =>
                          Array.isArray(v) ? (
                            v.map((s, i) => <li key={`${k}${i}`}>{s}</li>)
                          ) : (
                            <li key={k}>
                              <span className="font-medium">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}:</span> {v.assessment}. {v.comment}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  ) : null,
                )}
                <p className="mt-1 text-[11px] text-ink-muted">Editorial suggestions, not judgements of correctness.</p>
              </div>
            ) : null}
          </section>
          <section aria-label="Claims by section" className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Claims</h2>
              <Select aria-label="Filter by status" className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value as ClaimStatus | '')} data-testid="status-filter">
                <option value="">All ({claims.data?.claims.length ?? 0})</option>
                {CLAIM_STATUSES.filter((s) => s !== 'analyzing').map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]} ({claims.data?.claims.filter((c) => c.status === s).length ?? 0})
                  </option>
                ))}
              </Select>
            </div>
            {[...sections.entries()].map(([section, cs]) => (
              <div key={section} className="flex flex-col gap-1.5">
                <h3 className={cn('text-[13px] font-medium text-ink-muted')}>{section}</h3>
                {cs.map((c) => (
                  <ClaimCard key={c.id} projectId={projectId} claim={c} model={assessModel} onOpenPdf={setPdf} />
                ))}
              </div>
            ))}
            {claims.data && !list.length ? <p className="text-ui text-ink-muted">No claims{filter ? ' with this status' : ' yet; use “Find claims in the manuscript”'}.</p> : null}
          </section>
        </div>
      </div>
      {pdf ? <PdfViewer itemId={pdf.itemId} attachmentId={pdf.attachmentId} title={pdf.title} initialPage={pdf.page} highlights={pdf.record.source.coordinates} description={pdf.record.source.location} onClose={() => setPdf(null)} /> : null}
      <EvidenceSettingsDialog projectId={projectId} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <EvidenceConsentDialog />
    </main>
  );
}
