import { FileInput, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { CitationRecommendationView } from '@research-studio/api-contracts';
import { CITE_COMMANDS, type CiteCommand } from '@research-studio/shared-types';
import { Badge, Button, Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, queryClient } from '../../lib/queries';
import { evidenceKeys } from '../evidence-review/state';
import { ASSESSMENT_LABEL } from '../evidence-review/labels';
import { ProposalReviewDialog, type BibChangeReview } from './ProposalReviewDialog';

type Rec = CitationRecommendationView;

/**
 * Citations recommended from evidence judged to support the claim. Each
 * shows the passage it rests on; inserting prepares a reviewed edit (and a
 * reviewed `.bib` change when the entry is missing).
 */
export function CitationRecommendations({ projectId, claimId, recommendations }: { projectId: string; claimId: string; recommendations: Rec[] }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [placement, setPlacement] = useState<'sentence-end' | 'clause-end'>('sentence-end');
  const [command, setCommand] = useState<CiteCommand | ''>('');
  const [review, setReview] = useState<{ proposalId: string; bib: BibChangeReview | null; warnings: string[]; title: string } | null>(null);
  const open = recommendations.filter((r) => r.status === 'proposed' || r.status === 'accepted');
  const insert = async (ids: string[]) => {
    try {
      const r = await runtime().evidence.insertCitations(claimId, { recommendationIds: ids, placement, ...(command ? { command } : {}) });
      setReview({ proposalId: r.proposalId, bib: r.bib, warnings: r.warnings, title: `Insert \\${r.command}{${r.keys.join(',')}} in ${r.edit.file}, line ${r.edit.line}` });
      void queryClient.invalidateQueries({ queryKey: evidenceKeys.claim(claimId) });
    } catch (err) {
      toast.error('The citation was not prepared', { description: errorMessage(err) });
    }
  };
  const reject = async (id: string) => {
    await runtime().evidence.setRecommendationStatus(id, 'rejected');
    void queryClient.invalidateQueries({ queryKey: evidenceKeys.claim(claimId) });
  };
  if (!recommendations.length) return null;
  return (
    <section aria-label="Citation recommendations" className="flex flex-col gap-1.5" data-testid="citation-recommendations">
      {recommendations.map((r) => (
        <div key={r.id} className="rounded-md border border-rule bg-raised p-2 text-ui">
          <div className="flex items-start gap-1.5">
            <input type="checkbox" className="mt-1" aria-label={`Choose ${r.citationKey}`} checked={chosen.includes(r.id)} disabled={r.status === 'rejected' || r.status === 'inserted'} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))} />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12px]">\cite{`{${r.citationKey}}`}</div>
              <div className="text-[12px]">
                {r.paper.title} ({r.paper.year ?? 'n.d.'}){r.paper.doi ? ` · doi:${r.paper.doi}` : ''}
              </div>
              <div className="text-[12px] text-ink-muted">{r.reason}</div>
              {r.passage ? <blockquote className="mt-1 border-l-2 border-rule-strong pl-2 text-[12px]">{r.passage.text}</blockquote> : null}
            </div>
            <div className="flex flex-col items-end gap-1">
              {r.assessment ? <Badge className="text-ink">{ASSESSMENT_LABEL[r.assessment]}</Badge> : null}
              <Badge className="text-ink">{r.status}</Badge>
              {r.keySource === 'library' ? <span className="text-[11px] text-ink-muted">.bib entry to add</span> : null}
            </div>
          </div>
          {r.status === 'proposed' ? (
            <div className="mt-1 flex gap-1">
              <Button size="sm" onClick={() => void insert([r.id])} data-testid="insert-citation">
                <FileInput /> Insert…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void reject(r.id)}>
                <X /> Reject
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {open.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <Select aria-label="Placement" className="h-6 w-auto" value={placement} onChange={(e) => setPlacement(e.target.value as typeof placement)}>
            <option value="sentence-end">End of sentence</option>
            <option value="clause-end">End of the claim’s clause</option>
          </Select>
          <Select aria-label="Citation command" className="h-6 w-auto" value={command} onChange={(e) => setCommand(e.target.value as CiteCommand)}>
            <option value="">Project default command</option>
            {CITE_COMMANDS.map((c) => (
              <option key={c} value={c}>
                \{c}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={chosen.length < 1} onClick={() => void insert(chosen)}>
            Insert selected together
          </Button>
          <span className="text-ink-muted">More references do not mean stronger support.</span>
        </div>
      ) : null}
      {review ? <ProposalReviewDialog projectId={projectId} proposalId={review.proposalId} bib={review.bib} warnings={review.warnings} title={review.title} onClose={() => setReview(null)} /> : null}
    </section>
  );
}
