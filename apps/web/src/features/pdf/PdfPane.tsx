import { Crosshair, Download, Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RuntimeApiError } from '@research-studio/api-contracts';
import type { PdfRect } from '@research-studio/shared-types';
import { Button, Spinner, Tooltip } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { isStaleAssetError, STALE_ASSET_MESSAGE } from '../../lib/stale-assets';
import { isActive, useCompile } from '../../stores/compile';
import { compileProject, forwardSearch, inverseSearch, onForwardSearch } from '../workspace/actions';
import { destroyPdf, loadPdf, type PDFDocumentProxy, type PDFPageProxy } from './pdfjs';

const PAGE_GAP = 16;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

type Zoom = { mode: 'fit' } | { mode: 'fixed'; scale: number };

interface Mark extends PdfRect {
  nonce: number;
}

function PageView({
  doc,
  index,
  size,
  scale,
  marks,
  onInverse,
}: {
  doc: PDFDocumentProxy;
  index: number;
  size: { width: number; height: number };
  scale: number;
  marks: Mark[];
  onInverse: (page: number, x: number, y: number) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const pageNumber = index + 1;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: '600px 0px',
    });
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
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: scale * dpr });
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.floor(viewport.width);
      offscreen.height = Math.floor(viewport.height);
      task = page.render({ canvas: offscreen, viewport });
      task.promise
        .then(() => {
          if (cancelled) return;
          // Swap in one step so the previous rendering stays visible while re-rendering.
          canvas.width = offscreen.width;
          canvas.height = offscreen.height;
          canvas.getContext('2d')?.drawImage(offscreen, 0, 0);
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale, visible]);

  const width = size.width * scale;
  const height = size.height * scale;
  return (
    <div
      ref={holder}
      data-page={pageNumber}
      className="relative mx-auto bg-white shadow-page"
      style={{ width, height }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onInverse(pageNumber, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
      }}
      title="Double-click to jump to the source"
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`Page ${pageNumber}`} />
      {marks.map((m, i) => (
        <span
          key={`${m.nonce}-${i}`}
          className="rs-proof-mark"
          style={{
            left: m.x * scale - 2,
            top: m.y * scale - 2,
            width: Math.max(m.width * scale, 24) + 4,
            height: Math.max(m.height * scale, 10) + 4,
            ['--rs-margin-offset' as string]: `${-(m.x * scale) + 10}px`,
          }}
        />
      ))}
    </div>
  );
}

export function PdfPane({ projectId }: { projectId: string }) {
  const pdfJob = useCompile((s) => s.pdfJob[projectId]);
  const job = useCompile((s) => s.jobs[projectId]);
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' });
  const [containerWidth, setContainerWidth] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const scrollRatio = useRef(0);

  // (Re)load the PDF whenever a job produced a new one.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    if (!pdfJob) {
      setState('empty');
      return;
    }
    const el = scroller.current;
    if (el && el.scrollHeight > 0) scrollRatio.current = el.scrollTop / el.scrollHeight;
    (async () => {
      try {
        const data = await runtime().pdf(projectId);
        loaded = await loadPdf(data);
        const nextSizes: { width: number; height: number }[] = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const vp = (await loaded.getPage(i)).getViewport({ scale: 1 });
          nextSizes.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) return destroyPdf(loaded);
        setDoc(loaded); // the previous document is destroyed by the effect cleanup below
        setSizes(nextSizes);
        setState('ready');
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RuntimeApiError && err.status === 404) setState('empty');
        else {
          setState('error');
          const message = errorMessage(err);
          setError(isStaleAssetError(message) ? STALE_ASSET_MESSAGE : message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, pdfJob]);

  useEffect(() => () => destroyPdf(doc), [doc]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxWidth = sizes.reduce((m, s) => Math.max(m, s.width), 0) || 612;
  const fitScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (containerWidth - 40) / maxWidth));
  const scale = zoom.mode === 'fit' ? fitScale : zoom.scale;

  // Restore the reading position after a reload.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && scrollRatio.current > 0) {
      el.scrollTop = scrollRatio.current * el.scrollHeight;
      scrollRatio.current = 0;
    }
  }, [doc]);

  const pageTop = useCallback(
    (page: number) => sizes.slice(0, page - 1).reduce((sum, s) => sum + s.height * scale + PAGE_GAP, PAGE_GAP),
    [sizes, scale],
  );

  // SyncTeX forward search: scroll to and mark the location.
  useEffect(
    () =>
      onForwardSearch((rects) => {
        const nonce = Date.now();
        const seen = new Set<string>();
        const unique = rects.filter((r) => {
          const key = `${r.page}:${r.x}:${r.y}:${r.width}:${r.height}`;
          return seen.has(key) ? false : (seen.add(key), true);
        });
        setMarks(unique.map((r) => ({ ...r, nonce })));
        const first = rects[0];
        const el = scroller.current;
        if (first && el) {
          el.scrollTo({ top: pageTop(first.page) + first.y * scale - el.clientHeight / 3, behavior: 'smooth' });
        }
      }),
    [pageTop, scale],
  );

  useEffect(() => {
    if (marks.length === 0) return;
    const t = setTimeout(() => setMarks([]), 2700);
    return () => clearTimeout(t);
  }, [marks]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (let i = 1; i <= sizes.length; i++) if (pageTop(i) <= middle) page = i;
    setCurrentPage(page);
  };

  const zoomBy = (factor: number) =>
    setZoom({ mode: 'fixed', scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(scale * factor * 100) / 100)) });

  const download = async () => {
    try {
      const data = await runtime().pdf(projectId);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'output.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const busy = isActive(job);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-rule bg-paper px-2">
        <span className="px-1 font-mono text-xs tabular-nums text-ink-muted" data-testid="pdf-pages">
          {state === 'ready' ? `${currentPage} / ${sizes.length}` : '—'}
        </span>
        <div className="mx-1 h-4 w-px bg-rule" />
        <Tooltip content="Zoom out">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.15)} disabled={state !== 'ready'}>
            <Minus />
          </Button>
        </Tooltip>
        <button
          type="button"
          className="w-12 rounded py-0.5 text-center font-mono text-xs tabular-nums text-ink-muted hover:bg-sunken"
          onClick={() => setZoom({ mode: 'fixed', scale: 1 })}
          title="Reset to 100%"
        >
          {Math.round(scale * 100)}%
        </button>
        <Tooltip content="Zoom in">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(1.15)} disabled={state !== 'ready'}>
            <Plus />
          </Button>
        </Tooltip>
        <Tooltip content="Fit width">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fit width"
            aria-pressed={zoom.mode === 'fit'}
            className={zoom.mode === 'fit' ? 'text-accent' : ''}
            onClick={() => setZoom({ mode: 'fit' })}
          >
            <Maximize2 />
          </Button>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Show cursor position in PDF" shortcut="Ctrl Alt J">
            <Button variant="ghost" size="icon-sm" aria-label="Show cursor position in PDF" onClick={() => void forwardSearch()} disabled={state !== 'ready'}>
              <Crosshair />
            </Button>
          </Tooltip>
          <Tooltip content="Download PDF">
            <Button variant="ghost" size="icon-sm" aria-label="Download PDF" onClick={() => void download()} disabled={state !== 'ready'}>
              <Download />
            </Button>
          </Tooltip>
        </div>
        {busy ? <div className="rs-progress absolute inset-x-0 -bottom-px h-[2px] overflow-hidden" aria-hidden /> : null}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="rs-graph-paper relative min-h-0 flex-1 overflow-auto"
        data-testid="pdf-viewer"
        data-state={state}
      >
        {state === 'ready' && doc ? (
          <div className="flex flex-col py-4" style={{ gap: PAGE_GAP }}>
            {sizes.map((size, i) => (
              <PageView
                key={i}
                doc={doc}
                index={i}
                size={size}
                scale={scale}
                marks={marks.filter((m) => m.page === i + 1)}
                onInverse={(page, x, y) => void inverseSearch(page, x, y)}
              />
            ))}
          </div>
        ) : (
          <div className="grid h-full place-items-center p-6">
            {state === 'loading' ? (
              <Spinner className="text-ink-faint" />
            ) : (
              <div className="max-w-xs rounded-lg border border-rule bg-panel/90 p-5 text-center shadow-float backdrop-blur-sm">
                <p className="font-display text-[20px] italic text-ink">
                  {state === 'empty' ? 'Nothing typeset yet' : 'The PDF could not be shown'}
                </p>
                <p className="mt-1.5 text-ui text-ink-muted">
                  {state === 'empty' ? 'Compile the project to see the document here.' : error}
                </p>
                {error === STALE_ASSET_MESSAGE ? (
                  <Button className="mt-4" variant="primary" size="sm" onClick={() => window.location.reload()}>
                    Reload page
                  </Button>
                ) : (
                  <Button className="mt-4" variant="primary" size="sm" onClick={() => void compileProject()} disabled={busy}>
                    {busy ? <Spinner /> : null}
                    {busy ? 'Compiling…' : 'Compile'}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
