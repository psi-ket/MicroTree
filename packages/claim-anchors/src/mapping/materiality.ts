import { normalizeForIdentity, similarity, tokens } from '../hashing/text-hash';

/**
 * Whether an edit changes what a claim asserts. Rewording that keeps every
 * number, unit, negation, quantifier, modal or hedging word, comparison,
 * causal connective, citation key, reference and math segment is minor; any
 * change to one of those, or a large change in wording, is material. The
 * check is deliberately conservative: when in doubt the edit is material and
 * the evidence must be checked again.
 */

const NEGATIONS = new Set(['not', 'no', 'never', 'none', 'neither', 'nor', 'without', 'cannot', 'nothing', 'fails', 'fail', 'lack', 'lacks', 'absent', 'unlikely', "n't"]);
const QUANTIFIERS = new Set(['all', 'every', 'each', 'always', 'some', 'most', 'many', 'few', 'several', 'only', 'any', 'often', 'usually', 'rarely', 'sometimes', 'generally', 'universally', 'majority', 'minority']);
const MODALS = new Set(['may', 'might', 'could', 'can', 'must', 'should', 'would', 'will', 'likely', 'possibly', 'probably', 'perhaps', 'suggests', 'suggest', 'indicates', 'indicate', 'demonstrates', 'demonstrate', 'proves', 'prove', 'shows', 'show', 'confirms', 'confirm', 'establishes', 'establish', 'appears', 'appear', 'seems', 'seem', 'potentially', 'presumably', 'certainly', 'clearly']);
const COMPARATIVES = new Set(['more', 'less', 'fewer', 'higher', 'lower', 'greater', 'smaller', 'larger', 'better', 'worse', 'faster', 'slower', 'stronger', 'weaker', 'increase', 'increases', 'decrease', 'decreases', 'exceeds', 'exceed', 'outperforms', 'outperform', 'than', 'superior', 'inferior', 'equal', 'equivalent', 'same']);
const CAUSAL = new Set(['because', 'causes', 'cause', 'caused', 'leads', 'lead', 'results', 'result', 'due', 'therefore', 'thus', 'hence', 'consequently', 'drives', 'drive', 'induces', 'induce', 'enables', 'enable', 'prevents', 'prevent', 'determines', 'determine', 'implies', 'imply']);

/** Words whose change does not alter what is asserted (intensity, style, auxiliaries, connectives). */
const STYLE = new Set(['widely', 'extensively', 'broadly', 'commonly', 'intensively', 'thoroughly', 'actively', 'heavily', 'considerably', 'particularly', 'especially', 'notably', 'very', 'also', 'further', 'furthermore', 'moreover', 'indeed', 'however', 'additionally', 'been', 'being', 'have', 'were', 'that', 'which', 'this', 'these', 'those', 'their', 'there', 'then', 'such', 'with', 'from', 'into', 'well']);

export interface Materiality {
  material: boolean;
  similarity: number;
  reasons: string[];
}

const NUMBER = /[-+]?\d+(?:[.,]\d+)?(?:\s*(?:%|\\%|[a-zA-Zµμ°]+(?:\^?-?\d)?))?/g;
const CITE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;
const REF = /\\(?:eq|c|C|auto|page|name)?ref\s*\{([^{}]*)\}/g;
const MATH = /\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;

function bag(text: string, re: RegExp): string[] {
  return [...normalizeForIdentity(text).matchAll(re)].map((m) => (m[1] ?? m[0]).replace(/\s+/g, '')).sort();
}

function words(text: string, set: Set<string>): string[] {
  const t = normalizeForIdentity(text).replace(/n't\b/g, " n't");
  const out = (t.match(/[\p{L}']+/gu) ?? []).filter((w) => set.has(w));
  return out.sort();
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function assessChange(before: string, after: string): Materiality {
  if (normalizeForIdentity(before) === normalizeForIdentity(after)) return { material: false, similarity: 1, reasons: [] };
  const reasons: string[] = [];
  const checks: [string, (s: string) => string[]][] = [
    ['numbers or units', (s) => bag(s.replace(MATH, ' '), NUMBER)],
    ['negation', (s) => words(s, NEGATIONS)],
    ['quantifiers', (s) => words(s, QUANTIFIERS)],
    ['modal or hedging words', (s) => words(s, MODALS)],
    ['comparisons', (s) => words(s, COMPARATIVES)],
    ['causal language', (s) => words(s, CAUSAL)],
    ['citations', (s) => bag(s, CITE).flatMap((k) => k.split(',')).sort()],
    ['references', (s) => bag(s, REF)],
    ['mathematics', (s) => bag(s, MATH)],
  ];
  for (const [name, f] of checks) if (!same(f(before), f(after))) reasons.push(`${name} changed`);
  const sim = similarity(before, after);
  if (sim < 0.75) reasons.push('wording changed substantially');
  // A change to content words (terms, entities, properties) changes what is asserted, unless only
  // style words changed. One swapped adjective can invert a claim ("hard" to "easy").
  const stem = (w: string) => w.replace(/(ies|es|s|ed|ing|ly)$/, '');
  const content = (s: string) => new Set(tokens(s).filter((w) => w.length > 3 && !STYLE.has(w) && !MODALS.has(w) && !QUANTIFIERS.has(w)).map(stem));
  const a = content(before);
  const b = content(after);
  const changedTerms = [...a].filter((w) => !b.has(w)).length + [...b].filter((w) => !a.has(w)).length;
  if (changedTerms > 0) reasons.push('terms changed');
  return { material: reasons.length > 0, similarity: Math.round(sim * 1000) / 1000, reasons };
}
