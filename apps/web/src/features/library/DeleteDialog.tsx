import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { change } from './common';

/**
 * Deleting papers says first what goes with them: stored PDFs, links to
 * projects (whose .bib files are not touched) and Zotero links (Zotero keeps its items).
 */
export function DeleteDialog({ itemIds, open, onClose, onDeleted }: { itemIds: string[]; open: boolean; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const impact = useQuery({
    queryKey: ['library', 'deletion-impact', itemIds],
    queryFn: () => runtime().library.deletionImpact(itemIds),
    enabled: open && itemIds.length > 0,
    staleTime: 0,
    gcTime: 0,
  });
  const n = itemIds.length;
  const papers = n === 1 ? 'this paper' : `${n} papers`;

  const confirm = async () => {
    setBusy(true);
    const res = await change('delete the papers', () => runtime().library.deleteItems(itemIds));
    setBusy(false);
    if (res) {
      toast.success(res.deleted === 1 ? 'Paper deleted' : `${res.deleted} papers deleted`);
      onDeleted();
      onClose();
    }
  };

  const data = impact.data;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))]" aria-describedby="lib-delete-desc">
        <DialogTitle>Delete {papers}?</DialogTitle>
        <DialogDescription id="lib-delete-desc">This removes {papers} from your library. It cannot be undone.</DialogDescription>
        <div className="mt-3 text-ui">
          {impact.isLoading ? (
            <Spinner className="text-ink-muted" />
          ) : impact.error ? (
            <p className="text-danger">{errorMessage(impact.error)}</p>
          ) : data ? (
            <ul className="space-y-2">
              {data.attachments ? (
                <li>
                  {data.attachments === 1 ? 'One attached file is' : `${data.attachments} attached files are`} deleted too, unless another paper uses the same file.
                </li>
              ) : null}
              {data.projects.length ? (
                <li>
                  <span className="font-medium text-ink">Used by {data.projects.length === 1 ? 'a project' : `${data.projects.length} projects`}:</span>{' '}
                  {data.projects.map((p) => p.name).join(', ')}. Their .bib files stay as they are, but citations of these papers will no longer be linked to the library.
                </li>
              ) : null}
              {data.externalLinks ? <li>{data.externalLinks === 1 ? 'One paper is' : `${data.externalLinks} papers are`} linked to Zotero. Zotero keeps its copy.</li> : null}
              {!data.attachments && !data.projects.length && !data.externalLinks ? <li className="text-ink-muted">No files, projects or Zotero items are affected.</li> : null}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy || !data} data-testid="confirm-delete">
            {busy ? <Spinner /> : null}
            Delete {n === 1 ? 'paper' : `${n} papers`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
