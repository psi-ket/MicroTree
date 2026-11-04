import type { WritingOperation } from '@research-studio/shared-types';

/** One observation about the text. Findings are suggestions for the author, not judgements of correctness. */
export interface WritingFinding {
  operation: WritingOperation;
  /** Index of the sentence in the analysed text (null: the whole passage). */
  sentence: number | null;
  /** The words concerned, as written. */
  excerpt: string;
  message: string;
  suggestion: string | null;
  severity: 'info' | 'suggestion' | 'warning';
  source: 'rule' | 'model';
}
