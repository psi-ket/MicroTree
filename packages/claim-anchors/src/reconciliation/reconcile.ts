import type { AnchorStatus, ManuscriptBlockKind } from '@research-studio/shared-types';
import { normalizeForIdentity } from '../hashing/text-hash';
import { assessChange, type Materiality } from '../mapping/materiality';
import type { ManuscriptBlock, ManuscriptSentence, ParsedManuscript } from '../parser/manuscript';
import { matchItems, type MatchItem, type MatchKind } from './matcher';

/** A block as stored after the previous reconciliation. */
export interface StoredBlock {
  id: string;
  filePath: string;
  kind: ManuscriptBlockKind;
  text: string;
  hash: string;
  prefix: string;
  suffix: string;
  order: number;
  sentences: StoredSentence[];
}

export interface StoredSentence {
  id: string;
  blockId: string;
  order: number;
  text: string;
  hash: string;
  prefix: string;
  suffix: string;
}

/** What a claim is anchored to. */
export interface StoredClaimAnchor {
  claimId: string;
  blockId: string;
  sentenceId: string | null;
  filePath: string;
  /** The claim's own text (a span of the sentence or a paraphrase). */
  claimText: string;
  /** Whether the claim text was a verbatim span of the sentence. */
  verbatim: boolean;
  /** The sentence (or block) text when the claim was anchored. */
  textSnapshot: string;
}

export interface MappedItem {
  /** Key in the new parse. */
  key: string;
  /** The identity carried over, or null for new content. */
  id: string | null;
  status: AnchorStatus;
  relation: MatchKind | 'new';
  similarity: number;
}

export interface RemovedItem {
  id: string;
  status: 'deleted' | 'unmatched';
}

export interface ClaimMapping {
  claimId: string;
  status: AnchorStatus;
  /** New location (null when deleted or unmatched). */
  blockKey: string | null;
  sentenceKey: string | null;
  filePath: string | null;
  newText: string | null;
  /** Span of the claim in the new sentence, when found verbatim. */
  span: { start: number; end: number } | null;
  change: Materiality | null;
  note: string;
}

export interface ReconcileResult {
  blocks: MappedItem[];
  removedBlocks: RemovedItem[];
  sentences: MappedItem[];
  removedSentences: RemovedItem[];
  claims: ClaimMapping[];
  summary: Record<AnchorStatus, number>;
}

const BLOCK_OPTS = { threshold: 0.6, containment: 0.9 };
const SENTENCE_OPTS = { threshold: 0.55, containment: 0.9 };

function findSpan(haystack: string, needle: string): { start: number; end: number } | null {
  // Compare with spacing collapsed, then map back to the original offsets.
  const map: number[] = [];
  let flat = '';
  let space = false;
  for (let i = 0; i < haystack.length; i++) {
    const c = haystack[i]!;
    const ws = /\s|~/.test(c);
    if (ws) {
      if (!space && flat) {
        flat += ' ';
        map.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    flat += c.toLowerCase();
    map.push(i);
  }
  const n = needle.replace(/[\s~]+/g, ' ').trim().toLowerCase();
  if (!n) return null;
  const at = flat.indexOf(n);
  if (at === -1 || flat.indexOf(n, at + 1) !== -1) return null;
  return { start: map[at]!, end: map[at + n.length - 1]! + 1 };
}

/**
 * Carry identities from the stored manuscript to a new parse. Blocks and
 * sentences are matched by content and context (never by offsets alone);
 * claims follow their sentence when the claim text is still there, and are
 * otherwise found again, marked modified when the change is minor, or
 * `needs_revalidation` when it is material. A supported status is never
 * carried over a material change; that decision is the caller's, using
 * `status` and `change`.
 */
export function reconcile(stored: readonly StoredBlock[], parsed: ParsedManuscript, anchors: readonly StoredClaimAnchor[]): ReconcileResult {
  const prevBlocks: MatchItem[] = stored.map((b) => ({ ref: b.id, file: b.filePath, order: b.order, hash: b.hash, text: b.text, prefix: b.prefix, suffix: b.suffix }));
  const nextBlocks: MatchItem[] = parsed.blocks.map((b) => ({ ref: b.key, file: b.filePath, order: b.order, hash: b.hash, text: b.text, prefix: b.prefix, suffix: b.suffix }));
  const bm = matchItems(prevBlocks, nextBlocks, BLOCK_OPTS);
  const blockByKey = new Map(bm.pairs.map((p) => [p.next, p]));
  const blocks: MappedItem[] = parsed.blocks.map((b) => {
    const p = blockByKey.get(b.key);
    if (!p) return { key: b.key, id: null, status: bm.ambiguousNext.has(b.key) ? 'unmatched' : 'current', relation: 'new', similarity: 0 };
    return { key: b.key, id: p.prev, status: p.kind === 'exact' ? 'current' : 'modified', relation: p.kind, similarity: p.similarity };
  });
  const matchedPrevBlocks = new Set(bm.pairs.map((p) => p.prev));
  const removedBlocks: RemovedItem[] = stored.filter((b) => !matchedPrevBlocks.has(b.id)).map((b) => ({ id: b.id, status: bm.ambiguousPrev.has(b.id) ? 'unmatched' : 'deleted' }));

  // Sentences are matched across the whole manuscript (moves, renames, reordering).
  const prevSentences = stored.flatMap((b) => b.sentences.map((s) => ({ s, file: b.filePath })));
  const nextSentences: { s: ManuscriptSentence; b: ManuscriptBlock }[] = parsed.blocks.flatMap((b) => b.sentences.map((s) => ({ s, b })));
  const total = Math.max(1, prevSentences.length);
  const sm = matchItems(
    prevSentences.map(({ s, file }, i) => ({ ref: s.id, file, order: i, hash: s.hash, text: s.text, prefix: s.prefix, suffix: s.suffix })),
    nextSentences.map(({ s, b }, i) => ({ ref: s.key, file: b.filePath, order: (i * total) / Math.max(1, nextSentences.length), hash: s.hash, text: s.text, prefix: s.prefix, suffix: s.suffix })),
    SENTENCE_OPTS,
  );
  const sentenceByKey = new Map(sm.pairs.map((p) => [p.next, p]));
  const sentenceByPrev = new Map(sm.pairs.map((p) => [p.prev, p]));
  const sentences: MappedItem[] = nextSentences.map(({ s }) => {
    const p = sentenceByKey.get(s.key);
    if (!p) return { key: s.key, id: null, status: sm.ambiguousNext.has(s.key) ? 'unmatched' : 'current', relation: 'new', similarity: 0 };
    return { key: s.key, id: p.prev, status: p.kind === 'exact' ? 'current' : 'modified', relation: p.kind, similarity: p.similarity };
  });
  const removedSentences: RemovedItem[] = prevSentences.filter(({ s }) => !sentenceByPrev.has(s.id)).map(({ s }) => ({ id: s.id, status: sm.ambiguousPrev.has(s.id) ? 'unmatched' : 'deleted' }));

  const newSentence = new Map(nextSentences.map((x) => [x.s.key, x]));
  const blockByPrevId = new Map(bm.pairs.map((p) => [p.prev, p.next]));
  const parsedBlock = new Map(parsed.blocks.map((b) => [b.key, b]));

  const claims: ClaimMapping[] = anchors.map((a) => {
    const located = (key: string, kind: 'sentence' | 'block') => {
      const loc = kind === 'sentence' ? newSentence.get(key)! : { s: null, b: parsedBlock.get(key)! };
      const text = loc.s ? loc.s.text : loc.b.text;
      return { blockKey: loc.b.key, sentenceKey: loc.s?.key ?? null, filePath: loc.b.filePath, text };
    };
    const decide = (loc: ReturnType<typeof located>, how: string): ClaimMapping => {
      const span = a.verbatim ? findSpan(loc.text, a.claimText) : null;
      const sentenceChange = assessChange(a.textSnapshot, loc.text);
      if (normalizeForIdentity(a.textSnapshot) === normalizeForIdentity(loc.text)) {
        return { claimId: a.claimId, status: 'current', ...loc, newText: loc.text, span, change: null, note: how };
      }
      // The claim's own words are still there and the rest of the sentence changed only slightly.
      if (span && !sentenceChange.material) return { claimId: a.claimId, status: 'current', ...loc, newText: loc.text, span, change: sentenceChange, note: `${how}; the sentence was reworded around the claim` };
      if (!sentenceChange.material) return { claimId: a.claimId, status: 'modified', ...loc, newText: loc.text, span, change: sentenceChange, note: `${how}; minor rewording` };
      return { claimId: a.claimId, status: 'needs_revalidation', ...loc, newText: loc.text, span, change: sentenceChange, note: `${how}; ${sentenceChange.reasons.join(', ')}` };
    };

    if (a.sentenceId) {
      const p = sentenceByPrev.get(a.sentenceId);
      if (p) return decide(located(p.next, 'sentence'), p.kind === 'exact' ? 'sentence unchanged' : p.kind === 'similar' ? 'sentence edited' : `sentence ${p.kind}`);
    } else {
      const next = blockByPrevId.get(a.blockId);
      if (next) return decide(located(next, 'block'), 'block matched');
    }
    // The sentence is gone: look for the claim's words anywhere (moved, merged into another sentence, split).
    // Sentences already identified as an unchanged copy of another sentence are not candidates:
    // two identical paragraphs keep separate identities and are never merged.
    const exactTargets = new Set(sm.pairs.filter((p) => p.kind === 'exact').map((p) => p.next));
    const found = nextSentences.filter(({ s }) => findSpan(s.text, a.claimText) !== null);
    const hits = found.filter(({ s }) => !exactTargets.has(s.key));
    if (!hits.length && found.length) {
      return { claimId: a.claimId, status: 'unmatched', blockKey: null, sentenceKey: null, filePath: null, newText: null, span: null, change: null, note: 'an identical copy of this text remains, linked to another claim; one copy was removed' };
    }
    if (hits.length === 1) return decide(located(hits[0]!.s.key, 'sentence'), 'claim found in another sentence');
    if (hits.length > 1) return { claimId: a.claimId, status: 'unmatched', blockKey: null, sentenceKey: null, filePath: null, newText: null, span: null, change: null, note: `the claim text occurs ${hits.length} times; choose the right one` };
    const ambiguous = a.sentenceId ? sm.ambiguousPrev.has(a.sentenceId) : bm.ambiguousPrev.has(a.blockId);
    return { claimId: a.claimId, status: ambiguous ? 'unmatched' : 'deleted', blockKey: null, sentenceKey: null, filePath: null, newText: null, span: null, change: null, note: ambiguous ? 'several identical passages could hold this claim' : 'the text was removed' };
  });

  const summary = { current: 0, modified: 0, needs_revalidation: 0, unmatched: 0, deleted: 0 } as Record<AnchorStatus, number>;
  for (const c of claims) summary[c.status]++;
  return { blocks, removedBlocks, sentences, removedSentences, claims, summary };
}
