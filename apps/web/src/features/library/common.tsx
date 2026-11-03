import { toast } from 'sonner';
import type { MetadataStatus, ReadingStatus } from '@research-studio/shared-types';
import { cn } from '@research-studio/ui';
import { errorMessage, invalidateLibrary } from '../../lib/queries';
import { Tag } from '../literature/common';
import { METADATA_HINT, METADATA_LABEL, STATUS_LABEL } from './model';

/**
 * The reading status as a book spine on the row's edge: empty to read, half
 * filled while reading, filled when read, accent for important. Always paired
 * with the status in words for assistive technology.
 */
/** `decorative`: the status is already named in text next to it. */
export function StatusSpine({ status, className, decorative = false }: { status: ReadingStatus; className?: string; decorative?: boolean }) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': STATUS_LABEL[status], title: STATUS_LABEL[status] })}
      data-status={status}
      className={cn(
        'relative block w-[7px] shrink-0 overflow-hidden rounded-[2px] border',
        status === 'important' ? 'border-accent bg-accent' : status === 'read' ? 'border-ink-muted bg-ink-muted' : 'border-rule-strong bg-transparent',
        className,
      )}
    >
      {status === 'reading' ? <span className="absolute inset-x-0 bottom-0 h-1/2 bg-ink-muted" /> : null}
      {status === 'important' ? <span className="absolute inset-x-[1px] top-[3px] h-[2px] rounded-full bg-accent-ink/80" /> : null}
    </span>
  );
}

const METADATA_DOT: Record<MetadataStatus, 'success' | 'warning' | 'neutral'> = {
  resolved: 'success',
  'needs-review': 'warning',
  unresolved: 'warning',
  manual: 'neutral',
};

export function MetadataTag({ status }: { status: MetadataStatus }) {
  return (
    <Tag dot={METADATA_DOT[status]} title={METADATA_HINT[status]}>
      {METADATA_LABEL[status]}
    </Tag>
  );
}

/** Run a library change; refresh library views afterwards and report failures. Resolves to null on failure. */
export async function change<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn();
    invalidateLibrary();
    return result;
  } catch (err) {
    toast.error(`Could not ${what}`, { description: errorMessage(err) });
    return null;
  }
}

/** Save text as a file in the browser's downloads. */
export function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
