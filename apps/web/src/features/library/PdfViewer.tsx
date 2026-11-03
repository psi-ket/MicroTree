import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary } from '../../lib/queries';
import { destroyPdf, loadPdf, type PDFDocumentProxy, type PDFPageProxy } from '../pdf/pdfjs';

function Page({ doc, pageNumber, scale }: { doc: PDFDocumentProxy; pageNumber: number; scale: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);

  useEffect(() => {
    let cancelled = false;
    void doc.getPage(pageNumber).then((page) => {
      if (!cancelled) setSize(page.getViewport({ scale: 1 }));
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  useEffect(() => {
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    void doc.getPage(pageNumber).then((page) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const viewport = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 3) });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale, visible]);

  const width = (size?.width ?? 612) * scale;
  const height = (size?.height ?? 792) * scale;
  return (
    <div ref={holder} className="mx-auto bg-white shadow-page" style={{ width, height }}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`Page ${pageNumber}`} />
    </div>
  );
}

/** The paper's PDF, read in place. Opening it records when it was opened, nothing else. */
export function PdfViewer({ itemId, attachmentId, title, onClose }: { itemId: string; attachmentId: string; title: string; onClose: () => void }) {
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
      <DialogContent className="top-[3vh] flex h-[94vh] w-[min(1000px,calc(100vw-24px))] flex-col p-0" aria-describedby="lib-pdf-desc">
        <div className="flex items-center gap-2 border-b border-rule px-4 py-2.5 pr-12">
          <DialogTitle className="min-w-0 flex-1 truncate text-[16px]">{title}</DialogTitle>
          <DialogDescription id="lib-pdf-desc" className="sr-only">
            The paper's PDF. Reading it does not change its reading status.
          </DialogDescription>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}>
            <Minus />
          </Button>
          <span className="w-10 text-center text-2xs tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}>
            <Plus />
          </Button>
        </div>
        <div className="rs-graph-paper min-h-0 flex-1 overflow-auto py-4">
          {error ? (
            <p role="alert" className="p-6 text-center text-ui text-danger">
              {error}
            </p>
          ) : !doc ? (
            <div className="grid h-full place-items-center">
              <Spinner className="text-ink-muted" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {Array.from({ length: doc.numPages }, (_, i) => (
                <Page key={i} doc={doc} pageNumber={i + 1} scale={scale} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
