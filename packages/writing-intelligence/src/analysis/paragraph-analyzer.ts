import { similarity } from '@research-studio/claim-anchors';
import { blockSentences } from '@research-studio/claim-anchors';
import type { WritingFinding } from './finding';
import { analyseSentence } from './sentence-analyzer';
import { terminologyFindings } from './terminology';
import { flowFindings } from './logical-flow';

export interface ParagraphAnalysis {
  sentences: string[];
  findings: WritingFinding[];
}

/**
 * Deterministic analysis of a passage: every sentence rule, terminology
 * across the passage, repeated explanations (near-identical sentences) and
 * flow between sentences. `needsEvidence` marks sentences whose claims need
 * a source and have none cited.
 */
export function analyseParagraph(text: string, opts: { needsEvidence?: ReadonlySet<number> } = {}): ParagraphAnalysis {
  const sentences = blockSentences(text).map((s) => s.text);
  const findings: WritingFinding[] = sentences.flatMap((s, i) => analyseSentence(s, i, { needsEvidence: opts.needsEvidence?.has(i) ?? false }));
  findings.push(...terminologyFindings(sentences));
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      if (similarity(sentences[i]!, sentences[j]!) >= 0.8) findings.push({ operation: 'duplicated-explanations', sentence: j, excerpt: sentences[j]!.slice(0, 80), message: `Sentence ${j + 1} repeats sentence ${i + 1}.`, suggestion: 'keep one of them', severity: 'suggestion', source: 'rule' });
    }
  }
  findings.push(...flowFindings(sentences));
  return { sentences, findings };
}
