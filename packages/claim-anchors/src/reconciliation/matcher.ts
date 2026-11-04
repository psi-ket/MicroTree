import { containment, normalizeForIdentity, similarity } from '../hashing/text-hash';

/** Something with an identity in the previous version, or a candidate in the new one. */
export interface MatchItem {
  ref: string;
  file: string;
  /** Position in the manuscript (0..1 after normalising by count). */
  order: number;
  hash: string;
  text: string;
  prefix: string;
  suffix: string;
}

export type MatchKind = 'exact' | 'similar' | 'split' | 'merge';

export interface MatchPair {
  prev: string;
  next: string;
  kind: MatchKind;
  similarity: number;
}

export interface MatchResult {
  pairs: MatchPair[];
  /** Previous items that could correspond to several new ones (never merged, never called deleted). */
  ambiguousPrev: Set<string>;
  ambiguousNext: Set<string>;
}

export interface MatchOptions {
  /** Minimum token similarity for a `similar` match. */
  threshold: number;
  /** Minimum containment for a split or merge. */
  containment: number;
}

const EPS = 1e-9;

function contextScore(a: MatchItem, b: MatchItem, prevCount: number, nextCount: number): number {
  const side = (x: string, y: string) => (x && x === y ? 2 : x || y ? similarity(x, y) : 1);
  const pos = Math.abs(a.order / Math.max(1, prevCount) - b.order / Math.max(1, nextCount));
  return side(a.prefix, b.prefix) + side(a.suffix, b.suffix) + (a.file === b.file ? 1 : 0) - pos;
}

/**
 * Pair previous items with new ones. Exact hash matches first; identical
 * duplicates in the same numbers keep their order, otherwise context
 * (neighbours, file, position) decides, and a tie is reported as ambiguous
 * rather than guessed. Then similar texts, then splits and merges.
 */
export function matchItems(prev: readonly MatchItem[], next: readonly MatchItem[], opts: MatchOptions): MatchResult {
  const pairs: MatchPair[] = [];
  const usedPrev = new Set<string>();
  const usedNext = new Set<string>();
  const ambiguousPrev = new Set<string>();
  const ambiguousNext = new Set<string>();

  const group = <T extends MatchItem>(xs: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.hash, [...(m.get(x.hash) ?? []), x]);
    return m;
  };
  const prevByHash = group(prev);
  const nextByHash = group(next);

  for (const [hash, ns] of nextByHash) {
    const ps = prevByHash.get(hash);
    if (!ps) continue;
    if (ps.length === ns.length) {
      // Same number of identical copies: keep their order.
      const sp = [...ps].sort((a, b) => a.order - b.order);
      const sn = [...ns].sort((a, b) => a.order - b.order);
      sp.forEach((p, i) => {
        pairs.push({ prev: p.ref, next: sn[i]!.ref, kind: 'exact', similarity: 1 });
        usedPrev.add(p.ref);
        usedNext.add(sn[i]!.ref);
      });
      continue;
    }
    // Different numbers of copies: pair by context, report ties instead of guessing.
    const best = (n: MatchItem) =>
      ps
        .filter((p) => !usedPrev.has(p.ref))
        .map((p) => ({ p, s: contextScore(p, n, prev.length, next.length) }))
        .sort((x, y) => y.s - x.s);
    const order = [...ns].sort((x, y) => (best(y)[0]?.s ?? -Infinity) - (best(x)[0]?.s ?? -Infinity));
    for (const n of order) {
      const ranked = best(n);
      const top = ranked[0];
      if (!top) break;
      // Another new copy that fits this previous item exactly as well?
      const rivalNext = ns.some((m) => m !== n && !usedNext.has(m.ref) && Math.abs(contextScore(top.p, m, prev.length, next.length) - top.s) < EPS);
      if ((ranked[1] && top.s - ranked[1].s < EPS) || rivalNext) {
        ambiguousNext.add(n.ref);
        for (const r of ranked.filter((x) => top.s - x.s < EPS)) ambiguousPrev.add(r.p.ref);
        continue;
      }
      pairs.push({ prev: top.p.ref, next: n.ref, kind: 'exact', similarity: 1 });
      usedPrev.add(top.p.ref);
      usedNext.add(n.ref);
    }
  }

  // Similar texts (edits), then splits and merges.
  const restPrev = prev.filter((p) => !usedPrev.has(p.ref) && !ambiguousPrev.has(p.ref));
  const restNext = next.filter((n) => !usedNext.has(n.ref) && !ambiguousNext.has(n.ref));
  const candidates: { p: MatchItem; n: MatchItem; sim: number; score: number; kind: MatchKind }[] = [];
  for (const p of restPrev) {
    for (const n of restNext) {
      const sim = similarity(p.text, n.text);
      const bonus = (p.file === n.file ? 0.05 : 0) + (p.prefix && p.prefix === n.prefix ? 0.03 : 0) + (p.suffix && p.suffix === n.suffix ? 0.03 : 0);
      if (sim >= opts.threshold) {
        candidates.push({ p, n, sim, score: sim + bonus, kind: 'similar' });
        continue;
      }
      const pn = normalizeForIdentity(p.text).length;
      const nn = normalizeForIdentity(n.text).length;
      if (nn < pn && containment(n.text, p.text) >= opts.containment && nn / pn >= 0.25) candidates.push({ p, n, sim, score: 0.5 * containment(n.text, p.text) * (nn / pn) + bonus, kind: 'split' });
      else if (nn > pn && containment(p.text, n.text) >= opts.containment && pn / nn >= 0.25) candidates.push({ p, n, sim, score: 0.5 * containment(p.text, n.text) * (pn / nn) + bonus, kind: 'merge' });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (usedPrev.has(c.p.ref) || usedNext.has(c.n.ref)) continue;
    pairs.push({ prev: c.p.ref, next: c.n.ref, kind: c.kind, similarity: Math.round(c.sim * 1000) / 1000 });
    usedPrev.add(c.p.ref);
    usedNext.add(c.n.ref);
  }
  return { pairs, ambiguousPrev, ambiguousNext };
}
