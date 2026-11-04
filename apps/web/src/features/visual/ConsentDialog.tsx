import { CloudUpload } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@research-studio/ui';
import { formatBytes, type ConsentRequest } from './model';

/**
 * Explicit consent for one task that leaves this computer: which provider and
 * model, what is sent and roughly how large it is. Nothing is sent until the
 * user confirms; the confirmation is recorded on the task.
 */
export function ConsentDialog({ request, onConfirm, onCancel }: { request: ConsentRequest | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))]" aria-describedby="consent-desc" data-testid="consent-dialog">
        <DialogTitle className="flex items-center gap-2">
          <CloudUpload className="size-4 text-warning" aria-hidden /> Send to {request?.provider}?
        </DialogTitle>
        <DialogDescription id="consent-desc">{request?.message}</DialogDescription>
        {request ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
            <dt className="text-ink-muted">Provider</dt>
            <dd>{request.provider}</dd>
            <dt className="text-ink-muted">Model</dt>
            <dd className="font-mono text-[12px]">{request.model}</dd>
            <dt className="text-ink-muted">Sent</dt>
            <dd>{request.imageBytes !== null ? `The image (${formatBytes(request.imageBytes)}${request.imageSize ? `, ${request.imageSize} px` : ''}) and the task instructions` : 'Your text and the current source'}</dd>
            {request.estimatedImageTokens !== null ? (
              <>
                <dt className="text-ink-muted">Approx. cost</dt>
                <dd>About {request.estimatedImageTokens.toLocaleString()} input tokens for the image, plus the answer. The provider bills you directly.</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <p className="mt-3 text-[12px] text-ink-muted">This consent applies to this task only. Local models (Ollama on this computer) never need it.</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="consent-confirm">
            Send for this task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
