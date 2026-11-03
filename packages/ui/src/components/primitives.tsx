import type { HTMLAttributes } from 'react';
import { cn } from '../cn';

/** Keyboard shortcut label, e.g. `Ctrl+S`. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] items-center rounded-[3px] border border-rule bg-sunken px-1 font-mono text-[10.5px] leading-none text-ink-muted',
        className,
      )}
      {...props}
    />
  );
}

const TONES = {
  neutral: 'bg-sunken text-ink-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof TONES }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center gap-1 rounded-[3px] px-1.5 font-mono text-[11px] font-medium tabular-nums',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent', className)}
    />
  );
}

/** Small uppercase section heading used in side panels. */
export function PanelHeading({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-faint',
        className,
      )}
      {...props}
    />
  );
}
