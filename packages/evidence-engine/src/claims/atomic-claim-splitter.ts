/**
 * Splits a sentence into independently supportable propositions where the
 * sentence joins full clauses (`…, and they provide …`, `…; …`,
 * `…, whereas …`). Each part keeps its exact span in the sentence. Lists
 * of nouns (`locality and low overhead`) are not split. This is the
 * deterministic baseline; a model can split further, and the researcher can
 * merge or split by hand.
 */

export interface ClaimSpan {
  text: string;
  start: number;
  end: number;
}

/** Words that, after a conjunction, start a new clause with its own subject. */
const SUBJECT = /^(?:they|it|this|these|those|we|he|she|such|there|its|their|our|the|a|an|[A-Z][a-z]+(?:\s+[a-z]+){0,3}\s+(?:is|are|was|were|has|have|can|could|may|might|will|would|do|does|did|provides?|shows?|requires?|allows?|enables?|remains?))\b/;
const VERB = /\b(?:is|are|was|were|has|have|had|can|could|may|might|will|would|must|should|provides?|shows?|requires?|allows?|enables?|remains?|reaches?|achieves?|reduces?|increases?|decreases?|leads?|yields?|offers?|exhibits?|scales?|depends?|demonstrates?|predicts?|suggests?|indicates?|uses?|needs?|grows?|exceeds?|supports?|limits?|makes?|becomes?)\b/i;

/** Joints where a new clause may start, in priority order. */
const JOINTS: RegExp[] = [/;\s+/g, /,\s+(?:and|but|while|whereas|yet|so)\s+/g, /\s+(?:whereas|while)\s+/g];

function clauseLike(s: string): boolean {
  const words = s.replace(/\$[^$]*\$/g, 'X').trim().split(/\s+/);
  return words.length >= 3 && (VERB.test(s) || SUBJECT.test(s.trim()));
}

export function splitAtomicClaims(sentence: string): ClaimSpan[] {
  const trimmedEnd = sentence.replace(/\s+$/, '').length;
  const lead = sentence.length - sentence.trimStart().length;
  for (const joint of JOINTS) {
    const cuts: { start: number; end: number }[] = [];
    for (const m of sentence.matchAll(joint)) {
      const at = m.index ?? 0;
      // Not inside maths or braces.
      const before = sentence.slice(0, at);
      if ((before.match(/(?<!\\)\$/g)?.length ?? 0) % 2 === 1) continue;
      if ((before.match(/(?<!\\)\{/g)?.length ?? 0) !== (before.match(/(?<!\\)\}/g)?.length ?? 0)) continue;
      const after = sentence.slice(at + m[0].length);
      if (!SUBJECT.test(after) && !/^;/.test(m[0])) continue;
      cuts.push({ start: at, end: at + m[0].length });
    }
    if (!cuts.length) continue;
    const parts: ClaimSpan[] = [];
    let from = lead;
    for (const c of cuts) {
      parts.push({ text: sentence.slice(from, c.start), start: from, end: c.start });
      from = c.end;
    }
    parts.push({ text: sentence.slice(from, trimmedEnd), start: from, end: trimmedEnd });
    // The first part is the sentence's own main clause; later parts must start with a subject and a verb.
    if (parts.length > 1 && parts.every((p, i) => (i === 0 ? p.text.trim().split(/\s+/).length >= 4 : clauseLike(p.text)))) return parts;
  }
  return [{ text: sentence.slice(lead, trimmedEnd), start: lead, end: trimmedEnd }];
}
