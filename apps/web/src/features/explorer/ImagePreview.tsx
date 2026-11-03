import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { extname } from '@research-studio/document-engine';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';

/** Shows an uploaded figure. Images are fetched with the session token and shown via a blob URL in <img>, which never executes scripts (relevant for SVG). */
export function ImagePreview({ projectId, path, onClose }: { projectId: string; path: string | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderable = path ? ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extname(path)) : false;

  useEffect(() => {
    if (!path || !renderable) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    runtime()
      .rawFile(projectId, path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, path, renderable]);

  const snippet = path ? `\\includegraphics[width=\\linewidth]{${path}}` : '';

  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(720px,calc(100vw-32px))]">
        <DialogTitle className="truncate pr-8">{path}</DialogTitle>
        <DialogDescription>Reference it from LaTeX with the command below.</DialogDescription>
        <div className="rs-graph-paper mt-4 grid min-h-48 place-items-center overflow-hidden rounded-md border border-rule p-4">
          {!renderable ? (
            <p className="text-ui text-ink-muted">PDF and EPS figures are shown in the compiled document.</p>
          ) : error ? (
            <p className="text-ui text-danger">{error}</p>
          ) : url ? (
            <img src={url} alt={path ?? ''} className="max-h-[50vh] max-w-full bg-white object-contain shadow-page" />
          ) : (
            <Spinner className="text-ink-faint" />
          )}
        </div>
        <code className="mt-3 block truncate rounded-ctl bg-sunken px-2.5 py-1.5 font-mono text-xs text-ink">{snippet}</code>
        <DialogFooter>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(snippet).then(
                () => toast.success('Copied'),
                () => toast.error('Clipboard is not available'),
              );
            }}
          >
            <Copy /> Copy command
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
