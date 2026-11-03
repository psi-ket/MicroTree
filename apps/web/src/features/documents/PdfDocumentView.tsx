import { useEffect, useRef, useState } from 'react';
import { toViewportRect, type DocumentCoordinate } from '@research-studio/document-intelligence';
import { Spinner } from '@research-studio/ui';
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf/pdfjs';

interface PageSize {
  width: number;
  height: number;
  rotation: number;
}

/**
 * Highlight boxes for one rendered page. Coordinates are canonical
 * (CropBox-relative, top-left, unrotated); `toViewportRect` applies the
 * page's rotation and the zoom. Nothing is drawn without boxes.
 */
export function highlightRects(coords: readonly DocumentCoordinate[], pageNumber: number, size: PageSize, scale: number) {
  return coords
    .filter((c) => c.pageNumber === pageNumber)
    .map((c) => toViewportRect(c, { width: size.width * scale, height: size.height * scale, rotation: size.rotation }));
}

function Page({ doc, pageNumber, scale, size, highlights, eager }: { doc: PDFDocumentProxy; pageNumber: number; scale: number; size: PageSize; highlights: readonly DocumentCoordinate[]; eager: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(eager);

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

  const rects = highlightRects(highlights, pageNumber, size, scale);
  return (
    <div ref={holder} id={`pdf-page-${pageNumber}`} data-page={pageNumber} className="relative mx-auto bg-white shadow-page" style={{ width: size.width * scale, height: size.height * scale }}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`Page ${pageNumber}`} />
      {rects.map((r, i) => (
        <div
          key={i}
          aria-hidden
          data-testid="pdf-highlight"
          className="pointer-events-none absolute rounded-[2px] bg-warning/30 ring-1 ring-warning/70 mix-blend-multiply"
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        />
      ))}
    </div>
  );
}

/**
 * All pages of a loaded PDF, lazily rendered. With `initialPage` the view
 * scrolls there once page sizes are known; `highlights` are drawn on their
 * pages and the first one is scrolled into view.
 */
export function PdfDocumentView({ doc, scale, initialPage = null, highlights = [] }: { doc: PDFDocumentProxy; scale: number; initialPage?: number | null; highlights?: readonly DocumentCoordinate[] }) {
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: PageSize[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        // Displayed (rotated) size at zoom 1, as toViewportRect expects, and the page's rotation.
        const v = page.getViewport({ scale: 1 });
        out.push({ width: v.width, height: v.height, rotation: v.rotation });
      }
      if (!cancelled) setSizes(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const target = highlights[0]?.pageNumber ?? initialPage;
  useEffect(() => {
    if (!sizes || !target) return;
    const el = container.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (!el) return;
    const size = sizes[target - 1];
    const first = highlights.find((h) => h.pageNumber === target);
    const offset = first && size ? (highlightRects([first], target, size, scale)[0]?.top ?? 0) - 80 : 0;
    const scroller = el.closest('[data-pdf-scroller]') as HTMLElement | null;
    if (scroller) scroller.scrollTop = el.offsetTop + Math.max(0, offset) - 16;
    else el.scrollIntoView?.({ block: 'start' });
  }, [sizes, target, highlights, scale]);

  if (!sizes) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-ink-muted" />
      </div>
    );
  }
  return (
    <div ref={container} className="flex flex-col gap-4">
      {sizes.map((size, i) => (
        <Page
          key={i}
          doc={doc}
          pageNumber={i + 1}
          scale={scale}
          size={{ width: size.width, height: size.height, rotation: size.rotation }}
          highlights={highlights}
          eager={i < 2 || (target !== null && Math.abs(i + 1 - target) <= 1)}
        />
      ))}
    </div>
  );
}
