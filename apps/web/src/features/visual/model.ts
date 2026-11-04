import { RuntimeApiError, type ArtifactVersion, type VisualAsset, type VisualTask } from '@research-studio/api-contracts';
import type { VisualTaskType } from '@research-studio/shared-types';

/** Task modes offered in the selector, in the order shown. */
export const TASK_OPTIONS: { value: VisualTaskType; label: string; hint: string }[] = [
  { value: 'auto', label: 'Detect automatically', hint: 'The model decides; you are asked when it is not sure' },
  { value: 'equation', label: 'Printed equation', hint: 'LaTeX with the matching environment' },
  { value: 'handwritten-equation', label: 'Handwritten equation', hint: 'Uncertain symbols are listed' },
  { value: 'derivation', label: 'Derivation', hint: 'Several aligned steps' },
  { value: 'diagram', label: 'Diagram', hint: 'TikZ from a structured model' },
  { value: 'quantum-circuit', label: 'Quantum circuit', hint: 'Quantikz' },
  { value: 'electrical-circuit', label: 'Electrical circuit', hint: 'Circuitikz' },
  { value: 'plot', label: 'Plot', hint: 'PGFPlots and CSV, digitised from the axes' },
  { value: 'explanation', label: 'Explain figure', hint: 'Observations kept apart from interpretation' },
  { value: 'caption', label: 'Caption', hint: 'A draft caption' },
  { value: 'text-to-diagram', label: 'Diagram from text', hint: 'No image; describe the diagram' },
];

export const TASK_LABEL: Record<VisualTaskType, string> = Object.fromEntries(TASK_OPTIONS.map((o) => [o.value, o.label])) as Record<VisualTaskType, string>;

export const LAYOUTS = [
  { value: 'preserve', label: 'Keep the layout of the image' },
  { value: 'improve', label: 'Tidy the layout' },
  { value: 'publication', label: 'Publication style' },
  { value: 'alternative', label: 'Alternative layout' },
] as const;

export type LayoutMode = (typeof LAYOUTS)[number]['value'];

export const needsImage = (t: VisualTaskType) => t !== 'text-to-diagram';

export const isFinished = (t: Pick<VisualTask, 'status'>) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';

export const STATUS_TEXT: Record<VisualTask['status'], string> = {
  queued: 'Waiting',
  running: 'Working',
  needs_input: 'Needs your choice',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const COMPILE_TEXT: Record<ArtifactVersion['compilationStatus'], { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  'not-compiled': { label: 'Not compiled', tone: 'neutral' },
  compiling: { label: 'Compiling', tone: 'neutral' },
  succeeded: { label: 'Compiled', tone: 'success' },
  failed: { label: 'Compile failed', tone: 'danger' },
  invalid: { label: 'Refused', tone: 'danger' },
};

export const ORIGIN_TEXT: Record<ArtifactVersion['origin'], string> = {
  model: 'Model',
  manual: 'Your edit',
  refinement: 'Refinement',
  restore: 'Restored',
  calibration: 'Recalibrated',
};

/** What a cloud task will send, from the runtime's CONSENT_REQUIRED refusal. */
export interface ConsentRequest {
  message: string;
  provider: string;
  model: string;
  imageBytes: number | null;
  imageSize: string | null;
  estimatedImageTokens: number | null;
}

export function consentRequest(err: unknown): ConsentRequest | null {
  if (!(err instanceof RuntimeApiError) || err.status !== 409) return null;
  const d = err.details as Record<string, unknown> | undefined;
  if (d?.reason !== 'CONSENT_REQUIRED') return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    message: err.message,
    provider: String(d.provider ?? 'the provider'),
    model: String(d.model ?? ''),
    imageBytes: num(d.imageBytes),
    imageSize: typeof d.imageSize === 'string' ? d.imageSize : null,
    estimatedImageTokens: num(d.estimatedImageTokens),
  };
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Where an image came from, in words. */
export function provenanceText(asset: Pick<VisualAsset, 'provenance' | 'operations' | 'kind'>): string {
  const p = asset.provenance;
  let base: string;
  switch (p.source) {
    case 'upload':
      base = p.fileName ? `Uploaded ${p.fileName}` : 'Uploaded image';
      break;
    case 'clipboard':
      base = 'Pasted image';
      break;
    case 'project-file':
      base = `Project file ${p.path}`;
      break;
    case 'pdf-region':
      base = `PDF page ${p.pageNumber}, region ${Math.round(p.region.width)}×${Math.round(p.region.height)} pt`;
      break;
    case 'generated':
      base = p.description;
      break;
  }
  if (asset.kind === 'variant' && asset.operations.length) base += ` · ${asset.operations.map((o) => o.op).join(', ')}`;
  return base;
}

/**
 * A rectangle dragged on a rendered PDF page (CSS pixels at `scale`) in PDF
 * points of the unrotated page, top-left origin: the coordinates M3.3 uses
 * for passages, so the crop can be found again on the page.
 */
export function regionInPoints(rect: { x: number; y: number; width: number; height: number }, scale: number, page: { width: number; height: number }) {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const x = clamp(rect.width < 0 ? rect.x + rect.width : rect.x, page.width * scale) / scale;
  const y = clamp(rect.height < 0 ? rect.y + rect.height : rect.y, page.height * scale) / scale;
  const width = Math.min(Math.abs(rect.width) / scale, page.width - x);
  const height = Math.min(Math.abs(rect.height) / scale, page.height - y);
  return { x: round(x), y: round(y), width: round(width), height: round(height), pageWidth: round(page.width), pageHeight: round(page.height) };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** The observation/interpretation split of a figure explanation, if the version holds one. */
export interface Explanation {
  observations: { kind: string; text: string }[];
  visibleLabels: string[];
  interpretation: string[];
  caption: string;
  uncertainties: string[];
}

export function explanationOf(v: Pick<ArtifactVersion, 'structuredData'> | null | undefined): Explanation | null {
  const d = v?.structuredData as Partial<Explanation> & { kind?: string } | null | undefined;
  if (!d || d.kind !== 'explanation') return null;
  return { observations: d.observations ?? [], visibleLabels: d.visibleLabels ?? [], interpretation: d.interpretation ?? [], caption: d.caption ?? '', uncertainties: d.uncertainties ?? [] };
}

/** Plot settings stored on a version (style, axes), if it is a plot made from data. */
export interface PlotAxis {
  label: string | null;
  unit: string | null;
  scale: 'linear' | 'log';
  reversed: boolean;
  calibration: { pixel: number; value: number }[];
}

export interface PlotSettings {
  style: { width: string; height: string; grid: 'none' | 'major' | 'both'; monochrome: boolean; legend: 'north east' | 'north west' | 'south east' | 'south west' | 'outer north east' | 'none'; plotType: 'line' | 'scatter' | 'bar' | 'histogram'; title: string | null };
  xAxis: PlotAxis;
  yAxis: PlotAxis;
  canRecalibrate: boolean;
  origins: string[];
}

export function plotSettingsOf(v: Pick<ArtifactVersion, 'structuredData'> | null | undefined): PlotSettings | null {
  const d = v?.structuredData as { kind?: string; style?: PlotSettings['style']; data?: { xAxis: PlotAxis; yAxis: PlotAxis; series: { points: { origin: string }[] }[] }; reconstruction?: { xAxis: PlotAxis; yAxis: PlotAxis } | null } | null | undefined;
  if (!d || d.kind !== 'plot' || !d.data || !d.style) return null;
  const axes = d.reconstruction ?? d.data;
  return {
    style: d.style,
    xAxis: axes.xAxis,
    yAxis: axes.yAxis,
    canRecalibrate: !!d.reconstruction,
    origins: [...new Set(d.data.series.flatMap((s) => s.points.map((p) => p.origin)))],
  };
}

/** Wording for refinement presets (sent as instructions to the model). */
export const PRESETS: { id: string; label: string; instruction: string }[] = [
  { id: 'simplify', label: 'Simplify', instruction: 'Simplify: remove decoration and redundant elements, keep every scientific element and label.' },
  { id: 'style-publication', label: 'Publication style', instruction: 'Change the style for a journal figure: black and grey, thin lines, consistent font sizes. Do not change the content.' },
  { id: 'style-color', label: 'Colour-blind safe', instruction: 'Change the colours to a colour-blind safe palette. Do not change the content.' },
];

export function errorText(err: unknown): string {
  if (err instanceof RuntimeApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
