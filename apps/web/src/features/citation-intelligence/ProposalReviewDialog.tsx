import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { acceptProposal, rejectProposal } from '../assistant/actions';
import { SafeDiff } from '../visual/SafeDiff';

export interface BibChangeReview {
  itemIds: string[];
  changeIds: string[];
  path: string;
  baseHash: string | null;
  original: string;
  proposed: string;
}

/**
 * Review one proposed manuscript change (citation, rewrite) as a diff, with
 * the `.bib` change it needs, before anything is written. Accepting applies
 * exactly the reviewed text, and only while the file is unchanged; the
 * change can be reverted from the assistant's history.
 */
export function ProposalReviewDialog({ projectId, proposalId, bib, title, warnings = [], onClose }: { projectId: string; proposalId: string | null; bib?: BibChangeReview | null; title: string; warnings?: string[]; onClose: () => void }) {
  const preview = useQuery({ queryKey: ['evidence', 'proposal', proposalId], queryFn: () => runtime().ai.previewProposal(projectId, proposalId!), enabled: !!proposalId, staleTime: 0, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  const [bibDone, setBibDone] = useState(false);
  const p = preview.data;
  const accept = async () => {
    if (!p) return;
    setBusy(true);
    try {
      if (bib && !bibDone) {
        await runtime().references.applyBib(projectId, { itemIds: bib.itemIds, changeIds: bib.changeIds, baseHash: bib.baseHash, path: bib.path });
        setBibDone(true);
      }
      if (await acceptProposal(projectId, p.proposal)) onClose();
    } catch (err) {
      toast.error('Nothing was changed', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!proposalId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[4vh] flex max-h-[92vh] w-[min(1100px,calc(100vw-24px))] flex-col overflow-hidden" aria-describedby="prop-desc" data-testid="evidence-proposal">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription id="prop-desc">Review the changes. Nothing is written until you accept, and only if the files did not change in the meantime.</DialogDescription>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
          {warnings.map((w, i) => (
            <p key={i} className="rounded-ctl bg-warning-soft/50 px-2 py-1 text-ui">
              {w}
            </p>
          ))}
          {!p ? (
            <Spinner />
          ) : p.stale || p.before === null || p.after === null ? (
            <p className="text-ui text-danger" role="alert">
              {p.proposal.file} changed after this was proposed. Prepare it again.
            </p>
          ) : (
            <div className="flex min-h-[260px] flex-col rounded-md border border-rule">
              <div className="border-b border-rule px-2 py-1 font-mono text-[12px]">{p.proposal.file}</div>
              <div className="min-h-0 flex-1" data-testid="proposal-diff">
                <SafeDiff original={p.before} modified={p.after} path={`ev-prop://${proposalId}/${p.proposal.file}`} sideBySide={false} />
              </div>
            </div>
          )}
          {bib ? (
            <div className="flex min-h-[200px] flex-col rounded-md border border-rule">
              <div className="flex items-center gap-2 border-b border-rule px-2 py-1 font-mono text-[12px]">
                {bib.path} {bibDone ? <Badge tone="success" className="text-ink">applied</Badge> : <Badge className="text-ink">entry to add</Badge>}
              </div>
              <div className="min-h-0 flex-1" data-testid="bib-diff">
                <SafeDiff original={bib.original} modified={bib.proposed} path={`ev-bib://${proposalId}/${bib.path}`} sideBySide={false} />
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              if (p) void rejectProposal(projectId, p.proposal);
              onClose();
            }}
          >
            Reject
          </Button>
          <Button variant="primary" disabled={!p || p.stale || busy} onClick={() => void accept()} data-testid="accept-proposal">
            {busy ? <Spinner /> : null} {bib && !bibDone ? 'Apply both changes' : 'Accept change'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
