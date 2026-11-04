import type { Axis, DataPoint, PlotData, PlotOutput } from '../schemas/plot.schema';

/**
 * Axis calibration and digitising. A calibration maps pixel positions along
 * an axis to values: a least-squares line through the reference ticks, in
 * log10 space for logarithmic axes. Reversed axes need nothing special (the
 * slope is negative). Each digitised value carries the uncertainty of one
 * pixel step (± half a pixel), converted to data units.
 */
export interface Calibration {
  scale: 'linear' | 'log';
  /** value (or log10 value) = a + b × pixel */
  a: number;
  b: number;
}

export function calibrate(axis: Axis): Calibration | null {
  const pts = axis.calibration.filter((c) => Number.isFinite(c.pixel) && Number.isFinite(c.value) && (axis.scale === 'linear' || c.value > 0));
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.pixel);
  const ys = pts.map((p) => (axis.scale === 'log' ? Math.log10(p.value) : p.value));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  if (b === 0) return null;
  return { scale: axis.scale, a: my - b * mx, b };
}

export function toValue(c: Calibration, pixel: number): number {
  const v = c.a + c.b * pixel;
  return c.scale === 'log' ? 10 ** v : v;
}

/** Half a pixel of reading uncertainty at this pixel, in data units. */
export function halfPixelUncertainty(c: Calibration, pixel: number): number {
  const half = Math.abs(c.b) * 0.5;
  if (c.scale === 'linear') return half;
  const v = toValue(c, pixel);
  return v * (10 ** half - 1);
}

/** Residual of the calibration ticks themselves (how well the ticks agree with a straight scale). */
export function calibrationResidual(axis: Axis, c: Calibration): number {
  let worst = 0;
  for (const t of axis.calibration) {
    const got = c.scale === 'log' ? Math.log10(toValue(c, t.pixel)) : toValue(c, t.pixel);
    const want = c.scale === 'log' ? Math.log10(t.value) : t.value;
    worst = Math.max(worst, Math.abs(got - want));
  }
  return worst;
}

/** Round to significant digits; floating-point noise around zero becomes zero. */
const round = (v: number, sig = 6) => (!Number.isFinite(v) ? v : Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(sig)));

/**
 * Turn a plot reconstruction into data. Pixel points become `digitized`
 * values through the axis calibrations; without a usable calibration, only
 * the model's own readings are used, as `model-estimated`. Neither is ever
 * presented as the original measurement.
 */
export function digitizePlot(plot: PlotOutput): PlotData {
  const warnings: string[] = [];
  const cx = calibrate(plot.xAxis);
  const cy = calibrate(plot.yAxis);
  if (!cx) warnings.push('The x axis has fewer than two usable reference ticks: pixel positions cannot be converted to values.');
  if (!cy) warnings.push('The y axis has fewer than two usable reference ticks: pixel positions cannot be converted to values.');
  for (const [name, axis, c] of [
    ['x', plot.xAxis, cx],
    ['y', plot.yAxis, cy],
  ] as const) {
    if (c && axis.calibration.length > 2) {
      const r = calibrationResidual(axis, c);
      const span = Math.abs(Math.max(...axis.calibration.map((t) => t.value)) - Math.min(...axis.calibration.map((t) => t.value))) || 1;
      if ((axis.scale === 'log' ? r : r / span) > 0.02) warnings.push(`The ${name} axis ticks do not lie on a ${axis.scale} scale (check the calibration or the axis type).`);
    }
  }
  if (plot.plotType === 'contour') warnings.push('Contour plots cannot be digitised into series; only axes and labels were reconstructed.');
  const series = plot.series.map((s, i) => {
    let points: DataPoint[];
    if (cx && cy && s.pixelPoints.length) {
      points = s.pixelPoints.map((p) => {
        const y = toValue(cy, p.py);
        const lo = p.errLowPy !== null ? toValue(cy, p.errLowPy) : null;
        const hi = p.errHighPy !== null ? toValue(cy, p.errHighPy) : null;
        const [errBottom, errTop] = lo !== null && hi !== null ? [Math.min(lo, hi), Math.max(lo, hi)] : [lo, hi];
        return {
          x: round(toValue(cx, p.px)),
          y: round(y),
          xUncertainty: round(halfPixelUncertainty(cx, p.px), 3),
          yUncertainty: round(halfPixelUncertainty(cy, p.py), 3),
          yErrMinus: errBottom !== null ? round(Math.abs(y - errBottom)) : null,
          yErrPlus: errTop !== null ? round(Math.abs(errTop - y)) : null,
          origin: 'digitized' as const,
        };
      });
    } else {
      points = s.estimatedValues.map((v) => ({ x: v.x, y: v.y, xUncertainty: null, yUncertainty: null, yErrMinus: v.yErr, yErrPlus: v.yErr, origin: 'model-estimated' as const }));
      if (points.length) warnings.push(`Series ${s.name ?? i + 1}: values were read off by the model, not measured from pixel positions.`);
    }
    if (plot.xAxis.scale === 'log' && points.some((p) => p.x <= 0)) warnings.push(`Series ${s.name ?? i + 1} has non-positive x values on a log axis.`);
    if (plot.yAxis.scale === 'log' && points.some((p) => p.y <= 0)) warnings.push(`Series ${s.name ?? i + 1} has non-positive y values on a log axis.`);
    points.sort((a, b) => a.x - b.x);
    return { name: s.name ?? `Series ${i + 1}`, points, color: s.color, marker: s.marker, line: s.line };
  });
  return { series, xAxis: plot.xAxis, yAxis: plot.yAxis, warnings: [...warnings, ...plot.warnings] };
}

/** Data supplied by the user (exact values), e.g. from a CSV with x,y[,yerr] columns per series. */
export function exactSeries(name: string, rows: { x: number; y: number; yErr?: number | null }[]): PlotData['series'][number] {
  return {
    name,
    points: rows.map((r) => ({ x: r.x, y: r.y, xUncertainty: null, yUncertainty: null, yErrMinus: r.yErr ?? null, yErrPlus: r.yErr ?? null, origin: 'exact' as const })),
    color: null,
    marker: 'circle',
    line: 'solid',
  };
}
