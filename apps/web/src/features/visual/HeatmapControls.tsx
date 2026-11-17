import { Input, Select } from '@research-studio/ui';
import type { PlotSettings } from './model';

export function HeatmapControls({
  style,
  onChange,
}: {
  style: PlotSettings['style'];
  onChange: (patch: Partial<PlotSettings['style']>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-rule p-2">
      <legend>Heatmap settings</legend>
      <label>
        Colour palette
        <Select
          value={style.colormap ?? 'viridis'}
          onChange={(e) => onChange({ colormap: e.target.value as 'viridis' | 'hot' | 'gray' })}
        >
          <option value="viridis">Viridis</option>
          <option value="hot">Hot</option>
          <option value="gray">Greyscale</option>
        </Select>
      </label>
      <label>
        Colour-bar label
        <Input
          maxLength={200}
          value={style.colorLabel ?? 'Value'}
          onChange={(e) => onChange({ colorLabel: e.target.value })}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(['colorMin', 'colorMax'] as const).map((key) => (
          <label key={key}>
            {key === 'colorMin' ? 'Colour minimum' : 'Colour maximum'}
            <Input
              type="number"
              step="any"
              placeholder="Auto"
              value={style[key] ?? ''}
              onChange={(e) =>
                onChange({ [key]: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={style.colorbar !== false}
          onChange={(e) => onChange({ colorbar: e.target.checked })}
        />
        Show colour bar
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={style.heatmapTopDown !== false}
          onChange={(e) => onChange({ heatmapTopDown: e.target.checked })}
        />
        First data row at top
      </label>
    </fieldset>
  );
}
