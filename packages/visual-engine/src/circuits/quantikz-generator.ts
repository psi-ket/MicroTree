import type { LatexIssue } from '../compile/latex-safety';
import { checkLatexSafety } from '../compile/latex-safety';
import { KNOWN_GATES, type QuantumCircuitOutput, type QuantumOperation } from '../schemas/circuit.schema';

/** Index and consistency checks for a quantum circuit. */
export function validateQuantumCircuit(c: QuantumCircuitOutput): LatexIssue[] {
  const issues: LatexIssue[] = [];
  const err = (message: string) => issues.push({ severity: 'error', message, at: null });
  if (c.qubitLabels.length && c.qubitLabels.length !== c.qubits) issues.push({ severity: 'warning', message: `${c.qubitLabels.length} wire labels for ${c.qubits} qubits`, at: null });
  c.operations.forEach((op, i) => {
    const where = `Operation ${i + 1} (${op.gate ?? op.kind})`;
    const wires = [...op.targets, ...op.controls];
    for (const q of wires) if (q < 0 || q >= c.qubits) err(`${where} uses qubit ${q}, but the circuit has qubits 0 to ${c.qubits - 1}`);
    if (new Set(wires).size !== wires.length) err(`${where} uses the same qubit as control and target, or twice`);
    if (op.kind === 'controlled' && !op.controls.length) err(`${where} is controlled but has no control qubit`);
    if (op.kind !== 'controlled' && op.controls.length) err(`${where} lists controls but is not a controlled operation`);
    if (op.kind === 'swap' && op.targets.length !== 2) err(`${where}: a SWAP acts on exactly two qubits`);
    if (op.kind === 'measure') {
      if (op.classicalTarget !== null && op.classicalTarget >= c.classicalBits) err(`${where} writes to classical bit ${op.classicalTarget}, but there are ${c.classicalBits}`);
      if (op.targets.length !== 1) err(`${where}: measure one qubit per operation`);
    }
    if ((op.kind === 'gate' || op.kind === 'controlled') && op.gate && !(KNOWN_GATES as readonly string[]).includes(op.gate) && !op.label) {
      issues.push({ severity: 'warning', message: `${where}: "${op.gate}" is not a standard gate name; check it`, at: null });
    }
    if (op.kind === 'gate' && op.targets.length > 1) {
      const sorted = [...op.targets].sort((a, b) => a - b);
      if (sorted.at(-1)! - sorted[0]! + 1 !== sorted.length) err(`${where}: a multi-qubit gate must act on adjacent qubits to be drawn as one box`);
    }
    if (op.uncertain) issues.push({ severity: 'warning', message: `${where} was not identified with certainty`, at: null });
    for (const t of [op.gate ?? '', op.parameter ?? '', op.label ?? '']) for (const x of checkLatexSafety(t, { maxLength: 200 })) issues.push(x);
  });
  for (const l of c.qubitLabels) for (const x of checkLatexSafety(l, { maxLength: 200 })) issues.push(x);
  return issues;
}

/** Assign drawing columns: given columns first, then greedy layering so operations on shared wires keep their order. */
export function scheduleColumns(c: QuantumCircuitOutput): number[] {
  const free = new Array<number>(c.qubits).fill(0);
  return c.operations.map((op) => {
    const span = op.kind === 'barrier' ? Array.from({ length: c.qubits }, (_, i) => i) : rangeOf(op);
    const earliest = Math.max(...span.map((q) => free[q] ?? 0));
    const col = op.column !== null ? Math.max(op.column, earliest) : earliest;
    for (const q of span) free[q] = col + 1;
    return col;
  });
}

function rangeOf(op: QuantumOperation): number[] {
  const wires = [...op.targets, ...op.controls];
  const lo = Math.min(...wires);
  const hi = Math.max(...wires);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

const GATE_TEXT: Record<string, string> = { Sdg: 'S^\\dagger', Tdg: 'T^\\dagger', SX: '\\sqrt{X}', Rx: 'R_x', Ry: 'R_y', Rz: 'R_z' };

function gateText(op: QuantumOperation): string {
  const name = op.label ?? op.gate ?? 'U';
  const text = GATE_TEXT[name] ?? name;
  return op.parameter ? `${text}(${op.parameter})` : text;
}

/**
 * Quantikz source (one row per qubit, `\qw` wires, explicit columns):
 * single gates as `\gate{}`, adjacent multi-qubit gates as
 * `\gate[wires=n]{}`, controls as `\ctrl{offset}` (CNOT target `\targ{}`,
 * CZ `\control{}`), swaps as `\swap{offset}`/`\targX{}`, measurements as
 * `\meter{}` followed by classical wires, barriers as `\slice{}`.
 */
export function generateQuantikz(c: QuantumCircuitOutput): string {
  const cols = scheduleColumns(c);
  const width = Math.max(1, ...cols.map((x) => x + 1));
  const grid: string[][] = Array.from({ length: c.qubits }, () => new Array<string>(width).fill('\\qw'));
  const measured = new Array<number>(c.qubits).fill(Infinity);
  c.operations.forEach((op, i) => {
    const col = cols[i]!;
    const top = Math.min(...op.targets);
    switch (op.kind) {
      case 'gate': {
        if (op.targets.length === 1) grid[top]![col] = `\\gate{${gateText(op)}}`;
        else {
          grid[top]![col] = `\\gate[wires=${op.targets.length}]{${gateText(op)}}`;
          for (const q of op.targets) if (q !== top) grid[q]![col] = '';
        }
        break;
      }
      case 'controlled': {
        const target = op.targets[0]!;
        const isX = (op.gate ?? 'X') === 'X' && !op.label;
        const isZ = op.gate === 'Z' && !op.label;
        grid[target]![col] = isX ? '\\targ{}' : isZ ? '\\control{}' : `\\gate{${gateText(op)}}`;
        for (const ctl of op.controls) grid[ctl]![col] = `\\ctrl{${target - ctl}}`;
        break;
      }
      case 'swap': {
        const [a, b] = [...op.targets].sort((x, y) => x - y) as [number, number];
        grid[a]![col] = `\\swap{${b - a}}`;
        grid[b]![col] = '\\targX{}';
        break;
      }
      case 'measure':
        grid[top]![col] = op.label ? `\\meter{${op.label}}` : '\\meter{}';
        measured[top] = Math.min(measured[top]!, col);
        break;
      case 'reset':
        grid[top]![col] = '\\gate{\\ket{0}}';
        break;
      case 'barrier':
        grid[0]![col] = `\\slice{${op.label ?? ''}}`;
        break;
    }
  });
  // After a measurement a wire carries a classical value.
  for (let q = 0; q < c.qubits; q++) for (let col = measured[q]! + 1; col < width; col++) if (grid[q]![col] === '\\qw') grid[q]![col] = '\\cw';
  const rows = grid.map((row, q) => {
    // Wire labels are text mode in Quantikz (gate labels are math mode).
    const raw = c.qubitLabels[q] ?? `\\ket{q_{${q}}}`;
    const label = raw.includes('$') ? raw : `$${raw}$`;
    const last = measured[q] !== Infinity ? '\\cw' : '\\qw';
    return `  \\lstick{${label}} & ${row.join(' & ')} & ${last}`;
  });
  return `\\begin{quantikz}\n${rows.join(' \\\\\n')}\n\\end{quantikz}`;
}
