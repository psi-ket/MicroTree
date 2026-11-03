import { createHash } from 'node:crypto';
import {
  estimateTokens,
  mergeLineBoxes,
  normalizeSearchText,
  pageRange,
  type DocumentCoordinate,
  type NormalizedBlock,
  type NormalizedDocument,
  type NormalizedSection,
  type PassageDraft,
  type PassageKind,
  type SectionType,
} from '@research-studio/document-intelligence';

/**
 * Structure-aware passage segmentation.
 *
 * - Paragraph-like blocks accumulate, in reading order and **within one
 *   section**, until the next block would pass `targetTokens`. Sections are
 *   never merged; every passage keeps its section path.
 * - A block longer than `maxTokens` is split at sentence boundaries, with
 *   `overlapTokens` of whole sentences repeated at the start of the next piece.
 * - Display formulas and figure/table captions are passages of their own
 *   (`formula`, `caption`); the abstract is `abstract`; each bibliography
 *   entry is a `reference` passage, kept out of body retrieval by default.
 * - Titles and headings are not passages; headings are indexed as context.
 *
 * These are defaults to validate against real libraries, not fixed truths;
 * they are recorded with each extraction.
 */
export interface ChunkingConfig {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNKING: ChunkingConfig = { targetTokens: 550, maxTokens: 700, overlapTokens: 75 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const GROUPED = new Set(['paragraph', 'list', 'abstract', 'acknowledgement', 'footnote', 'other', 'inline_formula']);

function kindOf(b: NormalizedBlock): PassageKind {
  switch (b.type) {
    case 'abstract':
      return 'abstract';
    case 'display_formula':
      return 'formula';
    case 'figure_caption':
    case 'table_caption':
      return 'caption';
    case 'reference':
      return 'reference';
    default:
      return 'body';
  }
}

interface Piece {
  block: NormalizedBlock;
  text: string;
  tokens: number;
  coordinates: DocumentCoordinate[];
  pageStart: number | null;
  pageEnd: number | null;
  sentences: { blockKey: string; order: number }[];
}

function wholeBlock(b: NormalizedBlock): Piece {
  return {
    block: b,
    text: b.plainText,
    tokens: estimateTokens(b.plainText),
    coordinates: b.coordinates,
    pageStart: b.pageStart,
    pageEnd: b.pageEnd,
    sentences: b.sentences.map((s) => ({ blockKey: b.key, order: s.order })),
  };
}

/** Split an oversized block at sentence boundaries with overlap. */
function splitBlock(b: NormalizedBlock, config: ChunkingConfig): Piece[] {
  const sentences = b.sentences.length ? b.sentences : [{ order: 0, text: b.plainText, coordinates: [], pageStart: b.pageStart, pageEnd: b.pageEnd }];
  const sized = sentences.map((s) => ({ s, tokens: estimateTokens(s.text) }));
  const pieces: Piece[] = [];
  let start = 0;
  while (start < sized.length) {
    let end = start;
    let tokens = 0;
    while (end < sized.length && (end === start || tokens + sized[end]!.tokens <= config.targetTokens)) {
      tokens += sized[end]!.tokens;
      end++;
    }
    const chosen = sized.slice(start, end).map((x) => x.s);
    // Boxes of the sentences when each has its own; otherwise the block's boxes (an area that contains the text, never an invented one).
    const exact = chosen.every((s) => s.coordinates.length);
    const coordinates = exact ? mergeLineBoxes(chosen.flatMap((s) => s.coordinates)) : b.coordinates;
    const range = exact ? pageRange(coordinates) : { pageStart: chosen[0]!.pageStart ?? b.pageStart, pageEnd: chosen.at(-1)!.pageEnd ?? b.pageEnd };
    pieces.push({
      block: b,
      text: chosen.map((s) => s.text).join(' '),
      tokens,
      coordinates,
      ...range,
      sentences: chosen.map((s) => ({ blockKey: b.key, order: s.order })),
    });
    if (end >= sized.length) break;
    // Step back over whole sentences until the overlap budget is used.
    let back = end;
    let overlap = 0;
    while (back - 1 > start && overlap + sized[back - 1]!.tokens <= config.overlapTokens) {
      back--;
      overlap += sized[back]!.tokens;
    }
    start = back;
  }
  return pieces;
}

export function segmentDocument(doc: NormalizedDocument, sourceSha256: string, config: ChunkingConfig = DEFAULT_CHUNKING): PassageDraft[] {
  if (config.targetTokens > config.maxTokens || config.overlapTokens >= config.targetTokens) throw new RangeError('Invalid chunking configuration');
  const sections = new Map<string, NormalizedSection>(doc.sections.map((s) => [s.key, s]));
  const drafts: PassageDraft[] = [];
  const occurrences = new Map<string, number>();

  const emit = (pieces: Piece[], kind: PassageKind) => {
    if (!pieces.length) return;
    const first = pieces[0]!.block;
    const section = first.sectionKey ? sections.get(first.sectionKey) : undefined;
    const text = pieces.map((p) => p.text).join('\n\n');
    const textHash = sha256(text);
    const sectionPath = section?.path ?? '';
    const sectionType: SectionType = section?.type ?? (first.type === 'footnote' ? 'other' : 'body');
    const occurrenceKey = `${sectionPath}\u0000${textHash}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const coordinates = pieces.flatMap((p) => p.coordinates);
    const starts = pieces.map((p) => p.pageStart).filter((x): x is number => x !== null);
    const ends = pieces.map((p) => p.pageEnd).filter((x): x is number => x !== null);
    const blockKeys = [...new Set(pieces.map((p) => p.block.key))];
    drafts.push({
      order: drafts.length,
      kind,
      sectionKey: first.sectionKey,
      sectionPath,
      sectionType,
      blockKeys,
      text,
      normalizedText: normalizeSearchText(text),
      textHash,
      stableKey: sha256(`${sourceSha256}\u0000${sectionPath}\u0000${textHash}\u0000${occurrence}`),
      pageStart: starts.length ? Math.min(...starts) : null,
      pageEnd: ends.length ? Math.max(...ends) : null,
      coordinates,
      tokenCount: pieces.reduce((n, p) => n + p.tokens, 0),
      language: doc.metadata.language,
      sentences: pieces.flatMap((p) => p.sentences),
    });
  };

  let group: Piece[] = [];
  let groupTokens = 0;
  let groupKey: string | null = null;
  const flush = () => {
    if (group.length) emit(group, kindOf(group[0]!.block));
    group = [];
    groupTokens = 0;
    groupKey = null;
  };

  for (const b of doc.blocks) {
    if (b.type === 'title' || b.type === 'heading' || !b.plainText.trim()) continue;
    const kind = kindOf(b);
    if (!GROUPED.has(b.type)) {
      flush();
      emit([wholeBlock(b)], kind);
      continue;
    }
    // A group never spans sections, nor abstract and body, nor footnotes and body.
    const key = `${b.sectionKey ?? ''}\u0000${kind}\u0000${b.type === 'footnote' ? 'fn' : ''}`;
    const tokens = estimateTokens(b.plainText);
    if (tokens > config.maxTokens) {
      flush();
      for (const piece of splitBlock(b, config)) emit([piece], kind);
      continue;
    }
    if (groupKey !== key || groupTokens + tokens > config.targetTokens) flush();
    group.push(wholeBlock(b));
    groupTokens += tokens;
    groupKey = key;
  }
  flush();
  return drafts;
}

/** The text sent to an embedding model: section context, then the passage. Hashing it keys the cache. */
export function embeddingInput(p: { sectionPath: string; text: string }, maxChars = 8000): string {
  const head = p.sectionPath ? `${p.sectionPath}\n` : '';
  return (head + p.text).slice(0, maxChars);
}

export function embeddingInputHash(input: string): string {
  return sha256(input);
}
