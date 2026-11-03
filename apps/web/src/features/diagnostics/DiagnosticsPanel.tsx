import { AlertTriangle, ChevronDown, CircleX, Info } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Diagnostic, DiagnosticSeverity } from '@research-studio/shared-types';
import { Badge, Button, cn } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { isActive, useCompile } from '../../stores/compile';
import { useLayout } from '../../stores/layout';
import { openFile } from '../workspace/actions';

const ICON: Record<DiagnosticSeverity, typeof CircleX> = { error: CircleX, warning: AlertTriangle, info: Info };
const TONE: Record<DiagnosticSeverity, string> = { error: 'text-danger', warning: 'text-warning', info: 'text-ink-faint' };

function Row({ d }: { d: Diagnostic }) {
  const Icon = ICON[d.severity];
  const location = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : d.source;
  return (
    <li>
      <button
        type="button"
        disabled={!d.file}
        onClick={() => d.file && void openFile(d.file, { line: d.line ?? 1 })}
        className="group flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-sunken/70 focus-visible:bg-sunken disabled:cursor-default"
        data-testid="diagnostic"
        data-severity={d.severity}
      >
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', TONE[d.severity])} />
        <span className="min-w-0 flex-1">
          <span className="text-ui text-ink">{d.message}</span>
          {d.context ? <span className="ml-2 font-mono text-2xs text-ink-faint">{d.context}</span> : null}
        </span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint group-hover:text-accent">{location}</span>
      </button>
    </li>
  );
}

function LogView({ projectId }: { projectId: string }) {
  const job = useCompile((s) => s.jobs[projectId]);
  const output = useCompile((s) => s.output[projectId]);
  const setOutput = useCompile((s) => s.setOutput);
  const pre = useRef<HTMLPreElement>(null);

  // Finished jobs: fetch the stored output (the stream may have been missed).
  useEffect(() => {
    if (!job || isActive(job) || output) return;
    let cancelled = false;
    void runtime()
      .getJob(projectId, job.id)
      .then((detail) => !cancelled && setOutput(projectId, detail.output ?? ''))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job, output, projectId, setOutput]);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output]);

  return (
    <pre
      ref={pre}
      className="h-full overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink-muted"
      data-testid="compile-log"
    >
      {output || (job ? 'No output recorded.' : 'Compile the project to see the latexmk output.')}
    </pre>
  );
}

export function DiagnosticsPanel({ projectId }: { projectId: string }) {
  const job = useCompile((s) => s.jobs[projectId]);
  const { bottomTab, setBottomTab, toggle } = useLayout();
  const [hidden, setHidden] = useState<Set<DiagnosticSeverity>>(new Set(['info']));
  const diagnostics = useMemo(() => job?.diagnostics ?? [], [job]);
  const counts = useMemo(
    () => ({
      error: diagnostics.filter((d) => d.severity === 'error').length,
      warning: diagnostics.filter((d) => d.severity === 'warning').length,
      info: diagnostics.filter((d) => d.severity === 'info').length,
    }),
    [diagnostics],
  );
  const visible = diagnostics.filter((d) => !hidden.has(d.severity));

  const toggleSeverity = (s: DiagnosticSeverity) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const tab = (id: typeof bottomTab, label: string, extra?: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={bottomTab === id}
      onClick={() => setBottomTab(id)}
      className={cn(
        'relative flex h-full items-center gap-1.5 px-2 text-2xs font-semibold uppercase tracking-[0.08em]',
        bottomTab === id ? 'text-ink' : 'text-ink-faint hover:text-ink-muted',
      )}
    >
      {label}
      {extra}
      {bottomTab === id ? <span className="absolute inset-x-2 bottom-0 h-[2px] bg-accent" /> : null}
    </button>
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Compilation diagnostics">
      <div className="flex h-8 shrink-0 items-center border-b border-rule px-1" role="tablist">
        {tab('problems', 'Problems', counts.error + counts.warning > 0 ? <Badge tone={counts.error ? 'danger' : 'warning'}>{counts.error + counts.warning}</Badge> : null)}
        {tab('log', 'Raw log')}
        {bottomTab === 'problems' ? (
          <div className="ml-3 flex items-center gap-1">
            {(['error', 'warning', 'info'] as const).map((s) => {
              const Icon = ICON[s];
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={!hidden.has(s)}
                  onClick={() => toggleSeverity(s)}
                  className={cn(
                    'flex h-5 items-center gap-1 rounded px-1.5 font-mono text-2xs tabular-nums',
                    hidden.has(s) ? 'text-ink-faint opacity-60' : 'bg-sunken text-ink-muted',
                  )}
                  title={`${hidden.has(s) ? 'Show' : 'Hide'} ${s}s`}
                >
                  <Icon className={cn('size-3', TONE[s])} />
                  {counts[s]}
                </button>
              );
            })}
          </div>
        ) : null}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Hide panel" onClick={() => toggle('diagnostics', false)}>
          <ChevronDown />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {bottomTab === 'log' ? (
          <LogView projectId={projectId} />
        ) : !job ? (
          <p className="px-3 py-3 text-ui text-ink-faint">Compile the project to check it for problems.</p>
        ) : isActive(job) ? (
          <p className="px-3 py-3 text-ui text-ink-faint">Compiling… problems appear when the run finishes.</p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-3 text-ui text-ink-faint" data-testid="no-problems">
            {diagnostics.length === 0 ? 'No problems found in the last compilation.' : 'All problems are hidden by the filters.'}
          </p>
        ) : (
          <ul className="py-1">
            {visible.map((d, i) => (
              <Row key={i} d={d} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
