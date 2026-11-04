import { segmentSentences } from '@research-studio/document-intelligence';

export interface BlockSentence {
  text: string;
  /** Offsets in the block text. */
  start: number;
  end: number;
}

/** Inline maths, command arguments of references and citations: masked so their periods do not end sentences. */
const MASK = /\$[^$]*\$|\\\([\s\S]*?\\\)|\\(?:[a-zA-Z]*cite[a-zA-Z]*|ref|eqref|cref|Cref|autoref|label|url|href)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^{}]*\}/g;

/**
 * Sentences of a prose block, with offsets into the block text. Uses the
 * M3.3 segmenter (abbreviations, initials, decimals, citations) on a copy in
 * which inline maths and command arguments are replaced by placeholders of
 * the same length, so offsets map back to the source unchanged.
 */
export function blockSentences(text: string): BlockSentence[] {
  const masked = text.replace(MASK, (m) => m.replace(/[^\s]/g, 'x'));
  // `Fig.~\ref{}` and `et al.\ ` do not end sentences.
  const protectedText = masked.replace(/\.(~|\\ )/g, (_m, s: string) => `x${s}`);
  return segmentSentences(protectedText)
    .map((s) => ({ start: s.start, end: s.end, text: text.slice(s.start, s.end) }))
    .filter((s) => s.text.trim().length > 0);
}
