import { citedKeys } from '@research-studio/citation-intelligence';
import { styleFindings } from './academic-style';
import type { WritingFinding } from './finding';

const ABSOLUTE = /\b(all|every|always|never|none|no one|universally|invariably|undoubtedly|certainly|clearly|obviously|proves?|proven|guarantees?|any)\b/i;
const HEDGED = /\b(may|might|can|could|often|typically|generally|usually|suggests?|indicates?|likely|in (most|many) cases|to our knowledge|approximately|about)\b/i;
const CAUSAL = /\b(causes?|caused by|leads? to|results? in|is responsible for|drives?|induces?)\b/i;
const OBSERVATION = /\b(we (observe|measure|find|found|see)|is observed|was measured|data show)\b/i;
const INTERPRETATION = /\b(this (means|proves|shows) that|which (proves|demonstrates)|therefore|thus|hence)\b/i;
const PREDICTION = /\b(predicts?|predicted|theory|theoretical(ly)?|simulations? (show|suggest))\b/i;
const RESULT = /\b(experiment(s|al(ly)?)?|measured|observed in|demonstrated on hardware)\b/i;

/**
 * Rules for scientific precision in one sentence: absolute statements
 * without a citation or qualification, unhedged causal language,
 * observation and interpretation run together, prediction stated as
 * result. Rules are suggestions; the author decides.
 */
export function analyseSentence(sentence: string, i: number, opts: { needsEvidence?: boolean } = {}): WritingFinding[] {
  const out = styleFindings(sentence, i);
  const plain = sentence.replace(/\$[^$]*\$/g, ' ');
  const cited = citedKeys(sentence).length > 0;
  const abs = ABSOLUTE.exec(plain);
  if (abs && !HEDGED.test(plain) && !cited && !/\\(begin|end)\{(theorem|lemma|proof)\}/.test(sentence)) {
    out.push({ operation: 'overgeneralization', sentence: i, excerpt: abs[0], message: `"${abs[0]}" makes a universal statement without a citation or qualification.`, suggestion: 'qualify the scope, or cite the source that establishes it', severity: 'warning', source: 'rule' });
  }
  const cause = CAUSAL.exec(plain);
  if (cause && !cited && !HEDGED.test(plain)) out.push({ operation: 'causal-language', sentence: i, excerpt: cause[0], message: `"${cause[0]}" asserts causation; is it established or a correlation?`, suggestion: 'cite the evidence for the mechanism, or use "is associated with"', severity: 'suggestion', source: 'rule' });
  if (OBSERVATION.test(plain) && INTERPRETATION.test(plain)) out.push({ operation: 'observation-vs-interpretation', sentence: i, excerpt: INTERPRETATION.exec(plain)![0], message: 'An observation and its interpretation are in one sentence.', suggestion: 'state what was observed, then the interpretation, separately', severity: 'info', source: 'rule' });
  if (PREDICTION.test(plain) && RESULT.test(plain)) out.push({ operation: 'prediction-vs-result', sentence: i, excerpt: PREDICTION.exec(plain)![0], message: 'Theory or simulation and experiment are mentioned together; make clear which result is which.', suggestion: null, severity: 'info', source: 'rule' });
  if (opts.needsEvidence && !cited) out.push({ operation: 'needs-citations', sentence: i, excerpt: sentence.slice(0, 80), message: 'This claim may need a citation.', suggestion: 'check the evidence panel for supporting sources', severity: 'suggestion', source: 'rule' });
  return out;
}
