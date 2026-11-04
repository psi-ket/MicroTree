# Plot reconstruction (M4)

Task `plot` turns an image of a plot into PGFPlots source and a CSV file.
The numbers are never presented as the original data.

## 1. What the model returns

`PlotOutputSchema` (`packages/visual-engine/src/schemas/plot.schema.ts`):

- `plotType`: line, scatter, bar, histogram, contour, other
- `xAxis`, `yAxis`: `label`, `unit`, `scale` (`linear`, `log`),
  `reversed`, `min`, `max`, and `calibration`: reference ticks as
  `{ pixel, value }`, the pixel coordinate along that axis (x for the x
  axis, y for the y axis, origin at the top left of the image) and the value
  printed there
- `series`: `name`, `color`, `marker`, `line`, `pixelPoints` (`px`, `py`, and
  the pixel ends of visible error bars) and `estimatedValues` (values read by
  eye, only where pixel positions could not be given)
- `legendPosition`, `annotations`, `warnings`

## 2. Digitising

`digitizePlot` (`plots/plot-digitizer.ts`):

1. Each axis is calibrated by least squares through its reference ticks,
   on the value (linear) or its base-10 logarithm (log). Reversed axes come
   out of the fit (a negative slope); the `reversed` flag is used for
   drawing. Fewer than two usable ticks means no calibration, with a warning.
2. With more than two ticks the residual is checked; ticks that do not lie
   on the stated scale give a warning (wrong scale or misread tick).
3. Pixel points become values; each gets a reading uncertainty of half a
   pixel converted to data units, and error bars become `yErrMinus` and
   `yErrPlus`.
4. Without calibration, the model's `estimatedValues` are used.

Every point carries its **origin**:

| Origin | Meaning |
| --- | --- |
| `exact` | values you entered |
| `digitized` | computed from pixel positions through the calibration |
| `model-estimated` | read off by the model by eye |

Warnings say which kinds are present. Non-positive values on log axes and
contour plots (not digitised into series) are reported.

## 3. Output

- `plotTableCsv`: the file PGFPlots reads, one column group per series
  (`s1_x`, `s1_y`, `s1_em`, `s1_ep`), `nan` for missing values.
- `plotExportCsv`: the export for people: series, x, y, uncertainties, error
  bars and origin per row.
- `generatePgfplots(data, file, style)`: `axis`, `semilogyaxis`,
  `semilogxaxis` or `loglogaxis` by the axis scales, `x dir=reverse` for
  reversed axes, labels with units, one `\addplot table` per series reading
  its columns, error bars where present, and the style.

## 4. Changing a plot without asking the model again

`POST /visual/artifacts/:id/plot` (the **Axes & style** and **CSV** tabs)
makes a new version:

- **Style** (`width`, `height`, `grid`, `monochrome`, `legend`,
  `plotType`, `title`): the source is regenerated from the same data; the
  CSV is unchanged.
- **Calibration** (`scale`, `reversed`, ticks per axis): the stored pixel
  positions are digitised again (origin `calibration`). Only possible for
  plots reconstructed from an image.
- **Exact data** (`x,y[,yerr]` CSV): replaces the values with `exact`
  ones; parsing errors are reported per line.

None of these calls a model.

## 5. Insertion

The source and its CSV go to `figures/<name>.tex` and
`figures/<name>-data.csv`; the source's table path is rewritten to the
project path, which PGFPlots reads relative to the main file (a warning
says so).

## 6. Tests

Linear, logarithmic and reversed axes, residual warnings, uncertainties,
error bars, estimated values, CSV round trips and real pdfLaTeX compiles
(`packages/visual-engine/test/generators.test.ts`); restyle, recalibration,
exact data and export over HTTP without any model call
(`apps/runtime/test/visual.test.ts`); the same in the browser
(`e2e/visual.spec.ts`).
