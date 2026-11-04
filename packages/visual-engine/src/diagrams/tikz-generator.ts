import type { DiagramEdge, DiagramNode, DiagramOutput, DiagramStyle } from '../schemas/diagram.schema';

export const LAYOUT_MODES = ['preserve', 'improve', 'publication', 'alternative'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

function styleKeys(s: DiagramStyle, mode: LayoutMode): string[] {
  if (mode === 'publication') return [s.lineWidth ? `line width=${fmt(s.lineWidth)}pt` : null, s.font === 'bold' ? 'font=\\bfseries' : s.font === 'italic' ? 'font=\\itshape' : null].filter((x): x is string => !!x);
  return [
    s.fill && s.fill !== 'none' ? `fill=${s.fill}` : null,
    s.draw ? `draw=${s.draw}` : null,
    s.lineWidth ? `line width=${fmt(s.lineWidth)}pt` : null,
    s.textColor ? `text=${s.textColor}` : null,
    s.font === 'small' ? 'font=\\small' : s.font === 'large' ? 'font=\\large' : s.font === 'bold' ? 'font=\\bfseries' : s.font === 'italic' ? 'font=\\itshape' : null,
  ].filter((x): x is string => !!x);
}

const SHAPE: Record<DiagramNode['shape'], string> = {
  rectangle: 'draw, rectangle',
  rounded: 'draw, rectangle, rounded corners=3pt',
  circle: 'draw, circle',
  ellipse: 'draw, ellipse',
  diamond: 'draw, diamond, aspect=1.6',
  point: 'circle, fill, inner sep=1.4pt',
  text: 'inner sep=2pt',
  cylinder: 'draw, cylinder, shape border rotate=90, aspect=0.25',
};

/**
 * Layout options. `preserve` keeps the reconstructed positions; `improve`
 * snaps them to a 0.5 cm grid and removes overlaps; `publication` also uses
 * a monochrome style; `alternative` lays nodes out in layers following the
 * edge directions. Topology (nodes, edges, directions, labels) never changes.
 */
export function layoutDiagram(d: DiagramOutput, mode: LayoutMode): DiagramOutput {
  if (mode === 'preserve') return d;
  let nodes = d.nodes.map((n) => ({ ...n }));
  if (mode === 'alternative') {
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of d.edges) if (e.from !== e.to) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const layer = new Map<string, number>();
    const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
    for (const id of queue) layer.set(id, 0);
    const remaining = new Map(indeg);
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of d.edges.filter((x) => x.from === id && x.to !== id)) {
        layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1));
        remaining.set(e.to, (remaining.get(e.to) ?? 1) - 1);
        if (remaining.get(e.to) === 0) queue.push(e.to);
      }
    }
    const rows = new Map<number, number>();
    nodes = nodes.map((n) => {
      const l = layer.get(n.id) ?? 0; // nodes in cycles stay in the first layer
      const row = rows.get(l) ?? 0;
      rows.set(l, row + 1);
      return { ...n, x: l * 3, y: -row * 1.8 };
    });
  } else {
    const snap = (v: number) => Math.round(v * 2) / 2;
    nodes = nodes.map((n) => ({ ...n, x: snap(n.x), y: snap(n.y) }));
    // Separate nodes that landed on the same grid point.
    const seen = new Set<string>();
    for (const n of nodes) {
      while (seen.has(`${n.x},${n.y}`)) n.x += 1;
      seen.add(`${n.x},${n.y}`);
    }
  }
  return { ...d, nodes };
}

function nodeLine(n: DiagramNode, styles: Map<string, DiagramStyle>, mode: LayoutMode): string {
  const opts = [SHAPE[n.shape]];
  if (n.width && n.shape !== 'point') opts.push(`minimum width=${fmt(n.width)}cm`);
  if (n.height && n.shape !== 'point') opts.push(`minimum height=${fmt(n.height)}cm`);
  if (n.style && styles.has(n.style)) opts.push(`st-${n.style}`);
  if (n.uncertain && mode !== 'publication') opts.push('dashed');
  const label = n.shape === 'point' ? '' : n.label;
  return `  \\node[${opts.join(', ')}] (${n.id}) at (${fmt(n.x)},${fmt(n.y)}) {${label}};${n.uncertain ? ' % uncertain in the source image' : ''}`;
}

function edgeLine(e: DiagramEdge, mode: LayoutMode): string {
  const opts: string[] = [];
  if (e.arrow !== '-') opts.push(e.arrow);
  if (e.line === 'dashed' || (e.uncertain && mode !== 'publication')) opts.push('dashed');
  if (e.line === 'dotted') opts.push('dotted');
  if (e.line === 'thick') opts.push('thick');
  const path = e.from === e.to ? 'to[loop above]' : e.bend ? `to[bend ${e.bend > 0 ? 'left' : 'right'}=${Math.abs(Math.round(e.bend))}]` : '--';
  const label = e.label ? ` node[midway, auto, font=\\small] {${e.label}}` : '';
  return `  \\draw${opts.length ? `[${opts.join(', ')}]` : ''} (${e.from}) ${path}${label} (${e.to});${e.uncertain ? ' % uncertain in the source image' : ''}`;
}

/** TikZ source for a diagram: one node per node, one path per edge, styles as named TikZ styles. */
export function generateTikz(diagram: DiagramOutput, mode: LayoutMode = 'preserve'): string {
  const d = layoutDiagram(diagram, mode);
  const styles = new Map(d.styles.map((s) => [s.id, s]));
  const styleDefs = d.styles.map((s) => `  st-${s.id}/.style={${styleKeys(s, mode).join(', ')}},`);
  const lines = [
    `\\begin{tikzpicture}[>=Stealth, every node/.style={align=center}${styleDefs.length ? ',\n' + styleDefs.join('\n').replace(/,$/, '') : ''}]`,
  ];
  if (d.title) lines.push(`  % ${d.title.replace(/\n/g, ' ')}`);
  for (const n of d.nodes) lines.push(nodeLine(n, styles, mode));
  for (const e of d.edges) lines.push(edgeLine(e, mode));
  for (const a of d.annotations) lines.push(`  \\node[${a.anchor === 'center' ? 'anchor=center' : a.anchor}] at (${fmt(a.x)},${fmt(a.y)}) {${a.text}};`);
  lines.push('\\end{tikzpicture}');
  return lines.join('\n');
}
