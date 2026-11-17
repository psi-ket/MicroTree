import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Input, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { useEditor } from '../../stores/editor';
import { errorText, type PlotSettings } from './model';
import { parseDataTable, selectedSeries, type NumberFormat } from './graph-data';
import { readGraphWorkbook } from './graph-workbook';
import { invalidateArtifact, useVisualProviders } from './queries';
import type { TaskSettings } from './InputPanel';
import { HeatmapControls } from './HeatmapControls';

type Sheet = { name: string; text: string };
const initialStyle: Omit<PlotSettings['style'], 'plotType'> & {
  plotType: 'line' | 'scatter' | 'bar' | 'heatmap';
} = {
  plotType: 'line',
  width: '10cm',
  height: '7cm',
  grid: 'major',
  legend: 'north east',
  monochrome: false,
  title: null,
};

export function DataPlotPanel({
  projectId,
  onCreated,
  settings,
  onSettings,
}: {
  projectId: string | null;
  onCreated: (id: string) => void;
  settings: TaskSettings;
  onSettings: (patch: Partial<TaskSettings>) => void;
}) {
  const providers = useVisualProviders();
  const [text, setText] = useState('');
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState('auto');
  const [numberFormat, setNumberFormat] = useState<NumberFormat>('auto');
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState('');
  const [x, setX] = useState(0);
  const [ys, setYs] = useState<number[]>([1]);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState<number | null>(null);
  const [title, setTitle] = useState('Graph');
  const [xLabel, setXLabel] = useState('');
  const [yLabel, setYLabel] = useState('');
  const [xScale, setXScale] = useState<'linear' | 'log'>('linear');
  const [yScale, setYScale] = useState<'linear' | 'log'>('linear');
  const [style, setStyle] = useState(initialStyle);
  const heatmap = style.plotType === 'heatmap';
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => {
    try {
      return { table: parseDataTable(text, header, delimiter), error: '' };
    } catch (e) {
      return { table: null, error: errorText(e) };
    }
  }, [text, header, delimiter]);
  const table = parsed.table;
  const reset = (value: string) => {
    setText(value);
    setX(0);
    setYs([1]);
    setStart(1);
    setEnd(null);
  };
  const load = async (file: File) => {
    setBusy(true);
    try {
      if (file.size > 5_000_000) throw new Error('Choose a file smaller than 5 MB.');
      if (/\.xlsx$/i.test(file.name)) {
        const values = await readGraphWorkbook(await file.arrayBuffer());
        setSheets(values);
        setSheet(values[0]!.name);
        setDelimiter('\t');
        reset(values[0]!.text);
      } else {
        if (!/\.(csv|tsv|txt|dat)$/i.test(file.name))
          throw new Error(
            'Choose CSV, TSV, TXT, DAT or XLSX. For older XLS workbooks, save as XLSX or paste cells.',
          );
        setSheets([]);
        setDelimiter('auto');
        reset(await file.text());
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!table) return;
    setBusy(true);
    try {
      const selected = heatmap ? [...ys].filter((i) => i !== x).sort((a, b) => a - b) : ys;
      const series = selectedSeries(
        table,
        x,
        selected,
        start,
        end ?? table.rows.length,
        numberFormat,
      );
      const result = await runtime().visual.createDataPlot({
        projectId,
        title,
        xLabel: xLabel || (heatmap ? 'Column' : table.headers[x]) || '',
        yLabel:
          yLabel ||
          (heatmap ? table.headers[x] : ys.length === 1 ? table.headers[ys[0]!] : '') ||
          '',
        series,
        style: { ...style, title },
        xScale: heatmap ? 'linear' : xScale,
        yScale: heatmap ? 'linear' : yScale,
      });
      invalidateArtifact(result.artifact.id);
      onCreated(result.artifact.id);
      toast.success('Graph created. Review the preview, then approve and insert.');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 p-3 text-ui" aria-label="Graph from data">
      <p className="text-ink-muted">
        Import a table or paste cells from Excel. Choose the data, graph type and labels below.
      </p>
      <label>
        Data file (CSV, Excel XLSX, TSV or TXT)
        <input
          className="mt-1 block w-full"
          type="file"
          accept=".csv,.xlsx,.tsv,.txt,.dat"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(f);
            e.target.value = '';
          }}
        />
      </label>
      {sheets.length > 0 && (
        <label>
          Worksheet
          <Select
            value={sheet}
            onChange={(e) => {
              setSheet(e.target.value);
              reset(sheets.find((s) => s.name === e.target.value)!.text);
            }}
          >
            {sheets.map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </Select>
        </label>
      )}
      <Button
        onClick={() => {
          const editor = useEditor.getState();
          if (editor.projectId !== projectId || !editor.selection?.text)
            return void toast.info('Select a data table in the project editor first.');
          setSheets([]);
          setDelimiter('auto');
          reset(editor.selection.text);
        }}
      >
        Use selected editor data
      </Button>
      <label>
        Paste or edit data
        <textarea
          className="mt-1 w-full rounded-ctl border border-rule bg-raised p-2 font-mono text-[12px]"
          rows={6}
          value={text}
          onChange={(e) => reset(e.target.value)}
          placeholder={'Time,Measurement\n0,2.4\n1,3.8\n2,5.1'}
        />
      </label>
      <label className="flex gap-2">
        <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
        First row contains column names
      </label>
      <label>
        Separator
        <Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
          {[
            ['auto', 'Auto'],
            [',', 'Comma'],
            [';', 'Semicolon'],
            ['\t', 'Tab / Excel'],
            [' ', 'Whitespace'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </label>
      <label>
        Number format
        <Select
          value={numberFormat}
          onChange={(e) => setNumberFormat(e.target.value as NumberFormat)}
        >
          <option value="auto">Auto (33,574 → 33.574)</option>
          <option value="comma">Decimal comma (1.234,56 → 1234.56)</option>
          <option value="dot">Decimal point (1,234.56 → 1234.56)</option>
        </Select>
      </label>
      <p className="text-ink-muted">
        Auto reads a single comma as a decimal separator. If commas mark thousands, choose Decimal
        point.
      </p>
      {parsed.error && (
        <p role="alert" className="text-danger">
          {parsed.error}
        </p>
      )}
      {table && table.headers.length > 0 && (
        <>
          <p>
            {table.rows.length} data rows, {table.headers.length} columns. Numeric values are
            required for both axes.
          </p>
          <div className="max-h-40 overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr>
                  {table.headers.map((h, i) => (
                    <th key={i} className="px-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    {table.headers.map((_, j) => (
                      <td key={j} className="px-2">
                        {row[j] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label>
            {heatmap ? 'Row values column' : 'X column'}
            <Select
              value={x}
              onChange={(e) => {
                const next = Number(e.target.value);
                setX(next);
                if (heatmap) setYs(ys.filter((i) => i !== next));
              }}
            >
              {table.headers.map((h, i) => (
                <option key={i} value={i}>
                  {h}
                </option>
              ))}
            </Select>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend>
              {heatmap ? 'Heatmap measurement columns' : 'Y columns (one series per column)'}
            </legend>
            {table.headers.map((h, i) => (
              <label key={i} className="flex gap-2">
                <input
                  type="checkbox"
                  disabled={heatmap && i === x}
                  checked={ys.includes(i)}
                  onChange={(e) => setYs(e.target.checked ? [...ys, i] : ys.filter((v) => v !== i))}
                />
                {h}
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <label>
              First data row
              <Input
                type="number"
                min={1}
                max={table.rows.length}
                value={start}
                onChange={(e) => setStart(Number(e.target.value))}
              />
            </label>
            <label>
              Last data row
              <Input
                type="number"
                min={start}
                max={table.rows.length}
                value={end ?? table.rows.length}
                onChange={(e) => setEnd(Number(e.target.value))}
              />
            </label>
          </div>
        </>
      )}
      <label>
        Graph type
        <Select
          value={style.plotType}
          onChange={(e) => {
            setStyle({ ...style, plotType: e.target.value as typeof style.plotType });
            if (e.target.value === 'heatmap' && table)
              setYs(table.headers.flatMap((_, i) => (i === x ? [] : [i])));
          }}
        >
          {['line', 'scatter', 'bar', 'heatmap'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </Select>
      </label>
      {heatmap && (
        <>
          <p className="text-ink-muted">
            Selected column names run across X, row values run down Y, and cell measurements set the
            colour. Rows and columns are equally spaced in table order. Choose at least two
            measurement columns and two rows.
          </p>
          <HeatmapControls
            style={style}
            onChange={(patch) => setStyle({ ...style, ...patch, plotType: 'heatmap' })}
          />
        </>
      )}
      <label>
        Title
        <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        X label
        <Input
          value={xLabel}
          placeholder={heatmap ? 'Column' : table?.headers[x]}
          onChange={(e) => setXLabel(e.target.value)}
          maxLength={200}
        />
      </label>
      <label>
        Y label
        <Input
          value={yLabel}
          placeholder={
            heatmap ? table?.headers[x] : ys.length === 1 ? table?.headers[ys[0]!] : 'Measurement'
          }
          onChange={(e) => setYLabel(e.target.value)}
          maxLength={200}
        />
      </label>
      {!heatmap && (
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['X', xScale, setXScale],
              ['Y', yScale, setYScale],
            ] as const
          ).map(([name, value, set]) => (
            <label key={name}>
              {name} scale
              <Select value={value} onChange={(e) => set(e.target.value as 'linear' | 'log')}>
                <option value="linear">Linear</option>
                <option value="log">Logarithmic</option>
              </Select>
            </label>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {(['width', 'height'] as const).map((key) => (
          <label key={key}>
            {key} (e.g. 10cm)
            <Input
              value={style[key]}
              onChange={(e) => setStyle({ ...style, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {!heatmap && (
        <label>
          Grid
          <Select
            value={style.grid}
            onChange={(e) => setStyle({ ...style, grid: e.target.value as typeof style.grid })}
          >
            {['none', 'major', 'both'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </label>
      )}
      {!heatmap && (
        <label>
          Legend
          <Select
            value={style.legend}
            onChange={(e) => setStyle({ ...style, legend: e.target.value as typeof style.legend })}
          >
            {[
              'none',
              'north east',
              'north west',
              'south east',
              'south west',
              'outer north east',
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </label>
      )}
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={style.monochrome}
          onChange={(e) => setStyle({ ...style, monochrome: e.target.checked })}
        />
        Black and white
      </label>
      <Button
        variant="primary"
        disabled={busy || !table?.rows.length || !title.trim() || !ys.length}
        onClick={() => void create()}
      >
        {busy && <Spinner />}Create graph
      </Button>
      <label>
        AI provider (optional)
        <Select
          value={settings.providerId}
          onChange={(e) => {
            const p = providers.data?.providers.find((v) => v.id === e.target.value);
            onSettings({ providerId: e.target.value, model: p?.defaultModel ?? '' });
          }}
        >
          <option value="">Choose for AI refinement…</option>
          {providers.data?.providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.usable}>
              {p.displayName} ({p.privacyMode})
            </option>
          ))}
        </Select>
      </label>
      <label>
        AI model
        <Input value={settings.model} onChange={(e) => onSettings({ model: e.target.value })} />
      </label>
      <p className="text-ink-muted">
        After creating, describe a change and click “Improve” to ask AI. The selected provider and
        model apply. Your imported values stay in the data file. Add the caption and figure label
        when inserting.
      </p>
    </section>
  );
}
