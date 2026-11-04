import { checkLatexSafety, type LatexIssue } from '../compile/latex-safety';
import type { DiagramOutput } from '../schemas/diagram.schema';

/** Topology and label checks before TikZ is generated. Problems are reported, never fixed silently. */
export function validateDiagram(d: DiagramOutput): LatexIssue[] {
  const issues: LatexIssue[] = [];
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (ids.has(n.id)) issues.push({ severity: 'error', message: `Two nodes share the ID ${n.id}`, at: null });
    ids.add(n.id);
  }
  const styleIds = new Set(d.styles.map((s) => s.id));
  for (const n of d.nodes) if (n.style && !styleIds.has(n.style)) issues.push({ severity: 'warning', message: `Node ${n.id} uses an undefined style ${n.style}`, at: null });
  const edgeIds = new Set<string>();
  for (const e of d.edges) {
    if (edgeIds.has(e.id)) issues.push({ severity: 'error', message: `Two edges share the ID ${e.id}`, at: null });
    edgeIds.add(e.id);
    if (!ids.has(e.from)) issues.push({ severity: 'error', message: `Edge ${e.id} starts at an unknown node ${e.from}`, at: null });
    if (!ids.has(e.to)) issues.push({ severity: 'error', message: `Edge ${e.id} ends at an unknown node ${e.to}`, at: null });
  }
  for (const text of [...d.nodes.map((n) => n.label), ...d.edges.map((e) => e.label ?? ''), ...d.annotations.map((a) => a.text)]) {
    for (const i of checkLatexSafety(text, { maxLength: 1000 })) issues.push({ ...i, message: `Label "${text.slice(0, 30)}": ${i.message}` });
    if (/(^|[^\\])[{}]/.test(text.replace(/\\[{}]/g, '')) && (text.match(/(?<!\\)\{/g)?.length ?? 0) !== (text.match(/(?<!\\)\}/g)?.length ?? 0)) {
      issues.push({ severity: 'error', message: `Label "${text.slice(0, 30)}" has unbalanced braces`, at: null });
    }
    if (((text.match(/(?<!\\)\$/g)?.length ?? 0) % 2) === 1) issues.push({ severity: 'error', message: `Label "${text.slice(0, 30)}" has an unclosed $`, at: null });
  }
  const uncertain = d.nodes.filter((n) => n.uncertain).length + d.edges.filter((e) => e.uncertain).length;
  if (uncertain) issues.push({ severity: 'warning', message: `${uncertain} components or connections are uncertain (drawn dashed)`, at: null });
  return issues;
}
