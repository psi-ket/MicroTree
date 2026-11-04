import { checkLatexSafety, type LatexIssue } from '../compile/latex-safety';
import type { ElectricalCircuitOutput } from '../schemas/circuit.schema';

/** Circuitikz bipoles for each component type. */
const BIPOLE: Record<string, string> = {
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  'voltage-source': 'V',
  'current-source': 'I',
  battery: 'battery1',
  diode: 'D',
  led: 'leD',
  switch: 'nos',
  lamp: 'lamp',
  ammeter: 'ammeter',
  voltmeter: 'voltmeter',
  wire: 'short',
};

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export function validateElectricalCircuit(c: ElectricalCircuitOutput): LatexIssue[] {
  const issues: LatexIssue[] = [];
  const nodes = new Set(c.nodes.map((n) => n.id));
  if (nodes.size !== c.nodes.length) issues.push({ severity: 'error', message: 'Two connection points share an ID', at: null });
  const used = new Map<string, number>();
  for (const comp of c.components) {
    if (!nodes.has(comp.from)) issues.push({ severity: 'error', message: `${comp.id} connects to an unknown point ${comp.from}`, at: null });
    if (comp.type !== 'ground' && (!comp.to || !nodes.has(comp.to))) issues.push({ severity: 'error', message: `${comp.id} needs a second connection point`, at: null });
    if (comp.to && comp.to === comp.from) issues.push({ severity: 'error', message: `${comp.id} is connected to itself`, at: null });
    for (const n of [comp.from, comp.to]) if (n) used.set(n, (used.get(n) ?? 0) + 1);
    for (const t of [comp.label ?? '', comp.value ?? '']) issues.push(...checkLatexSafety(t, { maxLength: 200 }));
    if (comp.uncertain) issues.push({ severity: 'warning', message: `${comp.id} (${comp.type}) was not identified with certainty`, at: null });
  }
  for (const n of c.nodes) {
    const k = used.get(n.id) ?? 0;
    if (k === 0) issues.push({ severity: 'warning', message: `Point ${n.id} is not connected to anything`, at: null });
    else if (k === 1) issues.push({ severity: 'warning', message: `Point ${n.id} has only one connection (an open end)`, at: null });
  }
  return issues;
}

/** Circuitikz source: each component as a bipole between its two points, grounds and junction dots as nodes. */
export function generateCircuitikz(c: ElectricalCircuitOutput): string {
  const at = new Map(c.nodes.map((n) => [n.id, `(${fmt(n.x)},${fmt(n.y)})`]));
  const lines = ['\\begin{circuitikz}[american]'];
  for (const comp of c.components) {
    const from = at.get(comp.from) ?? '(0,0)';
    if (comp.type === 'ground') {
      lines.push(`  \\draw ${from} node[ground]{};`);
      continue;
    }
    const opts = [BIPOLE[comp.type] ?? 'short'];
    const label = [comp.label, comp.value].filter(Boolean).join(' = ');
    // Braced: labels may contain commas (thin spaces) that would split the options.
    if (label && comp.type !== 'wire') opts.push(`l={${/\$/.test(label) ? label : `$${label}$`}}`);
    lines.push(`  \\draw ${from} to[${opts.join(', ')}] ${at.get(comp.to ?? '') ?? '(0,0)'};${comp.uncertain ? ' % uncertain in the source image' : ''}`);
  }
  for (const n of c.nodes) {
    if (n.junction) lines.push(`  \\draw ${at.get(n.id)} node[circ]{};`);
    if (n.label) lines.push(`  \\draw ${at.get(n.id)} node[above right]{${n.label}};`);
  }
  lines.push('\\end{circuitikz}');
  return lines.join('\n');
}
