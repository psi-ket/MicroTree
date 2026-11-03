import { pageRange, segmentSentences, type ExtractionQuality, type NormalizedBlock, type NormalizedSection } from '@research-studio/document-intelligence';

export function emptyQuality(structure: ExtractionQuality['structure']): ExtractionQuality {
  return {
    textCoverage: null,
    hasTitle: false,
    hasAbstract: false,
    sectionCount: 0,
    paragraphCount: 0,
    referenceCount: 0,
    coordinateCoverage: 0,
    emptyPages: [],
    structure,
  };
}

const SENTENCE_BLOCKS = new Set(['abstract', 'paragraph', 'acknowledgement', 'footnote', 'figure_caption', 'table_caption']);

/**
 * Blocks without extractor sentences get sentences from the rule-based
 * segmenter. Those have no boxes of their own (only the block's pages): a
 * box is never invented for them.
 */
export function attachSentences(blocks: NormalizedBlock[]): NormalizedBlock[] {
  return blocks.map((b) => {
    if (b.sentences.length || !SENTENCE_BLOCKS.has(b.type)) return b;
    const spans = segmentSentences(b.plainText);
    if (!spans.length) return b;
    return {
      ...b,
      sentenceSource: 'segmenter',
      sentences: spans.map((s, i) => ({ order: i, text: s.text, pageStart: b.pageStart, pageEnd: b.pageEnd, coordinates: [] })),
    };
  });
}

/**
 * Drop exact repeats of the previous block of the same type (extractors
 * sometimes emit a paragraph twice across a page break) and empty blocks.
 */
export function dedupeBlocks(blocks: NormalizedBlock[], warnings: string[]): NormalizedBlock[] {
  const out: NormalizedBlock[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.plainText.trim() && b.type !== 'display_formula') continue;
    const key = `${b.type}\u0000${b.plainText}`;
    const last = out.at(-1);
    const repeatsLast = last && last.type === b.type && last.plainText === b.plainText;
    // Long paragraphs repeated anywhere are duplicates; short ones ("(1)", "Proof.") may legitimately repeat.
    const repeatsLong = b.type === 'paragraph' && b.plainText.length > 200 && seen.has(key);
    if (repeatsLast || repeatsLong) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(b);
  }
  if (dropped) warnings.push(`${dropped} repeated blocks were removed.`);
  return out.map((b, i) => ({ ...b, order: i }));
}

/** Fill section paths ("2 Methods › 2.1 Setup") and page ranges from their blocks. */
export function sectionPaths(sections: NormalizedSection[], blocks: NormalizedBlock[]): void {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  for (const s of sections) {
    const names: string[] = [];
    let cur: NormalizedSection | undefined = s;
    let guard = 0;
    while (cur && guard++ < 64) {
      names.unshift(cur.number ? `${cur.number} ${cur.heading}` : cur.heading);
      cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
    }
    s.path = names.join(' › ');
    const own = blocks.filter((b) => b.sectionKey === s.key);
    const coords = own.flatMap((b) => b.coordinates);
    const fromCoords = pageRange(coords.length ? coords : s.coordinates);
    const starts = own.map((b) => b.pageStart).filter((p): p is number => p !== null);
    const ends = own.map((b) => b.pageEnd).filter((p): p is number => p !== null);
    s.pageStart = fromCoords.pageStart ?? (starts.length ? Math.min(...starts) : null);
    s.pageEnd = fromCoords.pageEnd ?? (ends.length ? Math.max(...ends) : null);
  }
}
