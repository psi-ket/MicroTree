import { BookOpen, Check, ExternalLink, Sparkles, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { EvidenceRecordView } from '@research-studio/api-contracts';
import { ASSESSMENTS, type Assessment } from '@research-studio/shared-types';
import { Badge, Button, cn, Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { ASSESSMENT_LABEL, ASSESSMENT_TONE } from './labels';
import { evidenceKeys } from './state';

/** Marks the verified excerpt inside the passage (the passage is always shown whole, as extracted). */
function Passage({ text, excerpt }: { text: string; excerpt: string | null }) {
  const at = excerpt ? text.toLowerCase().indexOf(excerpt.toLowerCase()) : -1;
  if (at === -1) return <p className="whitespace-pre-wrap">{text}</p>;
  return (
    <p className="whitespace-pre-wrap">
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-highlight px-0.5 text-ink">{text.slice(at, at + excerpt!.length)}</mark>
      {text.slice(at + excerpt!.length)}
    </p>
  );
}

/**
 * One source passage for a claim: where it is, what it says (exactly), how
 * the model judged it and how the researcher decided, kept apart. Relevance
 * ranks are shown as such, never as support.
 */
export function EvidenceItem({ e, onOpenPdf, onAssess }: { e: EvidenceRecordView; onOpenPdf: (e: EvidenceRecordView) => void; onAssess: (e: EvidenceRecordView) => void }) {
  const [reclass, setReclass] = useState<Assessment | ''>('');
  const s = e.source;
  const a = e.assessment;
  const human = e.reviews[0];
  const decide = async (decision: 'accept' | 'reject' | 'reclassify' | 'exclude_source', reclassifiedAs?: Assessment) => {
    try {
      await runtime().evidence.review(e.id, { decision, ...(reclassifiedAs ? { reclassifiedAs } : {}) });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.claim(e.claimId) });
      void queryClient.invalidateQueries({ queryKey: ['evidence', 'claims'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <article className={cn('flex flex-col gap-1.5 rounded-md border border-rule bg-raised p-2 text-ui', e.status !== 'active' && 'opacity-70')} data-testid="evidence-item">
      <header className="flex flex-wrap items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug text-ink">{s.title}</div>
          <div className="text-[12px] text-ink-muted">
            {[s.authors.slice(0, 3).join(', ') + (s.authors.length > 3 ? ' et al.' : ''), s.year, s.venue].filter(Boolean).join(' · ')}
            {s.doi ? ` · doi:${s.doi}` : ''}
          </div>
          <div className="text-[12px] text-ink-muted">
            {s.location}
            {s.level !== 'full_text' ? <Badge className="ml-1 text-ink">abstract only</Badge> : null}
            {s.publicationType ? <span className="ml-1">· {s.publicationType.replace(/-/g, ' ')}</span> : null}
            {e.samePaperAs ? <span className="ml-1">· another passage of a paper listed above</span> : null}
          </div>
        </div>
        {e.effective ? (
          <Badge className="text-ink" tone={ASSESSMENT_TONE[e.effective]} data-testid="evidence-effective">
            {ASSESSMENT_LABEL[e.effective]}
          </Badge>
        ) : (
          <Badge className="text-ink">not assessed</Badge>
        )}
      </header>
      <blockquote className="border-l-2 border-rule-strong pl-2 text-[13px] text-ink" data-testid="evidence-passage">
        <Passage text={s.text} excerpt={a?.excerptVerified ? a.supportingText : null} />
      </blockquote>
      {a ? (
        <div className="flex flex-col gap-1 text-[12px]">
          <p>
            <span className="font-medium">Model ({a.modelId}):</span> {ASSESSMENT_LABEL[a.assessment]}. {a.explanation}
          </p>
          {a.unsupportedSubclaims.length ? <p>Not supported: {a.unsupportedSubclaims.join('; ')}</p> : null}
          {a.limitations.length ? (
            <ul className="list-disc pl-4 text-ink-muted" aria-label="Limitations">
              {a.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : null}
          {a.validationNotes.length ? <p className="text-warning">{a.validationNotes.join(' ')}</p> : null}
          <p className="text-ink-muted">
            Uncertainty: {a.uncertainty} · {a.excerptVerified ? 'quoted text found in the passage' : 'no verified quotation'}
            {e.history.length ? ` · ${e.history.length} earlier assessment${e.history.length === 1 ? '' : 's'} kept` : ''}
          </p>
        </div>
      ) : null}
      {human ? (
        <p className="text-[12px]">
          <span className="font-medium">Your decision:</span> {human.decision === 'reclassify' && human.reclassifiedAs ? `reclassified as “${ASSESSMENT_LABEL[human.reclassifiedAs]}”` : human.decision.replace('_', ' ')}
          {human.note ? `, ${human.note}` : ''}
        </p>
      ) : null}
      <p className="text-[11px] text-ink-muted">
        Relevance rank {e.relevanceRank ?? 'n/a'} ({e.retrievalMethod}){e.keywordRank ? ` · keyword #${e.keywordRank}` : ''}
        {e.semanticRank ? ` · semantic #${e.semanticRank}` : ''}. Relevance is not support.
      </p>
      <footer className="flex flex-wrap items-center gap-1">
        {s.attachmentId && s.libraryItemId ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenPdf(e)} data-testid="open-source-pdf">
            <BookOpen /> Open in PDF
          </Button>
        ) : s.url ? (
          <a className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline" href={s.url} target="_blank" rel="noreferrer noopener">
            <ExternalLink className="size-3.5" aria-hidden /> Source
          </a>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onAssess(e)}>
          <Sparkles /> {a ? 'Assess again' : 'Assess'}
        </Button>
        {a ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void decide('accept')} aria-label="Accept assessment">
              <Check /> Accept
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void decide('reject')} aria-label="Reject assessment">
              <X /> Reject
            </Button>
          </>
        ) : null}
        <Select aria-label="Reclassify" className="h-6 w-auto text-[12px]" value={reclass} onChange={(ev) => setReclass(ev.target.value as Assessment)}>
          <option value="">Reclassify…</option>
          {ASSESSMENTS.filter((x) => x !== 'not_assessed').map((x) => (
            <option key={x} value={x}>
              {ASSESSMENT_LABEL[x]}
            </option>
          ))}
        </Select>
        {reclass ? (
          <Button size="sm" onClick={() => void decide('reclassify', reclass).then(() => setReclass(''))}>
            Apply
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void decide('exclude_source')} aria-label="Exclude source">
          <Undo2 /> Exclude
        </Button>
      </footer>
    </article>
  );
}
