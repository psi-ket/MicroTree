import { VisualError } from '../errors/visual-errors';
import type { PlotData } from '../schemas/plot.schema';
import type { PlotStyle } from './pgfplots-generator';

/** Matrix indices preserve column headings such as 1.10 without treating them as numbers. */
export function heatmapTableCsv(data: PlotData): string {
  const first = data.series[0]?.points ?? [];
  if (data.series.length < 2 || first.length < 2)
    throw new VisualError(
      'invalid-structure',
      'A heatmap needs at least two selected measurement columns and two rows.',
    );
  if (new Set(first.map((p) => p.x)).size !== first.length)
    throw new VisualError('invalid-structure', 'Heatmap row values must be unique.');
  if (data.xAxis.scale !== 'linear' || data.yAxis.scale !== 'linear')
    throw new VisualError(
      'invalid-structure',
      'Heatmaps use equally spaced table rows and columns; choose linear axes.',
    );
  if (
    data.series.some(
      (s) =>
        s.points.length !== first.length ||
        s.points.some(
          (p, r) => p.x !== first[r]!.x || !Number.isFinite(p.x) || !Number.isFinite(p.y),
        ),
    )
  )
    throw new VisualError(
      'invalid-structure',
      'Heatmap columns must share the same row values and contain finite measurements.',
    );
  const lines = ['column,row,value'];
  first.forEach((_, r) => data.series.forEach((s, c) => lines.push(`${c},${r},${s.points[r]!.y}`)));
  return `${lines.join('\n')}\n`;
}

export function generateHeatmap(
  data: PlotData,
  file: string,
  style: PlotStyle,
  opts: string[],
): string {
  heatmapTableCsv(data);
  const rows = data.series[0]!.points;
  if (typeof style.colorMin === 'number' && typeof style.colorMax === 'number' && style.colorMin >= style.colorMax)
    throw new VisualError('invalid-structure', 'Colour minimum must be less than colour maximum.');
  opts.push(
    'view={0}{90}',
    'axis on top',
    'enlargelimits=false',
    `xmin=-0.5`,
    `xmax=${data.series.length - 0.5}`,
    `ymin=-0.5`,
    `ymax=${rows.length - 0.5}`,
    `xtick={${data.series.map((_, i) => i).join(',')}}`,
    `xticklabels={${data.series.map((s) => `{${s.name}}`).join(',')}}`,
    `ytick={${rows.map((_, i) => i).join(',')}}`,
    `yticklabels={${rows.map((p) => `{${p.x}}`).join(',')}}`,
  );
  if ((style.heatmapTopDown !== false) !== data.yAxis.reversed) opts.push('y dir=reverse');
  if (data.xAxis.reversed) opts.push('x dir=reverse');
  const palette = style.monochrome ? 'gray' : (style.colormap ?? 'viridis');
  opts.push(
    palette === 'gray' ? 'colormap={gray}{gray(0cm)=(0); gray(1cm)=(1)}' : `colormap/${palette}`,
  );
  if (style.colorbar !== false)
    opts.push('colorbar', `colorbar style={ylabel={${style.colorLabel ?? 'Value'}}}`);
  if (typeof style.colorMin === 'number') opts.push(`point meta min=${style.colorMin}`);
  if (typeof style.colorMax === 'number') opts.push(`point meta max=${style.colorMax}`);
  if (style.title) opts.push(`title={${style.title}}`);
  return [
    '\\begin{tikzpicture}',
    `\\begin{axis}[\n  ${opts.join(',\n  ')}\n]`,
    `\\addplot[matrix plot*, mesh/cols=${data.series.length}, mesh/ordering=x varies, point meta=explicit] table[x=column, y=row, meta=value, col sep=comma] {${file}};`,
    '\\end{axis}',
    '\\end{tikzpicture}',
  ].join('\n');
}
