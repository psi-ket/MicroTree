import { citedKeys } from '@research-studio/citation-intelligence';

const REFS = /\\(?:eq|c|C|auto|page|name)?ref\s*\{([^{}]*)\}|\\label\s*\{([^{}]*)\}/g;
const MATH = /\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{(equation|align|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g;

const multiset = (xs: string[]) => xs.map((x) => x.trim()).sort();
const diff = (a: string[], b: string[]) => {
  const rest = [...b];
  const missing: string[] = [];
  for (const x of a) {
    const i = rest.indexOf(x);
    if (i === -1) missing.push(x);
    else rest.splice(i, 1);
  }
  return { missing, added: rest };
};

export interface PreservationCheck {
  missingCitations: string[];
  addedCitations: string[];
  missingRefs: string[];
  addedRefs: string[];
  mathChanged: boolean;
}

/** What a rewrite dropped or added among citations, references, labels and mathematics. */
export function checkPreservation(original: string, proposed: string): PreservationCheck {
  const keys = diff(multiset(citedKeys(original)), multiset(citedKeys(proposed)));
  const refs = (t: string) => multiset([...t.matchAll(REFS)].map((m) => m[0].replace(/\s+/g, '')));
  const r = diff(refs(original), refs(proposed));
  const math = (t: string) => multiset([...t.matchAll(MATH)].map((m) => m[0].replace(/\s+/g, '')));
  const mo = math(original);
  const mp = math(proposed);
  return { missingCitations: keys.missing, addedCitations: keys.added, missingRefs: r.missing, addedRefs: r.added, mathChanged: mo.join('\u0000') !== mp.join('\u0000') };
}
