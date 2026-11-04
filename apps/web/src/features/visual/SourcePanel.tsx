import Editor from '@monaco-editor/react';
import { Check, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ArtifactVersion, VisualArtifact } from '@research-studio/api-contracts';
import { Button, cn, FieldHint, Label, PanelHeading, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { useResolvedTheme } from '../../lib/theme';
import { setupMonaco } from '../editor/monaco-setup';
import { errorText, plotSettingsOf, type PlotAxis, type PlotSettings } from './model';
import { invalidateArtifact } from './queries';

setupMonaco();

type Tab = 'latex' | 'csv' | 'plot' | 'structure';

const EDITOR_OPTIONS = {
  fontFamily: "'Atkinson Hyperlegible Mono Variable', 'Atkinson Hyperlegible Mono', ui-monospace, monospace",
  fontSize: 13,
  minimap: { enabled: false },
  wordWrap: 'on' as const,
  scrollBeyondLastLine: false,
  lineNumbersMinChars: 3,
  padding: { top: 8, bottom: 8 },
  unicodeHighlight: { ambiguousCharacters: false },
};

/**
 * The right panel: the editable source and, for plots, the CSV data and the
 * axis calibration and style (changed without asking the model again). Saving
 * makes a new version; nothing is overwritten.
 */
export function SourcePanel({ artifact, version, isCurrent }: { artifact: VisualArtifact | null; version: ArtifactVersion | null; isCurrent: boolean }) {
  const theme = useResolvedTheme();
  const [tab, setTab] = useState<Tab>('latex');
  const [draft, setDraft] = useState('');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const plot = plotSettingsOf(version);

  useEffect(() => {
    setDraft(version?.sourceCode ?? '');
    setCsv(version?.dataCsv ?? '');
  }, [version?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if ((tab === 'csv' || tab === 'plot') && artifact?.artifactType !== 'plot') setTab('latex');
  }, [artifact?.artifactType, tab]);

  if (!artifact || !version) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <PanelHeading>Source</PanelHeading>
        <p className="px-3 text-ui text-ink-muted">The editable LaTeX appears here after a reconstruction.</p>
      </div>
    );
  }

  const dirty = draft !== version.sourceCode;
  const save = async () => {
    setBusy(true);
    try {
      await runtime().visual.saveVersion(artifact.id, { sourceCode: draft, changeDescription: 'Edited by hand' });
      invalidateArtifact(artifact.id);
      toast.success('Saved as a new version');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    try {
      const r = await runtime().visual.validate(artifact.id, draft);
      const errors = r.issues.filter((i) => i.severity === 'error');
      if (errors.length) toast.error(`${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors[0]!.message}`);
      else if (r.missingPackages.length) toast.warning(`Not installed: ${r.missingPackages.join(', ')}`);
      else toast.success(`No problems found. Packages: ${r.packages.join(', ') || 'none'}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: 'latex', label: artifact.artifactType === 'explanation' ? 'Caption' : 'LaTeX' },
    ...(artifact.artifactType === 'plot' ? [{ id: 'csv' as const, label: 'CSV' }, { id: 'plot' as const, label: 'Axes & style' }] : []),
    { id: 'structure', label: 'Structure' },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-testid="visual-source">
      <PanelHeading className="flex items-center gap-1">
        <nav aria-label="Source views" className="flex gap-0.5">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)} className={cn('rounded-ctl px-2 py-0.5 text-ui text-ink-muted hover:bg-sunken', tab === t.id && 'bg-sunken text-ink')}>
              {t.label}
            </button>
          ))}
        </nav>
      </PanelHeading>
      {tab === 'latex' ? (
        <>
          <div className="min-h-0 flex-1 border-y border-rule" data-testid="source-editor">
            <Editor
              path={`visual://${artifact.id}/v${version.versionNumber}.tex`}
              value={draft}
              language="latex"
              theme={theme === 'dark' ? 'rs-dark' : 'rs-light'}
              onChange={(v) => setDraft(v ?? '')}
              options={EDITOR_OPTIONS}
              loading={<textarea aria-label="LaTeX source" className="h-full w-full bg-panel p-2 font-mono text-[12px]" value={draft} onChange={(e) => setDraft(e.target.value)} />}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 p-2">
            <Button size="sm" onClick={() => void validate()}>
              <ShieldCheck /> Validate
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void save()} data-testid="save-version">
              {busy ? <Spinner /> : <Save />} Save as new version
            </Button>
            {!isCurrent ? <FieldHint>You are viewing an older version; saving builds on it.</FieldHint> : null}
          </div>
        </>
      ) : tab === 'csv' ? (
        <CsvTab artifactId={artifact.id} csv={csv} onCsv={setCsv} version={version} />
      ) : tab === 'plot' && plot ? (
        <PlotTab artifactId={artifact.id} settings={plot} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words border-t border-rule p-2 font-mono text-[11px] text-ink-muted" data-testid="structure-view">
          {JSON.stringify(version.structuredData, null, 2)}
        </pre>
      )}
    </div>
  );
}

function CsvTab({ artifactId, csv, onCsv, version }: { artifactId: string; csv: string; onCsv: (v: string) => void; version: ArtifactVersion }) {
  const [exact, setExact] = useState('x,y\n');
  const [busy, setBusy] = useState(false);
  const replace = async () => {
    setBusy(true);
    try {
      await runtime().visual.updatePlot(artifactId, { exactCsv: exact });
      invalidateArtifact(artifactId);
      toast.success('The plot now uses your exact values');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const text = await runtime().visual.export(artifactId, version.versionNumber, 'csv');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = 'plot-data.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
      <div>
        <Label htmlFor="plot-csv">Data PGFPlots reads (read only)</Label>
        <textarea id="plot-csv" readOnly value={csv} onChange={(e) => onCsv(e.target.value)} rows={8} className="w-full rounded-ctl border border-rule bg-sunken/40 p-1.5 font-mono text-[11px]" data-testid="plot-csv" />
        <FieldHint>Columns per series: x, y, lower and upper error. Digitised values are approximations; the export says where each value came from.</FieldHint>
        <Button size="sm" onClick={() => void download()}>
          Export CSV with origins
        </Button>
      </div>
      <div>
        <Label htmlFor="exact-csv">Replace with exact data (x,y[,yerr])</Label>
        <textarea id="exact-csv" value={exact} onChange={(e) => setExact(e.target.value)} rows={6} className="w-full rounded-ctl border border-rule bg-raised p-1.5 font-mono text-[11px]" />
        <Button size="sm" disabled={busy || exact.trim().split('\n').length < 2} onClick={() => void replace()}>
          {busy ? <Spinner /> : <Check />} Use these values
        </Button>
      </div>
    </div>
  );
}

function AxisEditor({ name, axis, onChange, canRecalibrate }: { name: string; axis: PlotAxis; onChange: (a: PlotAxis) => void; canRecalibrate: boolean }) {
  return (
    <fieldset className="rounded-md border border-rule p-2">
      <legend className="px-1 text-[12px] font-medium">{name} axis</legend>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[12px]">
          Scale
          <Select value={axis.scale} onChange={(e) => onChange({ ...axis, scale: e.target.value as 'linear' | 'log' })} aria-label={`${name} scale`}>
            <option value="linear">Linear</option>
            <option value="log">Logarithmic</option>
          </Select>
        </label>
        <label className="flex items-end gap-1.5 text-[12px]">
          <input type="checkbox" checked={axis.reversed} onChange={(e) => onChange({ ...axis, reversed: e.target.checked })} /> Reversed
        </label>
      </div>
      {canRecalibrate ? (
        <table className="mt-1.5 w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="font-normal">Pixel</th>
              <th className="font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {axis.calibration.map((c, i) => (
              <tr key={i}>
                {(['pixel', 'value'] as const).map((k) => (
                  <td key={k}>
                    <input
                      type="number"
                      step="any"
                      aria-label={`${name} tick ${i + 1} ${k}`}
                      className="h-6 w-full rounded-ctl border border-rule bg-raised px-1 font-mono"
                      value={c[k]}
                      onChange={(e) => onChange({ ...axis, calibration: axis.calibration.map((x, j) => (j === i ? { ...x, [k]: Number(e.target.value) } : x)) })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canRecalibrate ? (
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...axis, calibration: [...axis.calibration, { pixel: 0, value: 0 }] })}>
          Add tick
        </Button>
      ) : null}
    </fieldset>
  );
}

function PlotTab({ artifactId, settings }: { artifactId: string; settings: PlotSettings }) {
  const [style, setStyle] = useState(settings.style);
  const [x, setX] = useState(settings.xAxis);
  const [y, setY] = useState(settings.yAxis);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setStyle(settings.style);
    setX(settings.xAxis);
    setY(settings.yAxis);
  }, [settings]);
  const apply = async (what: 'style' | 'axes') => {
    setBusy(true);
    try {
      const pick = (a: PlotAxis) => ({ scale: a.scale, reversed: a.reversed, calibration: a.calibration });
      await runtime().visual.updatePlot(artifactId, what === 'style' ? { style } : { xAxis: pick(x), yAxis: pick(y) });
      invalidateArtifact(artifactId);
      toast.success(what === 'style' ? 'Style changed; the data was not touched' : 'Axes recalibrated and digitised again');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2" data-testid="plot-settings">
      <p className="text-[12px] text-ink-muted">Values here are {settings.origins.join(' and ') || 'not available'}.</p>
      <fieldset className="grid grid-cols-2 gap-1.5 rounded-md border border-rule p-2">
        <legend className="px-1 text-[12px] font-medium">Style</legend>
        <label className="text-[12px]">
          Type
          <Select value={style.plotType} onChange={(e) => setStyle({ ...style, plotType: e.target.value as PlotSettings['style']['plotType'] })}>
            {['line', 'scatter', 'bar', 'histogram'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        <label className="text-[12px]">
          Grid
          <Select value={style.grid} onChange={(e) => setStyle({ ...style, grid: e.target.value as PlotSettings['style']['grid'] })}>
            {['none', 'major', 'both'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={style.monochrome} onChange={(e) => setStyle({ ...style, monochrome: e.target.checked })} /> Black and white
        </label>
        <Button size="sm" disabled={busy} onClick={() => void apply('style')} data-testid="apply-style">
          Apply style
        </Button>
      </fieldset>
      <AxisEditor name="x" axis={x} onChange={setX} canRecalibrate={settings.canRecalibrate} />
      <AxisEditor name="y" axis={y} onChange={setY} canRecalibrate={settings.canRecalibrate} />
      <Button size="sm" disabled={busy} onClick={() => void apply('axes')} data-testid="apply-axes">
        Recalibrate axes
      </Button>
      {!settings.canRecalibrate ? <FieldHint>These values were entered as exact data, so there are no pixel positions to recalibrate.</FieldHint> : null}
    </div>
  );
}
