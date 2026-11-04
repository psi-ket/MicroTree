import type { VisualArtifactType } from '@research-studio/shared-types';
import { hasErrors, type LatexIssue } from '../compile/latex-safety';
import { standaloneDocument, type StandaloneKind } from '../compile/standalone';
import { generateCircuitikz, validateElectricalCircuit } from '../circuits/circuitikz-generator';
import { generateQuantikz, validateQuantumCircuit } from '../circuits/quantikz-generator';
import { generateTikz, type LayoutMode } from '../diagrams/tikz-generator';
import { validateDiagram } from '../diagrams/tikz-validator';
import { formatEquation, type EquationFormatOptions } from '../equations/equation-formatter';
import { normalizeEquationLatex } from '../equations/equation-normalizer';
import { validateEquation } from '../equations/equation-validator';
import { plotExportCsv, plotTableCsv } from '../plots/csv-generator';
import { generatePgfplots, DEFAULT_PLOT_STYLE, type PlotStyle } from '../plots/pgfplots-generator';
import { digitizePlot } from '../plots/plot-digitizer';
import type { ElectricalCircuitOutput, QuantumCircuitOutput } from '../schemas/circuit.schema';
import type { DiagramOutput } from '../schemas/diagram.schema';
import type { EquationOutput } from '../schemas/equation.schema';
import type { PlotData, PlotOutput } from '../schemas/plot.schema';
import type { FigureExplanation } from '../schemas/visual-task.schema';

/**
 * What an artifact version holds: the editable source, the structure it was
 * generated from, data for plots, required packages and every warning and
 * validation issue. Builders are deterministic: the same structure always
 * gives the same source.
 */
export interface ArtifactPayload {
  artifactType: VisualArtifactType;
  title: string;
  sourceCode: string;
  structuredData: Record<string, unknown>;
  /** The CSV PGFPlots reads (plots only). */
  dataCsv: string | null;
  packages: string[];
  warnings: string[];
  issues: LatexIssue[];
  /** How to compile it for preview. */
  compile: { kind: StandaloneKind; files: Record<string, string> } | null;
}

const issueWarnings = (issues: LatexIssue[]) => issues.filter((i) => i.severity === 'warning').map((i) => i.message);

export function buildEquation(out: EquationOutput, opts: EquationFormatOptions = {}): ArtifactPayload {
  const { latex, notes } = normalizeEquationLatex(out.latex);
  const issues = validateEquation(latex, out.environment);
  const source = formatEquation(latex, out.environment, opts);
  const warnings = [
    ...notes,
    ...out.warnings,
    ...out.missingParts.map((m) => `Missing or illegible: ${m}`),
    ...out.symbolUncertainties.map((u) => `Uncertain at ${u.location}: ${u.alternatives.length ? `could be ${u.alternatives.join(', ')}` : 'unclear'} (${u.reason})`),
    ...issueWarnings(issues),
  ];
  const { packages } = standaloneDocument(source, 'math');
  return {
    artifactType: 'equation',
    title: out.explanation?.slice(0, 80) || 'Equation',
    sourceCode: source,
    structuredData: { ...out, latex, kind: 'equation', formatOptions: opts },
    dataCsv: null,
    packages,
    warnings,
    issues,
    compile: hasErrors(issues) ? null : { kind: 'math', files: {} },
  };
}

export function buildDiagram(out: DiagramOutput, layout: LayoutMode = 'preserve'): ArtifactPayload {
  const issues = validateDiagram(out);
  const source = hasErrors(issues) ? '' : generateTikz(out, layout);
  const { packages } = standaloneDocument(source || '\\begin{tikzpicture}\\end{tikzpicture}', 'picture');
  return {
    artifactType: 'diagram',
    title: out.title ?? 'Diagram',
    sourceCode: source,
    structuredData: { ...out, kind: 'diagram', layout },
    dataCsv: null,
    packages,
    warnings: [...out.warnings, ...out.ambiguities.map((a) => `Ambiguous: ${a}`), ...issueWarnings(issues)],
    issues,
    compile: source ? { kind: 'picture', files: {} } : null,
  };
}

export function buildQuantumCircuit(out: QuantumCircuitOutput): ArtifactPayload {
  const issues = validateQuantumCircuit(out);
  const source = hasErrors(issues) ? '' : generateQuantikz(out);
  return {
    artifactType: 'quantum-circuit',
    title: `Quantum circuit (${out.qubits} qubit${out.qubits === 1 ? '' : 's'})`,
    sourceCode: source,
    structuredData: { ...out, kind: 'quantum-circuit' },
    dataCsv: null,
    packages: ['tikz', 'quantikz', 'braket'],
    warnings: [...out.warnings, ...issueWarnings(issues)],
    issues,
    compile: source ? { kind: 'picture', files: {} } : null,
  };
}

export function buildElectricalCircuit(out: ElectricalCircuitOutput): ArtifactPayload {
  const issues = validateElectricalCircuit(out);
  const source = hasErrors(issues) ? '' : generateCircuitikz(out);
  return {
    artifactType: 'electrical-circuit',
    title: 'Circuit',
    sourceCode: source,
    structuredData: { ...out, kind: 'electrical-circuit' },
    dataCsv: null,
    packages: ['tikz', 'circuitikz'],
    warnings: [...out.warnings, ...issueWarnings(issues)],
    issues,
    compile: source ? { kind: 'picture', files: {} } : null,
  };
}

export const PREVIEW_DATA_FILE = 'plot-data.csv';

/** A plot from data (digitised from an image, estimated, or exact) with a style that never touches the data. */
export function buildPlotFromData(data: PlotData, style: PlotStyle, extra: { reconstruction?: PlotOutput; title?: string } = {}): ArtifactPayload {
  const csv = plotTableCsv(data);
  const source = generatePgfplots(data, PREVIEW_DATA_FILE, style);
  const origins = new Set(data.series.flatMap((s) => s.points.map((p) => p.origin)));
  const warnings = [...data.warnings];
  if (origins.has('digitized')) warnings.push('Values were digitised from the image: they are approximations within the stated uncertainty, not the original data.');
  if (origins.has('model-estimated')) warnings.push('Some values were estimated by the model by eye; check them against the image.');
  if (!data.series.some((s) => s.points.length)) warnings.push('No data points were extracted.');
  return {
    artifactType: 'plot',
    title: extra.title ?? style.title ?? data.yAxis.label ?? 'Plot',
    sourceCode: source,
    structuredData: { kind: 'plot', data, style, reconstruction: extra.reconstruction ?? null, exportCsv: plotExportCsv(data) },
    dataCsv: csv,
    packages: ['tikz', 'pgfplots'],
    warnings,
    issues: [],
    compile: { kind: 'picture', files: { [PREVIEW_DATA_FILE]: csv } },
  };
}

export function buildPlot(out: PlotOutput, style: Partial<PlotStyle> = {}): ArtifactPayload {
  const data = digitizePlot(out);
  const plotType = out.plotType === 'scatter' || out.plotType === 'bar' || out.plotType === 'histogram' ? out.plotType : 'line';
  return buildPlotFromData(data, { ...DEFAULT_PLOT_STYLE, plotType, title: out.title, legend: out.legendPosition ?? 'north east', ...style }, { reconstruction: out });
}

export function buildExplanation(out: FigureExplanation): ArtifactPayload {
  const caption = out.caption.trim();
  return {
    artifactType: 'explanation',
    title: caption.slice(0, 80) || 'Figure explanation',
    sourceCode: caption ? `\\caption{${caption}}` : '',
    structuredData: { ...out, kind: 'explanation' },
    dataCsv: null,
    packages: [],
    warnings: [...out.uncertainties, ...(out.interpretation.length ? ['Interpretations are the model’s reading of the figure, not observations; check them.'] : [])],
    issues: [],
    compile: null,
  };
}

/** Rebuild a payload for hand-edited source (no regeneration from structure). */
export function payloadForSource(type: VisualArtifactType, source: string, previous: { structuredData: Record<string, unknown> | null; dataCsv: string | null; title: string }): ArtifactPayload {
  const kind: StandaloneKind = type === 'equation' ? 'math' : 'picture';
  const issues = type === 'equation' ? validateEquation(source, 'custom') : [];
  const { packages } = standaloneDocument(source, kind);
  return {
    artifactType: type,
    title: previous.title,
    sourceCode: source,
    structuredData: { ...(previous.structuredData ?? {}), sourceEdited: true },
    dataCsv: previous.dataCsv,
    packages,
    warnings: issueWarnings(issues),
    issues,
    compile: type === 'explanation' ? null : { kind, files: previous.dataCsv ? { [PREVIEW_DATA_FILE]: previous.dataCsv } : {} },
  };
}
