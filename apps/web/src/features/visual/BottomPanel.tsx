import { GitCompare, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ArtifactVersion, VisualArtifact } from '@research-studio/api-contracts';
import { Badge, Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { COMPILE_TEXT, errorText, ORIGIN_TEXT } from './model';
import { invalidateArtifact } from './queries';
import { SafeDiff } from './SafeDiff';

type Tab = 'warnings' | 'validation' | 'packages' | 'log' | 'versions';

/** The bottom panel: warnings, validation and compile results, packages, log and the version history. */
export function BottomPanel({
  artifact,
  version,
  versions,
  onSelectVersion,
}: {
  artifact: VisualArtifact | null;
  version: ArtifactVersion | null;
  versions: ArtifactVersion[];
  onSelectVersion: (n: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('warnings');
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);
  const errors = version?.diagnostics.filter((d) => d.severity === 'error').length ?? 0;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'warnings', label: 'Warnings', count: version?.warnings.length ?? 0 },
    { id: 'validation', label: 'Validation', count: errors },
    { id: 'packages', label: 'Packages', count: version?.packages.length ?? 0 },
    { id: 'log', label: 'Log' },
    { id: 'versions', label: 'Versions', count: versions.length },
  ];

  const restore = async (n: number) => {
    if (!artifact) return;
    try {
      const r = await runtime().visual.restore(artifact.id, n);
      invalidateArtifact(artifact.id);
      onSelectVersion(r.version.versionNumber);
      toast.success(`Version ${n} restored as version ${r.version.versionNumber}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="visual-bottom">
      <nav aria-label="Results" className="flex shrink-0 flex-wrap gap-0.5 border-b border-rule px-2 py-1">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)} className={cn('flex items-center gap-1 rounded-ctl px-2 py-0.5 text-ui text-ink-muted hover:bg-sunken', tab === t.id && 'bg-sunken text-ink')}>
            {t.label}
            {t.count ? <Badge className="text-ink" tone={t.id === 'validation' ? 'danger' : t.id === 'warnings' ? 'warning' : 'neutral'}>{t.count}</Badge> : null}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-ui">
        {!version ? (
          <p className="text-ink-muted">Nothing yet.</p>
        ) : tab === 'warnings' ? (
          version.warnings.length ? (
            <ul className="flex flex-col gap-1" data-testid="warnings">
              {version.warnings.map((w, i) => (
                <li key={i} className={cn('rounded-ctl px-2 py-1', w.startsWith('Invalid:') ? 'bg-danger-soft text-danger' : 'bg-warning-soft/50')}>
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">No warnings. Check the result against the image all the same.</p>
          )
        ) : tab === 'validation' ? (
          <div data-testid="validation">
            <p className="mb-1">
              <Badge className="text-ink" tone={COMPILE_TEXT[version.compilationStatus].tone}>{COMPILE_TEXT[version.compilationStatus].label}</Badge>{' '}
              {version.compilationStatus === 'succeeded' ? 'Compiled with pdfLaTeX in an isolated folder (no shell escape, no file access outside it).' : null}
            </p>
            <ul className="flex flex-col gap-1">
              {version.diagnostics.map((d, i) => (
                <li key={i} className={d.severity === 'error' ? 'text-danger' : 'text-ink-muted'}>
                  {d.line ? `Line ${d.line}: ` : ''}
                  {d.message}
                </li>
              ))}
            </ul>
          </div>
        ) : tab === 'packages' ? (
          <ul className="flex flex-wrap gap-1" data-testid="packages">
            {version.packages.map((p) => (
              <li key={p}>
                <Badge>{p}</Badge>
              </li>
            ))}
            <li className="w-full pt-1 text-[12px] text-ink-muted">Packages are never installed for you. Adding them to a project’s preamble is shown for approval when you insert.</li>
          </ul>
        ) : tab === 'log' ? (
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-ink-muted" data-testid="compile-log">
            {version.compileLog ?? 'No compile log for this version.'}
          </pre>
        ) : (
          <table className="w-full text-left" data-testid="versions">
            <thead className="text-[12px] text-ink-muted">
              <tr>
                <th className="font-normal">Version</th>
                <th className="font-normal">From</th>
                <th className="font-normal">Change</th>
                <th className="font-normal">Compile</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className={cn('border-t border-rule', v.versionNumber === version.versionNumber && 'bg-accent/5')}>
                  <td>
                    <button type="button" className="text-accent hover:underline" onClick={() => onSelectVersion(v.versionNumber)}>
                      {v.versionNumber}
                    </button>
                    {artifact?.approvedVersion === v.versionNumber ? <Badge tone="success" className="ml-1 text-ink">approved</Badge> : null}
                  </td>
                  <td>{ORIGIN_TEXT[v.origin]}</td>
                  <td className="max-w-[28ch] truncate" title={v.changeDescription}>
                    {v.changeDescription}
                  </td>
                  <td>
                    <Badge className="text-ink" tone={COMPILE_TEXT[v.compilationStatus].tone}>{COMPILE_TEXT[v.compilationStatus].label}</Badge>
                  </td>
                  <td className="flex justify-end gap-1 py-0.5">
                    {v.versionNumber !== version.versionNumber ? (
                      <Button size="sm" variant="ghost" onClick={() => setCompare({ from: v.versionNumber, to: version.versionNumber })} aria-label={`Compare version ${v.versionNumber} with ${version.versionNumber}`}>
                        <GitCompare />
                      </Button>
                    ) : null}
                    {artifact && v.versionNumber !== artifact.currentVersion ? (
                      <Button size="sm" variant="ghost" onClick={() => void restore(v.versionNumber)} aria-label={`Restore version ${v.versionNumber}`}>
                        <RotateCcw />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {artifact && compare ? <CompareVersionsDialog artifactId={artifact.id} versions={versions} initial={compare} onClose={() => setCompare(null)} /> : null}
    </div>
  );
}

export function CompareVersionsDialog({ artifactId, versions, initial, onClose }: { artifactId: string; versions: ArtifactVersion[]; initial: { from: number; to: number }; onClose: () => void }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const a = versions.find((v) => v.versionNumber === from);
  const b = versions.find((v) => v.versionNumber === to);
  const pick = (value: number, set: (n: number) => void, label: string) => (
    <Select aria-label={label} value={value} onChange={(e) => set(Number(e.target.value))} className="w-auto">
      {versions.map((v) => (
        <option key={v.versionNumber} value={v.versionNumber}>
          Version {v.versionNumber} ({ORIGIN_TEXT[v.origin]})
        </option>
      ))}
    </Select>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[5vh] flex h-[85vh] w-[min(1100px,calc(100vw-24px))] flex-col" aria-describedby="cmp-desc" data-testid="compare-versions">
        <DialogTitle className="flex items-center gap-2">
          <History className="size-4" aria-hidden /> Compare versions
        </DialogTitle>
        <DialogDescription id="cmp-desc" className="flex flex-wrap items-center gap-2">
          {pick(from, setFrom, 'Older version')} → {pick(to, setTo, 'Newer version')}
          {a && b && JSON.stringify(a.structuredData) !== JSON.stringify(b.structuredData) ? <Badge className="text-ink" tone="warning">structure changed</Badge> : null}
        </DialogDescription>
        <div className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md border border-rule">
          <SafeDiff original={a?.sourceCode ?? ''} modified={b?.sourceCode ?? ''} path={`visual-cmp://${artifactId}/${from}-${to}.tex`} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
