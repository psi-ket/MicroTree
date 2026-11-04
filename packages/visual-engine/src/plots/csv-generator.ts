import type { PlotData } from '../schemas/plot.schema';

const num = (v: number | null) => (v === null || !Number.isFinite(v) ? 'nan' : String(v));
const field = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The data file PGFPlots reads: one column group per series
 * (`s1_x, s1_y, s1_em, s1_ep`, …), padded with `nan`, which PGFPlots skips.
 */
export function plotTableCsv(data: PlotData): string {
  const header = data.series.flatMap((_, i) => [`s${i + 1}_x`, `s${i + 1}_y`, `s${i + 1}_em`, `s${i + 1}_ep`]);
  const rows = Math.max(0, ...data.series.map((s) => s.points.length));
  const lines = [header.join(',')];
  for (let r = 0; r < rows; r++) {
    lines.push(
      data.series
        .flatMap((s) => {
          const p = s.points[r];
          return p ? [num(p.x), num(p.y), num(p.yErrMinus), num(p.yErrPlus)] : ['nan', 'nan', 'nan', 'nan'];
        })
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The export with provenance: one row per point with its series, values,
 * error bars, reading uncertainty and origin (`exact`, `digitized`,
 * `model-estimated`), plus the axis units in the header comment.
 */
export function plotExportCsv(data: PlotData): string {
  const unit = (a: PlotData['xAxis']) => [a.label, a.unit ? `[${a.unit}]` : null].filter(Boolean).join(' ') || 'unlabelled';
  const lines = [
    `# x: ${unit(data.xAxis)} (${data.xAxis.scale}); y: ${unit(data.yAxis)} (${data.yAxis.scale})`,
    '# digitized and model-estimated values are approximations read from an image, not original measurements',
    'series,x,y,y_err_minus,y_err_plus,x_uncertainty,y_uncertainty,origin',
  ];
  for (const s of data.series) for (const p of s.points) lines.push([field(s.name), num(p.x), num(p.y), num(p.yErrMinus), num(p.yErrPlus), num(p.xUncertainty), num(p.yUncertainty), p.origin].join(','));
  return `${lines.join('\n')}\n`;
}

/** Parse user-supplied CSV (`x,y[,yerr]`, an optional header line) into exact rows. */
export function parseXyCsv(text: string): { rows: { x: number; y: number; yErr: number | null }[]; errors: string[] } {
  const rows: { x: number; y: number; yErr: number | null }[] = [];
  const errors: string[] = [];
  let first = true;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const cells = t.split(/[,;\t]/).map((c) => c.trim());
    const [x, y, e] = cells.map(Number);
    const isHeader = first && !Number.isFinite(x);
    first = false;
    if (isHeader) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      errors.push(`Line ${i + 1}: expected two numbers`);
      return;
    }
    rows.push({ x: x!, y: y!, yErr: cells.length > 2 && Number.isFinite(e) ? e! : null });
  });
  return { rows, errors };
}
