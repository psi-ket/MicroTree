import type { PlotData } from '../schemas/plot.schema';

/** Style choices that do not touch the data (changing them never re-extracts anything). */
export interface PlotStyle {
  width: string;
  height: string;
  grid: 'none' | 'major' | 'both';
  monochrome: boolean;
  legend: 'north east' | 'north west' | 'south east' | 'south west' | 'outer north east' | 'none';
  plotType: 'line' | 'scatter' | 'bar' | 'histogram';
  /** Title above the axis. */
  title: string | null;
}

export const DEFAULT_PLOT_STYLE: PlotStyle = { width: '8cm', height: '6cm', grid: 'major', monochrome: false, legend: 'north east', plotType: 'line', title: null };

const MARK: Record<string, string> = { none: 'none', circle: '*', square: 'square*', triangle: 'triangle*', diamond: 'diamond*', cross: 'x', plus: '+', star: 'star' };
const DASH: Record<string, string> = { solid: 'solid', dashed: 'dashed', dotted: 'dotted', none: 'only marks' };
const GRAYS = ['black', 'black!60', 'black!40', 'black!80', 'black!25'];

const axisLabel = (label: string | null, unit: string | null) => {
  const text = label ?? '';
  return unit ? `${text}${text ? ' ' : ''}(${unit})` : text;
};

const SIZE = /^\d+(\.\d+)?(cm|mm|pt|in)$/;

/**
 * PGFPlots source for plot data. The data is read from a CSV file next to
 * the source (`dataFile`), so the numbers are never mixed into the code and
 * the style can change without touching them.
 */
export function generatePgfplots(data: PlotData, dataFile: string, style: PlotStyle = DEFAULT_PLOT_STYLE): string {
  const ax = data.xAxis;
  const ay = data.yAxis;
  const opts = [
    `width=${SIZE.test(style.width) ? style.width : '8cm'}`,
    `height=${SIZE.test(style.height) ? style.height : '6cm'}`,
    `xlabel={${axisLabel(ax.label, ax.unit)}}`,
    `ylabel={${axisLabel(ay.label, ay.unit)}}`,
  ];
  if (ax.scale === 'log') opts.push('xmode=log');
  if (ay.scale === 'log') opts.push('ymode=log');
  if (ax.reversed) opts.push('x dir=reverse');
  if (ay.reversed) opts.push('y dir=reverse');
  for (const [k, v] of [
    ['xmin', ax.min],
    ['xmax', ax.max],
    ['ymin', ay.min],
    ['ymax', ay.max],
  ] as const) {
    if (v !== null && Number.isFinite(v)) opts.push(`${k}=${v}`);
  }
  if (style.grid !== 'none') opts.push(`grid=${style.grid}`);
  if (style.legend !== 'none' && data.series.length > 1) opts.push(`legend pos=${style.legend}`);
  if (style.plotType === 'bar') opts.push('ybar', 'bar width=6pt');
  if (style.plotType === 'histogram') opts.push('ybar interval');
  if (style.title) opts.push(`title={${style.title}}`);
  const lines = ['\\begin{tikzpicture}', `\\begin{axis}[\n  ${opts.join(',\n  ')}\n]`];
  data.series.forEach((s, i) => {
    const n = i + 1;
    const hasErr = s.points.some((p) => p.yErrMinus !== null || p.yErrPlus !== null);
    const color = style.monochrome ? GRAYS[i % GRAYS.length]! : (s.color ?? null);
    const plotOpts = [
      color ? `color=${color}` : null,
      style.plotType === 'scatter' ? 'only marks' : style.plotType === 'line' ? DASH[s.line] : null,
      `mark=${style.plotType === 'bar' || style.plotType === 'histogram' ? 'none' : (MARK[s.marker] ?? '*')}`,
      hasErr ? 'error bars/.cd, y dir=both, y explicit' : null,
    ].filter((x): x is string => !!x);
    const table = [`x=s${n}_x`, `y=s${n}_y`, ...(hasErr ? [`y error minus=s${n}_em`, `y error plus=s${n}_ep`] : []), 'col sep=comma'];
    lines.push(`\\addplot+[${plotOpts.join(', ')}] table[${table.join(', ')}] {${dataFile}};`);
    if (style.legend !== 'none' && data.series.length > 1) lines.push(`\\addlegendentry{${s.name}}`);
  });
  lines.push('\\end{axis}', '\\end{tikzpicture}');
  return lines.join('\n');
}
