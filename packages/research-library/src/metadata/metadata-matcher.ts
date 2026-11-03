import { diceSimilarity, familyKey, titleKey, titlesMatch } from '@research-studio/literature-engine';
import { MATCH_CONFIDENCES, type MatchCandidate, type MatchConfidence, type ScholarlyWork } from '@research-studio/shared-types';
import type { FoundIdentifier } from './identifier-extractor';

/** What the library knows about a file or record it is trying to identify. */
export interface MatchEvidence {
  /** Best available title (PDF metadata, page text, or an imported record). */
  title: string | null;
  authors: string[];
  year: number | null;
  /** Text of the first pages, when the evidence is a PDF. */
  text: string | null;
}

export type MatchRoute = { kind: 'doi' | 'arxiv'; identifier: FoundIdentifier } | { kind: 'search' };

const RANK: Record<MatchConfidence, number> = Object.fromEntries(MATCH_CONFIDENCES.map((c, i) => [c, i])) as Record<MatchConfidence, number>;

export const isExact = (c: MatchConfidence) => c === 'exact-doi' || c === 'exact-arxiv';

/** Whether most of a title's words occur in the first part of the text (titles are often broken over lines). */
export function titleAppearsIn(title: string, text: string | null): boolean {
  if (!text) return false;
  const words = titleKey(title).split(' ').filter((w) => w.length > 2);
  if (words.length < 3) return false;
  const haystack = new Set(titleKey(text.slice(0, 6000).replace(/-\s*\n\s*/g, '')).split(' '));
  const found = words.filter((w) => haystack.has(w)).length;
  return found / words.length >= 0.9;
}

function authorEvidence(work: ScholarlyWork, evidence: MatchEvidence): boolean {
  const first = work.authors[0];
  const family = first ? familyKey(first) : null;
  if (!family) return false;
  const named = evidence.authors.some((a) => titleKey(a).split(' ').includes(family));
  const inText = evidence.text ? titleKey(evidence.text.slice(0, 3000)).split(' ').includes(family) : false;
  return named || inText;
}

/** Score one candidate work found through `route`. */
export function scoreCandidate(work: ScholarlyWork, evidence: MatchEvidence, route: MatchRoute): MatchCandidate {
  const reasons: string[] = [];
  const titleSeen = (evidence.title !== null && titlesMatch(evidence.title, work.title)) || titleAppearsIn(work.title, evidence.text);

  if (route.kind === 'doi' || route.kind === 'arxiv') {
    const label = route.kind === 'doi' ? `DOI ${route.identifier.value}` : `arXiv ID ${route.identifier.value}`;
    const exact: MatchConfidence = route.kind === 'doi' ? 'exact-doi' : 'exact-arxiv';
    if (route.identifier.source === 'pdf-metadata') {
      reasons.push(`${label} is in the PDF's metadata`);
      return { work, confidence: exact, reasons };
    }
    if (route.identifier.source === 'record') {
      // The record names the identifier; it only needs to agree with the record's own title, if it has one.
      if (!evidence.title || titlesMatch(evidence.title, work.title) || diceSimilarity(titleKey(evidence.title), titleKey(work.title)) >= 0.8) {
        reasons.push(`${label} from the record`);
        return { work, confidence: exact, reasons };
      }
      reasons.push(`${label} from the record resolves to a work with a different title`);
      return { work, confidence: 'possible', reasons };
    }
    if (titleSeen) {
      reasons.push(`${label} is printed in the PDF`, 'and the title matches');
      return { work, confidence: exact, reasons };
    }
    reasons.push(`${label} is printed in the PDF, but the title does not match: it may be a cited work`);
    return { work, confidence: 'possible', reasons };
  }

  // Found by searching for the title.
  const sameTitle = evidence.title !== null && titlesMatch(evidence.title, work.title);
  const similarity = evidence.title ? diceSimilarity(titleKey(evidence.title), titleKey(work.title)) : 0;
  const author = authorEvidence(work, evidence);
  const yearOk = evidence.year === null || work.publicationYear === null || Math.abs(evidence.year - work.publicationYear) <= 1;
  if (sameTitle && author && yearOk) {
    reasons.push('Title matches', 'first author matches');
    if (evidence.year !== null && work.publicationYear !== null) reasons.push('year matches');
    return { work, confidence: 'strong', reasons };
  }
  if (sameTitle) reasons.push('Title matches');
  else if (titleSeen) reasons.push('Title appears in the PDF');
  else reasons.push(`Title is similar (${Math.round(similarity * 100)}%)`);
  if (!author) reasons.push('first author not confirmed');
  if (!yearOk) reasons.push(`year differs (${work.publicationYear} vs ${evidence.year})`);
  return { work, confidence: sameTitle || titleSeen || similarity >= 0.75 ? 'possible' : 'unresolved', reasons };
}

/** Candidates best first, without duplicates and without unrelated works. */
export function rankCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
  const best = new Map<string, MatchCandidate>();
  for (const c of candidates) {
    if (c.confidence === 'unresolved') continue;
    const prev = best.get(c.work.id);
    if (!prev || RANK[c.confidence] < RANK[prev.confidence]) best.set(c.work.id, c);
  }
  return [...best.values()].sort((a, b) => RANK[a.confidence] - RANK[b.confidence]).slice(0, 8);
}

/** Overall confidence: the best candidate's, except that two different exact or strong matches make it ambiguous. */
export function overallConfidence(ranked: MatchCandidate[]): MatchConfidence {
  const top = ranked[0];
  if (!top) return 'unresolved';
  const second = ranked[1];
  if (second && RANK[second.confidence] === RANK[top.confidence] && (isExact(top.confidence) || top.confidence === 'strong')) {
    return 'possible';
  }
  return top.confidence;
}
