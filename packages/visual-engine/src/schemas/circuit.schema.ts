import { z } from 'zod';
import { ModelConfidence } from './visual-task.schema';

export const QUANTUM_OP_KINDS = ['gate', 'controlled', 'measure', 'barrier', 'swap', 'reset'] as const;

/** Gate names the generator knows how to draw; anything else must be flagged. */
export const KNOWN_GATES = ['X', 'Y', 'Z', 'H', 'S', 'Sdg', 'T', 'Tdg', 'Rx', 'Ry', 'Rz', 'P', 'U', 'I', 'SX', 'CustomGate'] as const;

export const QuantumOperationSchema = z.object({
  kind: z.enum(QUANTUM_OP_KINDS),
  /** Gate name (`H`, `X`, `Rz`, …); for `controlled` the gate on the target (`X` = CNOT, `Z` = CZ). */
  gate: z.string().max(40).nullable(),
  targets: z.array(z.number().int().min(0)).min(1).max(30),
  controls: z.array(z.number().int().min(0)).max(10),
  /** Gate parameter as written (`\pi/4`, `\theta`). */
  parameter: z.string().max(100).nullable(),
  label: z.string().max(100).nullable(),
  /** Column in the drawing (0-based) when the image shows it; null to place automatically. */
  column: z.number().int().min(0).max(200).nullable(),
  /** Classical bit a measurement writes to. */
  classicalTarget: z.number().int().min(0).nullable(),
  uncertain: z.boolean(),
  confidence: ModelConfidence,
});

export const QuantumCircuitOutputSchema = z.object({
  qubits: z.number().int().min(1).max(30),
  qubitLabels: z.array(z.string().max(60)).max(30),
  classicalBits: z.number().int().min(0).max(30),
  operations: z.array(QuantumOperationSchema).max(500),
  warnings: z.array(z.string().max(500)).max(30),
});
export type QuantumCircuitOutput = z.infer<typeof QuantumCircuitOutputSchema>;
export type QuantumOperation = z.infer<typeof QuantumOperationSchema>;

export interface QuantumCircuit extends QuantumCircuitOutput {
  latex: string;
}

export const ELECTRICAL_COMPONENTS = [
  'resistor',
  'capacitor',
  'inductor',
  'voltage-source',
  'current-source',
  'battery',
  'diode',
  'led',
  'switch',
  'lamp',
  'ammeter',
  'voltmeter',
  'wire',
  'ground',
] as const;

const NodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/);

export const ElectricalCircuitOutputSchema = z.object({
  /** Connection points (nets) with positions in centimetres, y up. */
  nodes: z.array(z.object({ id: NodeId, x: z.number().min(-50).max(50), y: z.number().min(-50).max(50), junction: z.boolean(), label: z.string().max(60).nullable() })).max(200),
  components: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/),
        type: z.enum(ELECTRICAL_COMPONENTS),
        from: NodeId,
        /** Second terminal; null only for `ground`. */
        to: NodeId.nullable(),
        label: z.string().max(60).nullable(),
        value: z.string().max(60).nullable(),
        uncertain: z.boolean(),
      }),
    )
    .max(300),
  warnings: z.array(z.string().max(500)).max(30),
});
export type ElectricalCircuitOutput = z.infer<typeof ElectricalCircuitOutputSchema>;
