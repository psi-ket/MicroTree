import type { DiagramOutput, ElectricalCircuitOutput, EquationOutput, PlotOutput, QuantumCircuitOutput } from '../../src';

/** Synthetic structured outputs, as a vision model would return them. */
export const eq = (latex: string, environment: EquationOutput['environment'], extra: Partial<EquationOutput> = {}): EquationOutput => ({
  latex,
  environment,
  explanation: null,
  symbolUncertainties: [],
  missingParts: [],
  warnings: [],
  confidence: null,
  ...extra,
});

export const QUBIT_RESONATOR: DiagramOutput = {
  title: 'Transmon coupled to a resonator',
  description: 'A transmon qubit capacitively coupled to a readout resonator, read out through a feedline.',
  nodes: [
    { id: 'qubit', label: 'Transmon $\\omega_q$', shape: 'rounded', x: 0, y: 0, width: 2.4, height: 1, style: 'qs', uncertain: false, note: null },
    { id: 'res', label: 'Resonator $\\omega_r$', shape: 'rectangle', x: 4, y: 0, width: 2.6, height: 1, style: null, uncertain: false, note: null },
    { id: 'feed', label: 'Feedline', shape: 'ellipse', x: 8, y: 0, width: null, height: null, style: null, uncertain: true, note: 'shape unclear' },
    { id: 'junction', label: '', shape: 'point', x: 2, y: -1.5, width: null, height: null, style: null, uncertain: false, note: null },
  ],
  edges: [
    { id: 'e1', from: 'qubit', to: 'res', label: '$g$', arrow: '<->', line: 'solid', bend: null, uncertain: false },
    { id: 'e2', from: 'res', to: 'feed', label: null, arrow: '->', line: 'dashed', bend: 20, uncertain: false },
    { id: 'e3', from: 'qubit', to: 'junction', label: null, arrow: '-', line: 'dotted', bend: null, uncertain: true },
  ],
  annotations: [{ id: 'h', text: '$H = \\hbar g (a^\\dagger \\sigma_- + a \\sigma_+)$', x: 2, y: -2.5, anchor: 'below' }],
  styles: [{ id: 'qs', fill: 'blue!10', draw: 'blue!60!black', lineWidth: 0.8, textColor: null, font: 'bold' }],
  ambiguities: [],
  warnings: [],
};

export const BELL_CIRCUIT: QuantumCircuitOutput = {
  qubits: 3,
  qubitLabels: ['\\ket{0}', '\\ket{0}', '\\ket{0}'],
  classicalBits: 2,
  operations: [
    { kind: 'gate', gate: 'H', targets: [0], controls: [], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'controlled', gate: 'X', targets: [1], controls: [0], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'gate', gate: 'Rz', targets: [2], controls: [], parameter: '\\pi/4', label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'controlled', gate: 'Z', targets: [2], controls: [1], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'controlled', gate: 'X', targets: [2], controls: [0, 1], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'swap', gate: null, targets: [0, 2], controls: [], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'barrier', gate: null, targets: [0], controls: [], parameter: null, label: null, column: null, classicalTarget: null, uncertain: false, confidence: null },
    { kind: 'gate', gate: 'U', targets: [0, 1], controls: [], parameter: null, label: null, column: null, classicalTarget: null, uncertain: true, confidence: 0.4 },
    { kind: 'measure', gate: null, targets: [0], controls: [], parameter: null, label: null, column: null, classicalTarget: 0, uncertain: false, confidence: null },
    { kind: 'measure', gate: null, targets: [1], controls: [], parameter: null, label: null, column: null, classicalTarget: 1, uncertain: false, confidence: null },
  ],
  warnings: [],
};

export const RLC: ElectricalCircuitOutput = {
  nodes: [
    { id: 'a', x: 0, y: 0, junction: false, label: null },
    { id: 'b', x: 0, y: 3, junction: false, label: null },
    { id: 'c', x: 3, y: 3, junction: true, label: 'A' },
    { id: 'd', x: 6, y: 3, junction: false, label: null },
    { id: 'e', x: 6, y: 0, junction: false, label: null },
    { id: 'f', x: 3, y: 0, junction: true, label: null },
  ],
  components: [
    { id: 'V1', type: 'voltage-source', from: 'a', to: 'b', label: 'V_s', value: null, uncertain: false },
    { id: 'R1', type: 'resistor', from: 'b', to: 'c', label: 'R', value: '1\\,\\mathrm{k\\Omega}', uncertain: false },
    { id: 'L1', type: 'inductor', from: 'c', to: 'd', label: 'L', value: null, uncertain: false },
    { id: 'C1', type: 'capacitor', from: 'd', to: 'e', label: 'C', value: null, uncertain: true },
    { id: 'I1', type: 'current-source', from: 'c', to: 'f', label: 'I_0', value: null, uncertain: false },
    { id: 'D1', type: 'diode', from: 'e', to: 'f', label: null, value: null, uncertain: false },
    { id: 'W1', type: 'wire', from: 'f', to: 'a', label: null, value: null, uncertain: false },
    { id: 'G1', type: 'ground', from: 'a', to: null, label: null, value: null, uncertain: false },
  ],
  warnings: [],
};

/** A plot image 400 × 300 px: x from 0 (px 50) to 10 (px 350); y from 0 (px 250) to 100 (px 50). */
export const LINEAR_PLOT: PlotOutput = {
  plotType: 'line',
  title: null,
  xAxis: { label: 'Time', unit: '\\si{\\micro\\second}', scale: 'linear', reversed: false, min: 0, max: 10, calibration: [{ pixel: 50, value: 0 }, { pixel: 350, value: 10 }] },
  yAxis: { label: 'Population', unit: '\\%', scale: 'linear', reversed: false, min: 0, max: 100, calibration: [{ pixel: 250, value: 0 }, { pixel: 50, value: 100 }] },
  series: [
    {
      name: 'Ground state',
      color: 'blue',
      marker: 'circle',
      line: 'solid',
      pixelPoints: [
        { px: 50, py: 50, errLowPy: 55, errHighPy: 45 },
        { px: 110, py: 90, errLowPy: null, errHighPy: null },
        { px: 200, py: 150, errLowPy: 160, errHighPy: 140 },
      ],
      estimatedValues: [],
    },
    { name: 'Excited state', color: 'red', marker: 'square', line: 'dashed', pixelPoints: [{ px: 50, py: 250, errLowPy: null, errHighPy: null }, { px: 200, py: 150, errLowPy: null, errHighPy: null }], estimatedValues: [] },
  ],
  legendPosition: 'north east',
  annotations: [],
  warnings: [],
};

/** y log axis: 1 at px 250, 1000 at px 50; x reversed from 10 (px 50) to 0 (px 350). */
export const LOG_PLOT: PlotOutput = {
  ...LINEAR_PLOT,
  plotType: 'scatter',
  xAxis: { label: 'Energy', unit: 'eV', scale: 'linear', reversed: true, min: null, max: null, calibration: [{ pixel: 50, value: 10 }, { pixel: 350, value: 0 }] },
  yAxis: { label: 'Counts', unit: null, scale: 'log', reversed: false, min: null, max: null, calibration: [{ pixel: 250, value: 1 }, { pixel: 150, value: 31.6227766 }, { pixel: 50, value: 1000 }] },
  series: [{ name: 'Spectrum', color: null, marker: 'triangle', line: 'none', pixelPoints: [{ px: 200, py: 150, errLowPy: null, errHighPy: null }, { px: 50, py: 50, errLowPy: null, errHighPy: null }], estimatedValues: [] }],
};
