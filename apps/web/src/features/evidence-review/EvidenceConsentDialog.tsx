import { CloudUpload } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@research-studio/ui';
import { errorMessage } from '../../lib/queries';
import { useEvidenceConsent } from './state';

/**
 * Consent for one operation that sends manuscript text (and source
 * passages) to a model outside this computer: provider, model, how much text
 * and a preview of what is sent. Nothing is sent until confirmed.
 */
export function EvidenceConsentDialog() {
  const { pending, clear } = useEvidenceConsent();
  const r = pending?.request;
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && clear()}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))]" aria-describedby="ev-consent-desc" data-testid="evidence-consent">
        <DialogTitle className="flex items-center gap-2">
          <CloudUpload className="size-4 text-warning" aria-hidden /> Send to {r?.provider}?
        </DialogTitle>
        <DialogDescription id="ev-consent-desc">{r?.message}</DialogDescription>
        {r ? (
          <div className="mt-3 flex flex-col gap-3 text-ui">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-ink-muted">Model</dt>
              <dd className="font-mono text-[12px]">{r.model}</dd>
              <dt className="text-ink-muted">Manuscript text</dt>
              <dd>{r.outgoing.manuscriptChars.toLocaleString()} characters</dd>
              <dt className="text-ink-muted">Source passages</dt>
              <dd>
                {r.outgoing.passages} ({r.outgoing.sourceChars.toLocaleString()} characters)
              </dd>
              <dt className="text-ink-muted">Requests</dt>
              <dd>{r.outgoing.requests}</dd>
            </dl>
            {r.outgoing.preview.claims.length ? (
              <section>
                <h3 className="mb-1 text-[12px] font-medium text-ink-muted">Manuscript text sent (start)</h3>
                <ul className="flex flex-col gap-1">
                  {r.outgoing.preview.claims.map((c, i) => (
                    <li key={i} className="rounded-ctl bg-sunken/60 px-2 py-1 text-[12px]">
                      {c}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {r.outgoing.preview.passages.length ? (
              <section>
                <h3 className="mb-1 text-[12px] font-medium text-ink-muted">Passages sent (start)</h3>
                <ul className="flex flex-col gap-1">
                  {r.outgoing.preview.passages.map((p, i) => (
                    <li key={i} className="rounded-ctl bg-sunken/60 px-2 py-1 text-[12px]">
                      <span className="font-medium">{p.title}</span>: {p.excerpt}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <p className="text-[12px] text-ink-muted">This consent covers this operation only; it is recorded with the job. Local models never need it.</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={clear}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="evidence-consent-confirm"
            onClick={() => {
              const p = pending;
              clear();
              if (p) void p.proceed().catch((e: unknown) => toast.error(errorMessage(e)));
            }}
          >
            Send for this operation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
