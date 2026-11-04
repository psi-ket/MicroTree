import { z } from 'zod';
import { ColorExpr } from './diagram.schema';

/**
 * Plot reconstruction. Axes carry a calibration: at least two reference
 * ticks, each with its pixel position in the image and its value. Points
 * the model located in the image are pixel coordinates; values the model
 * only read off are separate and marked as model-estimated. Nothing here is
 * the original measured data.
 */
export const AxisSchema = z.object({
  label: z.string().max(200).nullable(),
  unit: z.string().max(60).nullable(),
  scale: z.enum(['linear', 'log']),
  reversed: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** Reference ticks: pixel coordinate along this axis (x for the x axis, y for the y axis) and the value printed there. */
  calibration: z.array(z.object({ pixel: z.number(), value: z.number() })).max(20),
});
export type Axis = z.infer<typeof AxisSchema>;

export const SeriesSchema = z.object({
  name: z.string().max(200).nullable(),
  color: ColorExpr.nullable(),
  marker: z.enum(['none', 'circle', 'square', 'triangle', 'diamond', 'cross', 'plus', 'star']),
  line: z.enum(['solid', 'dashed', 'dotted', 'none']),
  /** Located in the image (pixels, origin top-left), with error-bar ends in pixels when visible. */
  pixelPoints: z.array(z.object({ px: z.number(), py: z.number(), errLowPy: z.number().nullable(), errHighPy: z.number().nullable() })).max(2000),
  /** Values read off by the model where pixel positions were not given. */
  estimatedValues: z.array(z.object({ x: z.number(), y: z.number(), yErr: z.number().nullable() })).max(2000),
});

export const PlotOutputSchema = z.object({
  plotType: z.enum(['line', 'scatter', 'bar', 'histogram', 'contour', 'other']),
  title: z.string().max(300).nullable(),
  xAxis: AxisSchema,
  yAxis: AxisSchema,
  series: z.array(SeriesSchema).max(20),
  legendPosition: z.enum(['north east', 'north west', 'south east', 'south west', 'outer north east', 'none']).nullable(),
  annotations: z.array(z.string().max(300)).max(30),
  warnings: z.array(z.string().max(500)).max(30),
});
export type PlotOutput = z.infer<typeof PlotOutputSchema>;
export type PlotSeries = z.infer<typeof SeriesSchema>;

/** Where a number came from. */
export const DATA_ORIGINS = ['exact', 'digitized', 'model-estimated'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export interface DataPoint {
  x: number;
  y: number;
  /** Half-width of the reading uncertainty (from pixel resolution), in data units. */
  xUncertainty: number | null;
  yUncertainty: number | null;
  yErrMinus: number | null;
  yErrPlus: number | null;
  origin: DataOrigin;
}

export interface PlotData {
  series: { name: string; points: DataPoint[]; color: string | null; marker: PlotSeries['marker']; line: PlotSeries['line'] }[];
  xAxis: Axis;
  yAxis: Axis;
  warnings: string[];
}
