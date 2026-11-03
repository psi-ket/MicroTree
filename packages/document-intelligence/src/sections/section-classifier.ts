import type { SectionType } from '../documents/model';

const RULES: [SectionType, RegExp][] = [
  ['abstract', /^(abstract|summary)$/],
  ['introduction', /^(introduction|overview|motivation)\b/],
  ['background', /^(background|preliminar(y|ies)|related work|prior work|notation|setup|the model|model)\b/],
  ['methods', /^(methods?|methodology|materials and methods|experimental (setup|methods?|details)|approach|numerical methods?|simulations?)\b/],
  ['results', /^(results|experiments?|evaluation|numerical results|benchmarks?|findings)\b/],
  ['discussion', /^(discussion|analysis|outlook|limitations)\b/],
  ['conclusion', /^(conclusions?|concluding remarks|summary and outlook|summary and conclusions?)\b/],
  ['acknowledgement', /^(acknowledge?ments?|funding)\b/],
  ['references', /^(references|bibliography|literature cited)\b/],
  ['appendix', /^(appendix|appendices|supplementary|supplemental)\b/],
];

/** Heading number as printed ("2.1", "IV.", "A.") and the heading without it. */
export function splitHeadingNumber(heading: string): { number: string | null; text: string } {
  const m = /^\s*((?:\d+|[IVXLC]+|[A-Z])(?:\.\d+)*)\.?\s+(.+)$/.exec(heading);
  if (m && (/\d/.test(m[1]!) || m[1]!.length <= 4)) return { number: m[1]!, text: m[2]!.trim() };
  return { number: null, text: heading.trim() };
}

/** Nesting level implied by a printed number: "2" → 1, "2.1" → 2. Null when there is no number. */
export function levelFromNumber(number: string | null): number | null {
  if (!number) return null;
  return number.split('.').filter(Boolean).length;
}

/** Classify a heading. Unknown headings are `body`; never guessed from content. */
export function classifySection(heading: string, inheritedType: SectionType | null = null): SectionType {
  const text = splitHeadingNumber(heading).text.toLowerCase().replace(/[:.]+$/, '').trim();
  for (const [type, re] of RULES) if (re.test(text)) return type;
  if (inheritedType && inheritedType !== 'body' && inheritedType !== 'other') return inheritedType;
  return 'body';
}
