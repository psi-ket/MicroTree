import { Minus, Plus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary } from '../../lib/queries';
import { PdfDocumentView } from '../documents/PdfDocumentView';
import { destroyPdf, loadPdf, type PDFDocumentProxy } from '../pdf/pdfjs';

/**
 * The paper's PDF, read in place. Opening it records when it was opened,
 * nothing else. `initialPage` and `highlights` open it at a source location
 * (a retrieved passage, a section); `aside` adds a side panel and
 * `headerActions` buttons such as "Back to results".
 */
export function PdfViewer({
  itemId,
  attachmentId,
  title,
  onClose,
  initialPage = null,
  highlights = [],
  aside,
  headerActions,
  description = "The paper's PDF. Reading it does not change its reading status.",
}: {
  itemId: string;
  attachmentId: string;
  title: string;
  onClose: () => void;
  initialPage?: number | null;
  highlights?: readonly DocumentCoordinate[];
  aside?: ReactNode;
  headerActions?: ReactNode;
  description?: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);

  useEffect(() => {
    const controller = new AbortController();
    let loaded: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const bytes = await runtime().library.attachmentContent(attachmentId, controller.signal);
        loaded = await loadPdf(bytes);
        if (controller.signal.aborted) destroyPdf(loaded);
        else setDoc(loaded);
        await runtime().library.markOpened(itemId);
        invalidateLibrary();
      } catch (err) {
        if (!controller.signal.aborted) setError(errorMessage(err));
      }
    })();
    return () => {
      controller.abort();
      destroyPdf(loaded);
    };
  }, [attachmentId, itemId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`top-[3vh] flex h-[94vh] flex-col p-0 ${aside ? 'w-[min(1400px,calc(100vw-24px))]' : 'w-[min(1000px,calc(100vw-24px))]'}`} aria-describedby="lib-pdf-desc">
        <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5 pr-12">
          {headerActions}
          <DialogTitle className="min-w-0 flex-1 truncate text-[16px]">{title}</DialogTitle>
          <DialogDescription id="lib-pdf-desc" className="sr-only">
            {description}
          </DialogDescription>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}>
            <Minus />
          </Button>
          <span className="w-10 text-center text-2xs tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}>
            <Plus />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="rs-graph-paper min-h-0 flex-1 overflow-auto py-4" data-pdf-scroller>
            {error ? (
              <p role="alert" className="p-6 text-center text-ui text-danger">
                {error}
              </p>
            ) : !doc ? (
              <div className="grid h-full place-items-center">
                <Spinner className="text-ink-muted" />
              </div>
            ) : (
              <PdfDocumentView doc={doc} scale={scale} initialPage={initialPage} highlights={highlights} />
            )}
          </div>
          {aside ? <aside className="max-h-[40%] shrink-0 overflow-y-auto border-t border-rule bg-panel lg:max-h-none lg:w-[380px] lg:border-l lg:border-t-0">{aside}</aside> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
