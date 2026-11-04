import { tokens } from '@research-studio/claim-anchors';
import type { WritingFinding } from './finding';

const CONNECTIVE = /^\s*(however|therefore|thus|hence|moreover|furthermore|in addition|consequently|in contrast|similarly|for example|for instance|first|second|finally|as a result|nevertheless|specifically|in particular|here|to this end|this|these|such)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'which', 'have', 'has', 'can', 'its', 'their', 'into', 'than', 'also', 'such', 'these', 'those']);

/** Flow between adjacent sentences: a sentence sharing no terms with its predecessor and no connective may be a jump. */
export function flowFindings(sentences: readonly string[]): WritingFinding[] {
  const out: WritingFinding[] = [];
  const content = (s: string) => new Set(tokens(s).filter((w) => w.length > 3 && !STOP.has(w) && !w.startsWith('\\')));
  for (let i = 1; i < sentences.length; i++) {
    const a = content(sentences[i - 1]!);
    const b = content(sentences[i]!);
    if (a.size < 3 || b.size < 3) continue;
    const shared = [...b].some((w) => a.has(w) || [...a].some((x) => x.slice(0, 5) === w.slice(0, 5)));
    if (!shared && !CONNECTIVE.test(sentences[i]!)) out.push({ operation: 'transitions', sentence: i, excerpt: sentences[i]!.slice(0, 60), message: `Sentence ${i + 1} shares no terms with the one before and has no transition.`, suggestion: 'connect it to the previous sentence or start a new paragraph', severity: 'info', source: 'rule' });
  }
  return out;
}
