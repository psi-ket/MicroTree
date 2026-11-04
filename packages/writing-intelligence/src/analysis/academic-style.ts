import type { WritingFinding } from './finding';

const INFORMAL: [RegExp, string][] = [
  [/\ba lot of\b/i, 'many / much'],
  [/\b(really|pretty|quite|basically|actually|totally)\b/i, 'remove, or state the degree precisely'],
  [/\b(huge|tiny|awesome|amazing|nice)\b/i, 'a precise or measured term'],
  [/\b(get|gets|got)\b/i, 'obtain / become / reach'],
  [/\bthings?\b/i, 'name what is meant'],
];
const CONTRACTION = /\b(\w+)'(t|s|re|ve|ll|d)\b/i;
const FILLER: [RegExp, string][] = [
  [/\bit is (important|worth|interesting) to (note|mention|emphasi[sz]e) that\b/i, 'state the point directly'],
  [/\bin order to\b/i, 'to'],
  [/\bdue to the fact that\b/i, 'because'],
  [/\bat this point in time\b/i, 'now'],
  [/\bthe fact that\b/i, 'rephrase without "the fact that"'],
  [/\bhas the ability to\b/i, 'can'],
];

/** Style rules for one sentence (formal register, concision, readability). */
export function styleFindings(sentence: string, i: number): WritingFinding[] {
  const out: WritingFinding[] = [];
  const plain = sentence.replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, ' ');
  for (const [re, s] of INFORMAL) {
    const m = re.exec(plain);
    if (m) out.push({ operation: 'formal', sentence: i, excerpt: m[0], message: `"${m[0]}" is informal.`, suggestion: s, severity: 'suggestion', source: 'rule' });
  }
  const c = CONTRACTION.exec(plain);
  if (c && !/\b\w+'s\s+(theorem|lemma|law|equation|rule|principle|algorithm|code)\b/i.test(plain)) out.push({ operation: 'formal', sentence: i, excerpt: c[0], message: 'Contraction in formal text.', suggestion: 'write it out', severity: 'suggestion', source: 'rule' });
  for (const [re, s] of FILLER) {
    const m = re.exec(plain);
    if (m) out.push({ operation: 'concise', sentence: i, excerpt: m[0], message: `"${m[0]}" can be shorter.`, suggestion: s, severity: 'info', source: 'rule' });
  }
  const words = plain.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  if (words > 40) out.push({ operation: 'readability', sentence: i, excerpt: sentence.slice(0, 60), message: `Long sentence (${words} words).`, suggestion: 'split it into two sentences', severity: 'info', source: 'rule' });
  if (/^\s*(this|these|that|it)\s+(is|are|was|were|shows?|means?|leads?|implies?|suggests?)\b/i.test(plain)) out.push({ operation: 'reduce-ambiguity', sentence: i, excerpt: plain.trim().split(/\s+/).slice(0, 3).join(' '), message: 'The sentence opens with a pronoun whose referent may be unclear.', suggestion: 'name what "this" refers to', severity: 'info', source: 'rule' });
  return out;
}
