import { CircleCheck, CircleX, Clock, Unplug } from 'lucide-react';
import type { CompileJob } from '@research-studio/shared-types';
import { cn } from '@research-studio/ui';
import { useConnection } from '../../lib/connection';
import { useCompile } from '../../stores/compile';
import { isDirty, useEditor } from '../../stores/editor';
import { useLayout } from '../../stores/layout';

function compileSummary(job: CompileJob | undefined): { text: string; tone: string; icon: typeof Clock } {
  if (!job) return { text: 'Not compiled yet', tone: 'text-ink-faint', icon: Clock };
  const seconds = job.durationMs !== null ? ` in ${(job.durationMs / 1000).toFixed(1)} s` : '';
  switch (job.status) {
    case 'queued':
      return { text: 'Queued', tone: 'text-ink-muted', icon: Clock };
    case 'running':
      return { text: 'Compiling…', tone: 'text-accent', icon: Clock };
    case 'succeeded':
      return {
        text: job.warningCount ? `Compiled${seconds} · ${job.warningCount} warning${job.warningCount === 1 ? '' : 's'}` : `Compiled${seconds}`,
        tone: 'text-success',
        icon: CircleCheck,
      };
    case 'failed':
      return {
        text: `${job.errorCount} error${job.errorCount === 1 ? '' : 's'}${job.pdfAvailable ? ' · PDF may be incomplete' : ''}`,
        tone: 'text-danger',
        icon: CircleX,
      };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'text-ink-muted', icon: CircleX };
    case 'error':
      return { text: job.statusMessage ?? 'Compilation could not run', tone: 'text-danger', icon: CircleX };
  }
}

export function StatusBar({ projectId }: { projectId: string }) {
  const socketOpen = useConnection((s) => s.socketOpen);
  const job = useCompile((s) => s.jobs[projectId]);
  const { active, buffers, cursor } = useEditor();
  const buffer = active ? buffers[active] : undefined;
  const { toggle, setBottomTab } = useLayout();
  const summary = compileSummary(job);
  const Icon = summary.icon;

  const saveState = !buffer
    ? null
    : buffer.conflict
      ? { text: buffer.diskState === 'deleted' ? 'Deleted on disk' : 'Changed on disk', tone: 'text-danger' }
      : buffer.saving
        ? { text: 'Saving…', tone: 'text-ink-muted' }
        : buffer.error
          ? { text: 'Not saved', tone: 'text-danger' }
          : isDirty(buffer)
            ? { text: 'Edited', tone: 'text-ink-muted' }
            : { text: 'Saved', tone: 'text-ink-faint' };

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-rule bg-paper px-3 text-2xs text-ink-faint" data-testid="status-bar">
      <button
        type="button"
        className={cn('flex items-center gap-1.5 hover:underline', summary.tone)}
        onClick={() => {
          toggle('diagnostics', true);
          setBottomTab('problems');
        }}
        data-testid="compile-status"
        data-status={job?.status ?? 'none'}
        data-job-id={job?.id ?? ''}
      >
        <Icon className="size-3" />
        {summary.text}
      </button>
      {!socketOpen ? (
        <span className="flex items-center gap-1 text-warning" title="Live updates are reconnecting">
          <Unplug className="size-3" /> Reconnecting
        </span>
      ) : null}
      <span className="ml-auto" />
      {saveState ? (
        <span className={saveState.tone} data-testid="save-state">
          {saveState.text}
        </span>
      ) : null}
      {buffer && cursor ? (
        <span className="font-mono tabular-nums">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      ) : null}
      {buffer ? <span className="uppercase tracking-wider">{buffer.kind}</span> : null}
    </footer>
  );
}
