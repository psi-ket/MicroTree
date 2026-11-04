import { sha256 } from '@research-studio/claim-anchors';
import type { PassageCandidate } from '../retrieval/types';

/**
 * Identity of a source snapshot: the exact text with where it came from. Two
 * claims that retrieve the same passage share one snapshot; a re-extraction
 * that changes the text produces a new one, and the old one is kept.
 */
export function snapshotHash(c: Pick<PassageCandidate, 'level' | 'passageId' | 'extractionId' | 'sourceSha256' | 'externalId' | 'scholarlyWorkId' | 'text'>): string {
  return sha256([c.level, c.passageId ?? '', c.extractionId ?? '', c.sourceSha256 ?? '', c.externalId ?? '', c.scholarlyWorkId ?? '', c.text].join('\u0000'));
}

/** Location in words, only from what the extractor reported (never estimated). */
export function locationText(c: Pick<PassageCandidate, 'level' | 'pageStart' | 'pageEnd' | 'sectionPath'>): string {
  if (c.level !== 'full_text') return c.level === 'abstract' ? 'abstract (no full text)' : 'abstract from an external source';
  const parts: string[] = [];
  if (c.pageStart) parts.push(c.pageEnd && c.pageEnd !== c.pageStart ? `pages ${c.pageStart}–${c.pageEnd}` : `page ${c.pageStart}`);
  else parts.push('page not reported by the extractor');
  if (c.sectionPath) parts.push(`section "${c.sectionPath}"`);
  return parts.join(', ');
}
