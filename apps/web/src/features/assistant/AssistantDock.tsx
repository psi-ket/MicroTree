import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@research-studio/ui';
import { ASSISTANT_SHARE, useLayout } from '../../stores/layout';
import { AssistantPanel } from './AssistantPanel';

/** The overlay never gets smaller than this, nor leaves less than CODE_RESERVE of code above it. */
const MIN_HEIGHT = 140;
const CODE_RESERVE = 72;

/**
 * Places the one assistant instance inside the editor pane: over the bottom of
 * the code (overlay) or filling the pane while its tab is in front (tab). It
 * stays mounted while a file tab is in front, so a draft and a streaming answer
 * survive switching tabs and docks.
 */
export function AssistantDock({ projectId }: { projectId: string }) {
  const { assistantDock: dock, assistantFront: front, assistantCollapsed: collapsed, assistantShare: share, setAssistantShare, setAssistantOverlayPx } = useLayout();
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const overlay = dock === 'overlay';

  // Report the height the overlay really has, so the editor can leave room below the last line.
  useEffect(() => {
    const el = frame.current;
    if (!el || !overlay) return setAssistantOverlayPx(0);
    const observer = new ResizeObserver(() => setAssistantOverlayPx(Math.round(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => {
      observer.disconnect();
      setAssistantOverlayPx(0);
    };
  }, [overlay, setAssistantOverlayPx]);

  const paneHeight = () => frame.current?.parentElement?.clientHeight || 1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: frame.current?.offsetHeight ?? 0 };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setAssistantShare((drag.current.startHeight + drag.current.startY - e.clientY) / paneHeight());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.15 : 0.05;
    if (e.key === 'ArrowUp') setAssistantShare(share + step);
    else if (e.key === 'ArrowDown') setAssistantShare(share - step);
    else if (e.key === 'Home') setAssistantShare(ASSISTANT_SHARE.max);
    else if (e.key === 'End') setAssistantShare(ASSISTANT_SHARE.min);
    else return;
    e.preventDefault();
  };

  const percent = Math.round(share * 100);
  return (
    <div
      ref={frame}
      data-testid="assistant-dock"
      data-dock={dock}
      className={cn(
        'absolute z-20 flex flex-col',
        overlay ? 'inset-x-0 bottom-0 border-t border-rule-strong shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]' : 'inset-0',
        !overlay && !front && 'hidden',
      )}
      style={overlay && !collapsed ? { height: `${percent}%`, minHeight: MIN_HEIGHT, maxHeight: `calc(100% - ${CODE_RESERVE}px)` } : undefined}
    >
      {overlay && !collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize assistant"
          aria-valuenow={percent}
          aria-valuemin={ASSISTANT_SHARE.min * 100}
          aria-valuemax={ASSISTANT_SHARE.max * 100}
          aria-valuetext={`${percent}% of the editor`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={onKeyDown}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none after:absolute after:inset-x-0 after:top-1 after:h-px after:bg-transparent hover:after:bg-accent focus-visible:after:h-0.5 focus-visible:after:bg-accent"
        />
      ) : null}
      <AssistantPanel projectId={projectId} dock={dock} collapsed={overlay && collapsed} />
    </div>
  );
}
