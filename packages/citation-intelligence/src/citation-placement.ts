import type { CitationPlacement, CiteCommand } from '@research-studio/shared-types';

export interface PlacementInput {
  /** The whole file. */
  content: string;
  /** The sentence's range in the file. */
  sentence: { start: number; end: number };
  /** The claim's range in the file, for clause-level placement. */
  claim?: { start: number; end: number } | null;
  keys: readonly string[];
  command: CiteCommand;
  placement: CitationPlacement;
}

export interface CitationEdit {
  /** Range of the file replaced (may be empty for a pure insertion). */
  start: number;
  end: number;
  original: string;
  replacement: string;
  /** The sentence before and after, for review. */
  before: string;
  after: string;
  /** Keys added to an existing citation command instead of a new one. */
  mergedInto: string | null;
  skippedKeys: string[];
}

const CITE_AT_END = /(~|\s)*\\(cite|citep|citet|parencite|textcite|autocite)(\*?)((?:\s*\[[^\]]*\]){0,2})\s*\{([^{}]*)\}\s*$/;

/**
 * Where and how a citation goes. At the end of the sentence (or the claim's
 * clause) before the closing punctuation, joined with `~`; when a citation
 * command already ends that text, its key list is extended instead of adding
 * a second command. Keys already cited there are skipped.
 */
export function planCitationEdit(p: PlacementInput): CitationEdit {
  const sentence = p.content.slice(p.sentence.start, p.sentence.end);
  const target = p.placement === 'clause-end' && p.claim ? p.claim : p.sentence;
  const segment = p.content.slice(target.start, target.end);
  // Text up to the final punctuation of the segment.
  const m = /([.;,:!?])(["'’”)\]]*)\s*$/.exec(segment);
  const bodyEnd = target.start + (m ? m.index : segment.replace(/\s+$/, '').length);
  const body = p.content.slice(target.start, bodyEnd);
  const existing = CITE_AT_END.exec(body);
  if (existing) {
    const present = existing[5]!.split(',').map((k) => k.trim()).filter(Boolean);
    const toAdd = p.keys.filter((k) => !present.some((x) => x.toLowerCase() === k.toLowerCase()));
    const braceEnd = target.start + existing.index + existing[0].length;
    const braceStart = p.content.lastIndexOf('{', braceEnd);
    const original = p.content.slice(braceStart, braceEnd);
    const replacement = `{${[...present, ...toAdd].join(',')}}`;
    const afterContent = p.content.slice(0, braceStart) + replacement + p.content.slice(braceEnd);
    return {
      start: braceStart,
      end: braceEnd,
      original,
      replacement,
      before: sentence,
      after: afterContent.slice(p.sentence.start, p.sentence.end + replacement.length - original.length),
      mergedInto: `\\${existing[2]}`,
      skippedKeys: p.keys.filter((k) => !toAdd.includes(k)),
    };
  }
  const cite = `~\\${p.command}{${p.keys.join(',')}}`;
  // Trailing spaces before the punctuation are replaced by the tie.
  const trimmed = body.replace(/\s+$/, '');
  const at = target.start + trimmed.length;
  const original = p.content.slice(at, bodyEnd);
  const afterContent = p.content.slice(0, at) + cite + p.content.slice(bodyEnd);
  return {
    start: at,
    end: bodyEnd,
    original,
    replacement: cite,
    before: sentence,
    after: afterContent.slice(p.sentence.start, p.sentence.end + cite.length - original.length),
    mergedInto: null,
    skippedKeys: [],
  };
}
