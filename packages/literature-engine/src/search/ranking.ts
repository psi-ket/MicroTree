import type { LiteratureSearchMode, LiteratureSort, RankedWork, ScholarlyWork } from '@research-studio/shared-types';
import { familyKey, nameTokens } from '../normalization/author-normalizer';
import { titleKey, tokenize } from '../normalization/work-normalizer';
import { compareDates } from '../normalization/date-normalizer';
import type { QueryIntent } from './query-parser';

/** A query term matches a word that equals it or extends it by a short suffix (code → codes, decoder → decoders). */
function hasTerm(words: Set<string>, term: string): boolean {
  if (words.has(term)) return true;
  if (term.length < 3) return false;
  for (const w of words) if (w.length > term.length && w.length - term.length <= 3 && w.startsWith(term)) return true;
  return false;
}

export interface RankingCandidate {
  work: ScholarlyWork;
  /** Best position (0-based) the work had in any provider's own result list, relative to the page size (0…1). */
  providerPosition: number | null;
}

/**
 * Deterministic relevance score. Weights, highest first:
 * title (exact 60, phrase 30, term coverage 30) · author match (author mode 40,
 * otherwise 10) · abstract term coverage 12 (phrase +6) · the providers' own
 * ranking (up to 10) · agreement between providers (3 per extra provider, max 6) ·
 * query intent (year named in the query 8, "recent" up to 6, "review" 8).
 * Citation counts are not used: they say nothing about relevance or correctness.
 */
export function scoreWork(c: RankingCandidate, intent: QueryIntent, mode: LiteratureSearchMode, currentYear: number): { score: number; signals: string[] } {
  const w = c.work;
  const signals: string[] = [];
  let score = 0;
  const title = titleKey(w.title);
  const titleTokens = new Set(tokenize(w.title));
  const terms = intent.terms;

  if (mode !== 'author' && terms.length) {
    if (intent.phrase && title === intent.phrase) {
      score += 60;
      signals.push('title-exact');
    } else if (intent.phrase && terms.length > 1 && ` ${title} `.includes(` ${intent.phrase} `)) {
      score += 30;
      signals.push('title-phrase');
    }
    const covered = terms.filter((t) => hasTerm(titleTokens, t)).length / terms.length;
    if (covered > 0) {
      score += 30 * covered;
      if (covered === 1) signals.push('title-all-terms');
    }
    if (w.abstract) {
      const abstractKey = ` ${titleKey(w.abstract)} `;
      const abstractWords = new Set(abstractKey.split(' ').filter(Boolean));
      const inAbstract = terms.filter((t) => hasTerm(abstractWords, t)).length / terms.length;
      score += 12 * inAbstract;
      if (intent.phrase && terms.length > 1 && abstractKey.includes(` ${intent.phrase} `)) {
        score += 6;
        signals.push('abstract-phrase');
      }
    }
  }

  // Author matches: whole query in author mode, single name words otherwise.
  const families = new Set(w.authors.map(familyKey).filter((k): k is string => !!k));
  const nameWords = new Set(w.authors.flatMap(nameTokens));
  if (mode === 'author') {
    const words = tokenize(intent.phrase || '').filter((t) => t.length > 1);
    const matched = words.filter((t) => nameWords.has(t) || families.has(t)).length;
    if (words.length && matched) {
      score += 40 * (matched / words.length);
      signals.push('author');
    }
  } else if (terms.some((t) => families.has(t))) {
    score += 10;
    signals.push('author');
  }

  if (c.providerPosition !== null) score += 10 * (1 - Math.min(1, c.providerPosition));
  const providers = new Set(w.sourceRecords.map((r) => r.provider)).size;
  if (providers > 1) {
    score += Math.min(6, 3 * (providers - 1));
    signals.push(`found-by-${providers}-providers`);
  }

  if (w.publicationYear !== null) {
    if (intent.years.includes(w.publicationYear)) {
      score += 8;
      signals.push('year-in-query');
    }
    if (intent.wantsRecent) score += Math.max(0, 6 - Math.max(0, currentYear - w.publicationYear));
  }
  if (intent.wantsReview && w.publicationType === 'review') {
    score += 8;
    signals.push('review');
  }
  return { score: Math.round(score * 100) / 100, signals };
}

const byTitle = (a: ScholarlyWork, b: ScholarlyWork) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

function byDate(a: ScholarlyWork, b: ScholarlyWork, direction: 1 | -1): number {
  const da = a.publicationDate ?? (a.publicationYear !== null ? String(a.publicationYear) : null);
  const db = b.publicationDate ?? (b.publicationYear !== null ? String(b.publicationYear) : null);
  if (da === null && db === null) return 0;
  if (da === null) return 1; // unknown dates last in both directions
  if (db === null) return -1;
  return direction * compareDates(da, db);
}

/**
 * Order candidates. Relevance: score, then newer first, then title. Newest /
 * oldest: publication date (unknown last), then score. Citations: the shown
 * citation count (its provider is on the work), unknown last, then score.
 */
export function rankWorks(candidates: RankingCandidate[], intent: QueryIntent, mode: LiteratureSearchMode, sort: LiteratureSort, currentYear: number): RankedWork[] {
  const scored = candidates.map((c) => ({ c, ...scoreWork(c, intent, mode, currentYear) }));
  scored.sort((x, y) => {
    const a = x.c.work;
    const b = y.c.work;
    if (sort === 'newest' || sort === 'oldest') {
      const d = byDate(a, b, sort === 'newest' ? -1 : 1);
      if (d) return d;
    } else if (sort === 'citations') {
      const ca = a.citation.citedByCount;
      const cb = b.citation.citedByCount;
      if (ca !== cb) {
        if (ca === null) return 1;
        if (cb === null) return -1;
        return cb - ca;
      }
    }
    return y.score - x.score || byDate(a, b, -1) || byTitle(a, b);
  });
  return scored.map(({ c, score, signals }) => ({ work: c.work, score, signals }));
}
