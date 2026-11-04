import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LibraryItemSummary } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { destroyPdf, loadPdf, type PDFDocumentProxy } from '../pdf/pdfjs';
import { errorText, regionInPoints } from './model';

const VIEW_SCALE = 1.25;
/** The crop is rendered at this scale (about 144 dpi) so small symbols stay legible. */
const CROP_SCALE = 2;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Take a region of a page of a library PDF. The page is drawn unrotated so
 * the region is recorded in the page's own coordinates (PDF points from the
 * top left, as in M3.3); the runtime stores the attachment, its hash, the
 * page and the region with the image.
 */
export function PdfRegionDialog({ open, onClose, onTaken }: { open: boolean; onClose: () => void; onTaken: (assetId: string) => void }) {
  const [q, setQ] = useState('');
  const [item, setItem] = useState<LibraryItemSummary | null>(null);
  const items = useQuery({ queryKey: ['visual', 'pdf-items', q], queryFn: ({ signal }) => runtime().library.items({ q: q || undefined, hasPdf: true, limit: 30 } as never, signal), enabled: open });
  const detail = useQuery({ queryKey: ['library', 'item', item?.id], queryFn: () => runtime().library.item(item!.id), enabled: !!item });
  const pdfs = detail.data?.item.attachments.filter((a) => a.mimeType === 'application/pdf' && a.available) ?? [];
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  useEffect(() => setAttachmentId(pdfs[0]?.id ?? null), [pdfs[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[4vh] flex h-[90vh] w-[min(1000px,calc(100vw-24px))] flex-col" aria-describedby="region-desc" data-testid="pdf-region-dialog">
        <DialogTitle>Take a region from a library PDF</DialogTitle>
        <DialogDescription id="region-desc">Choose a paper, go to the page and drag a box around the equation, figure or plot.</DialogDescription>
        {!attachmentId ? (
          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
            <Input type="search" placeholder="Search papers with a PDF" aria-label="Search papers with a PDF" value={q} onChange={(e) => setQ(e.target.value)} />
            <ul className="min-h-0 flex-1 overflow-auto rounded-md border border-rule">
              {items.isLoading ? <li className="p-3"><Spinner /></li> : null}
              {items.data?.items.map((it) => (
                <li key={it.id}>
                  <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left text-ui hover:bg-sunken" onClick={() => setItem(it)}>
                    <FileText className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                    <span>
                      <span className="block text-ink">{it.title}</span>
                      <span className="text-[12px] text-ink-muted">{[it.authors.slice(0, 3).join(', '), it.year].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                </li>
              ))}
              {items.data && !items.data.items.length ? <li className="p-3 text-ui text-ink-muted">No papers with a PDF in the library.</li> : null}
              {item && detail.data && !pdfs.length ? <li className="p-3 text-ui text-danger">This paper has no readable PDF.</li> : null}
            </ul>
          </div>
        ) : (
          <RegionPicker
            attachmentId={attachmentId}
            onBack={() => {
              setAttachmentId(null);
              setItem(null);
            }}
            onTaken={(id) => {
              onTaken(id);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RegionPicker({ attachmentId, onBack, onTaken }: { attachmentId: string; onBack: () => void; onTaken: (assetId: string) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let loaded: PDFDocumentProxy | null = null;
    let cancelled = false;
    void runtime()
      .library.attachmentContent(attachmentId)
      .then(loadPdf)
      .then((d) => {
        loaded = d;
        if (!cancelled) setDoc(d);
      })
      .catch((e: unknown) => setError(errorText(e)));
    return () => {
      cancelled = true;
      destroyPdf(loaded);
    };
  }, [attachmentId]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    void doc.getPage(page).then((p) => {
      const c = canvas.current;
      if (cancelled || !c) return;
      const base = p.getViewport({ scale: 1, rotation: 0 });
      setSize({ width: base.width, height: base.height });
      const vp = p.getViewport({ scale: VIEW_SCALE * Math.min(window.devicePixelRatio || 1, 2), rotation: 0 });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = p.render({ canvas: c, viewport: vp });
      task.promise.catch(() => undefined);
    });
    setRect(null);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);

  const point = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const take = async () => {
    if (!doc || !rect || !size) return;
    setBusy(true);
    setError(null);
    try {
      const region = regionInPoints(rect, VIEW_SCALE, size);
      if (region.width < 4 || region.height < 4) throw new Error('Drag a larger box');
      const p = await doc.getPage(page);
      const vp = p.getViewport({ scale: CROP_SCALE, rotation: 0 });
      const full = document.createElement('canvas');
      full.width = Math.floor(vp.width);
      full.height = Math.floor(vp.height);
      await p.render({ canvas: full, viewport: vp }).promise;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(region.width * CROP_SCALE));
      out.height = Math.max(1, Math.round(region.height * CROP_SCALE));
      out.getContext('2d')!.drawImage(full, region.x * CROP_SCALE, region.y * CROP_SCALE, out.width, out.height, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the region'))), 'image/png'));
      const r = await runtime().visual.pdfRegion(blob, { attachmentId, pageNumber: page, ...region, renderScale: CROP_SCALE });
      onTaken(r.asset.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = rect ? { left: Math.min(rect.x, rect.x + rect.width), top: Math.min(rect.y, rect.y + rect.height), width: Math.abs(rect.width), height: Math.abs(rect.height) } : null;
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft /> Papers
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft />
          </Button>
          <span className="text-ui tabular-nums" aria-live="polite">
            Page {page} of {doc?.numPages ?? '…'}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={!doc || page >= doc.numPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-rule bg-sunken p-3">
        {!doc && !error ? <Spinner /> : null}
        {size ? (
          <div
            className="relative mx-auto cursor-crosshair touch-none bg-white shadow-page"
            style={{ width: size.width * VIEW_SCALE, height: size.height * VIEW_SCALE }}
            data-testid="region-surface"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = point(e);
              setRect({ ...drag.current, width: 0, height: 0 });
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const p = point(e);
              setRect({ x: drag.current.x, y: drag.current.y, width: p.x - drag.current.x, height: p.y - drag.current.y });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          >
            <canvas ref={canvas} className="block h-full w-full" aria-label={`Page ${page}`} />
            {shown ? <div className="pointer-events-none absolute border-2 border-accent bg-accent/10" style={shown} data-testid="region-box" /> : null}
          </div>
        ) : (
          <canvas ref={canvas} className="hidden" />
        )}
      </div>
      {error ? <p className="text-ui text-danger" role="alert">{error}</p> : null}
      <DialogFooter>
        <Button variant="primary" disabled={!shown || shown.width < 5 || busy} onClick={() => void take()} data-testid="take-region">
          {busy ? <Spinner /> : null} Use this region
        </Button>
      </DialogFooter>
    </div>
  );
}
