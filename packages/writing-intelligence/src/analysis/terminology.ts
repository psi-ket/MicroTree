import type { WritingFinding } from './finding';

const SPELLING: [RegExp, RegExp][] = [
  [/\b(\w+)ise(s|d)?\b/g, /\b(\w+)ize(s|d)?\b/g],
  [/\b(\w+)isation\b/g, /\b(\w+)ization\b/g],
  [/\b(\w+)our\b/g, /\b(\w+)or\b/g],
];
const ACRONYM_DEF = /([A-Z][\w-]*(?:\s+[\w-]+){0,5})\s+\(([A-Z][A-Za-z0-9]{1,9})\)/g;
const COMMON = new Set(['DNA', 'RNA', 'USA', 'UK', 'EU', 'PDF', 'CPU', 'GPU', 'NASA', 'IBM', 'MIT', 'URL', 'II', 'III', 'IV']);

/**
 * Terminology across a text: acronyms used before or without a definition,
 * and terms written in more than one way (hyphenation, spelling variants,
 * capitalisation).
 */
export function terminologyFindings(sentences: readonly string[]): WritingFinding[] {
  const out: WritingFinding[] = [];
  const text = sentences.join(' ').replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+\*?(\{[^{}]*\})?/g, ' ');
  const defined = new Map<string, number>();
  sentences.forEach((s, i) => {
    for (const m of s.matchAll(ACRONYM_DEF)) if (!defined.has(m[2]!)) defined.set(m[2]!, i);
  });
  const reported = new Set<string>();
  sentences.forEach((s, i) => {
    const plain = s.replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+\*?(\{[^{}]*\})?/g, ' ');
    for (const m of plain.matchAll(/\b([A-Z]{2,}[a-z]?s?)\b/g)) {
      const a = m[1]!.replace(/s$/, '');
      if (COMMON.has(a) || reported.has(a)) continue;
      const at = defined.get(a);
      if (at === undefined) {
        reported.add(a);
        out.push({ operation: 'undefined-concepts', sentence: i, excerpt: a, message: `${a} is used but never defined.`, suggestion: `define it at first use: "full name (${a})"`, severity: 'suggestion', source: 'rule' });
      } else if (at > i) {
        reported.add(a);
        out.push({ operation: 'undefined-concepts', sentence: i, excerpt: a, message: `${a} is used before it is defined (sentence ${at + 1}).`, suggestion: 'move the definition to the first use', severity: 'suggestion', source: 'rule' });
      }
    }
  });
  // Hyphenation variants: "fault tolerant" and "fault-tolerant".
  for (const m of text.matchAll(/\b([a-z]{3,})-([a-z]{3,})\b/gi)) {
    const spaced = new RegExp(`\\b${m[1]}\\s+${m[2]}\\b`, 'i');
    const joined = new RegExp(`\\b${m[1]}${m[2]}\\b`, 'i');
    const variant = spaced.exec(text)?.[0] ?? joined.exec(text)?.[0];
    if (variant && !reported.has(m[0].toLowerCase())) {
      reported.add(m[0].toLowerCase());
      out.push({ operation: 'terminology-consistency', sentence: null, excerpt: `${m[0]} / ${variant}`, message: `"${m[0]}" is also written "${variant}".`, suggestion: 'use one form throughout', severity: 'info', source: 'rule' });
    }
  }
  for (const [uk, us] of SPELLING) {
    const a = [...text.matchAll(uk)].map((m) => m[0].toLowerCase());
    const b = [...text.matchAll(us)].map((m) => m[0].toLowerCase());
    const stems = new Set(a.map((w) => w.replace(/(ise[sd]?|isation|our)$/, '')));
    const both = b.filter((w) => stems.has(w.replace(/(ize[sd]?|ization|or)$/, '')) && w.length > 5);
    if (both.length) out.push({ operation: 'terminology-consistency', sentence: null, excerpt: `${a.find((w) => both.some((x) => x.slice(0, 4) === w.slice(0, 4)))} / ${both[0]}`, message: 'British and American spellings are mixed.', suggestion: 'use one spelling convention', severity: 'info', source: 'rule' });
  }
  return out;
}
