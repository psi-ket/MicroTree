import { VisualError } from '../errors/visual-errors';
import type { DiagramOutput, DiagramPatch, SourcePatch } from '../schemas/diagram.schema';

export interface PatchResult<T> {
  value: T;
  /** One line per change, for the version's change description. */
  changes: string[];
  /** Changes to scientific relationships (connections, directions, removals), shown to the user. */
  topologyChanges: string[];
}

/**
 * Apply a refinement to the structure. Only the listed operations happen;
 * everything else, including the user's earlier adjustments, stays as it
 * was. Operations naming unknown IDs fail the whole patch.
 */
export function applyDiagramPatch(d: DiagramOutput, patch: DiagramPatch): PatchResult<DiagramOutput> {
  const out: DiagramOutput = structuredClone(d);
  const changes: string[] = [];
  const topology: string[] = [];
  const need = <T>(v: T | null, what: string): T => {
    if (v === null) throw new VisualError('invalid-structure', `The refinement's ${what} operation has no ${what.split('-')[1]}`);
    return v;
  };
  const index = <T extends { id: string }>(list: T[], id: string | null, what: string): number => {
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) throw new VisualError('invalid-structure', `The refinement refers to an unknown ${what} ${id ?? '(none)'}`);
    return i;
  };
  for (const op of patch.operations) {
    switch (op.op) {
      case 'add-node': {
        const n = need(op.node, 'add-node');
        if (out.nodes.some((x) => x.id === n.id)) throw new VisualError('invalid-structure', `A node ${n.id} already exists`);
        out.nodes.push(n);
        changes.push(`added node ${n.id}`);
        topology.push(`new component ${n.id} (${n.label || n.shape})`);
        break;
      }
      case 'update-node': {
        const n = need(op.node, 'update-node');
        const i = index(out.nodes, op.target ?? n.id, 'node');
        if (n.id !== out.nodes[i]!.id) throw new VisualError('invalid-structure', 'Renaming a node is not allowed (connections refer to it)');
        if (n.label !== out.nodes[i]!.label) topology.push(`label of ${n.id} changed from "${out.nodes[i]!.label}" to "${n.label}"`);
        out.nodes[i] = n;
        changes.push(`changed node ${n.id}`);
        break;
      }
      case 'remove-node': {
        const i = index(out.nodes, op.target, 'node');
        const id = out.nodes[i]!.id;
        out.nodes.splice(i, 1);
        const dropped = out.edges.filter((e) => e.from === id || e.to === id).map((e) => e.id);
        out.edges = out.edges.filter((e) => e.from !== id && e.to !== id);
        changes.push(`removed node ${id}`);
        topology.push(`removed component ${id}${dropped.length ? ` and its connections ${dropped.join(', ')}` : ''}`);
        break;
      }
      case 'add-edge': {
        const e = need(op.edge, 'add-edge');
        if (out.edges.some((x) => x.id === e.id)) throw new VisualError('invalid-structure', `An edge ${e.id} already exists`);
        out.edges.push(e);
        changes.push(`added connection ${e.id}`);
        topology.push(`new connection ${e.from} ${e.arrow} ${e.to}`);
        break;
      }
      case 'update-edge': {
        const e = need(op.edge, 'update-edge');
        const i = index(out.edges, op.target ?? e.id, 'edge');
        const old = out.edges[i]!;
        if (old.from !== e.from || old.to !== e.to || old.arrow !== e.arrow) topology.push(`connection ${old.id} changed from ${old.from} ${old.arrow} ${old.to} to ${e.from} ${e.arrow} ${e.to}`);
        if (old.label !== e.label) topology.push(`label of ${old.id} changed`);
        out.edges[i] = { ...e, id: old.id };
        changes.push(`changed connection ${old.id}`);
        break;
      }
      case 'remove-edge': {
        const i = index(out.edges, op.target, 'edge');
        const e = out.edges[i]!;
        out.edges.splice(i, 1);
        changes.push(`removed connection ${e.id}`);
        topology.push(`removed connection ${e.from} ${e.arrow} ${e.to}`);
        break;
      }
      case 'add-annotation': {
        const a = need(op.annotation, 'add-annotation');
        out.annotations.push(a);
        changes.push(`added annotation ${a.id}`);
        break;
      }
      case 'update-annotation': {
        const a = need(op.annotation, 'update-annotation');
        out.annotations[index(out.annotations, op.target ?? a.id, 'annotation')] = a;
        changes.push(`changed annotation ${a.id}`);
        break;
      }
      case 'remove-annotation': {
        const i = index(out.annotations, op.target, 'annotation');
        changes.push(`removed annotation ${out.annotations[i]!.id}`);
        out.annotations.splice(i, 1);
        break;
      }
      case 'set-style': {
        const s = need(op.style, 'set-style');
        const i = out.styles.findIndex((x) => x.id === s.id);
        if (i === -1) out.styles.push(s);
        else out.styles[i] = s;
        changes.push(`style ${s.id}`);
        break;
      }
      case 'set-title':
        out.title = op.title;
        changes.push('title');
        break;
    }
  }
  return { value: out, changes, topologyChanges: topology };
}

/** Apply exact find/replace edits to hand-edited source. Each `find` must occur exactly once. */
export function applySourcePatch(source: string, patch: SourcePatch): PatchResult<string> {
  let out = source;
  const changes: string[] = [];
  for (const e of patch.edits) {
    const first = out.indexOf(e.find);
    if (first === -1) throw new VisualError('invalid-structure', `The refinement wants to change text that is not in the source: "${e.find.slice(0, 60)}"`);
    if (out.indexOf(e.find, first + 1) !== -1) throw new VisualError('invalid-structure', `The text to change occurs more than once: "${e.find.slice(0, 60)}"`);
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
    changes.push(`replaced "${e.find.slice(0, 40)}"`);
  }
  return { value: out, changes, topologyChanges: [] };
}
