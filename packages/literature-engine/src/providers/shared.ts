import type { LiteratureSearchFilters, PublicationType, ScholarlyAuthor, ScholarlySourceRecord } from '@research-studio/shared-types';
import type { z } from 'zod';
import { LiteratureProviderError } from '../errors/provider-errors';
import type { HttpObservation } from './http';
import { familyKey, nameTokens } from '../normalization/author-normalizer';
import { contentTokens, titleKey } from '../normalization/work-normalizer';

/** Settings shared by every provider client. */
export interface ProviderConfig {
  baseUrl?: string;
  /** Optional API key (OpenAlex, Semantic Scholar). Never logged or returned. */
  apiKey?: string | null;
  /** Contact address for polite pools (Crossref, OpenAlex); only sent when configured. */
  mailto?: string | null;
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
  onObservation?: (o: HttpObservation) => void;
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  backoffBaseMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
}

export const DEFAULT_USER_AGENT = 'ResearchStudio/0.1 (local research IDE; literature search)';

export function userAgent(config: ProviderConfig): string {
  const base = config.userAgent ?? DEFAULT_USER_AGENT;
  return config.mailto ? `${base} (mailto:${config.mailto})` : base;
}

export function nowIso(config: ProviderConfig): string {
  return new Date((config.now ?? Date.now)()).toISOString();
}

/** Parse each list item on its own: one malformed record does not discard the page. */
export function mapItems<T>(
  items: unknown[],
  schema: z.ZodType<T>,
  map: (item: T) => ScholarlySourceRecord | null,
): { records: ScholarlySourceRecord[]; skipped: number } {
  const records: ScholarlySourceRecord[] = [];
  let skipped = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    const record = parsed.success ? map(parsed.data) : null;
    if (record) records.push(record);
    else skipped++;
  }
  return { records, skipped };
}

export function invalidResponse(provider: ScholarlySourceRecord['provider'], what: string, status: number | null = null): LiteratureProviderError {
  return new LiteratureProviderError(provider, 'invalid_response', `unexpected ${what} format`, status);
}

// ---------------------------------------------------------------- categories

export const CATEGORY_PATTERN = /^[a-z-]+(\.[A-Za-z-]+)?$/;

export type CategoryGroup = 'physics' | 'math' | 'cs' | 'q-bio' | 'q-fin' | 'stat' | 'eess' | 'econ';

const PHYSICS_ARCHIVES = new Set(['physics', 'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'math-ph', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph']);

/** The broad arXiv group of a category or archive (`quant-ph` → physics, `cs.LG` → cs). */
export function categoryGroup(category: string): CategoryGroup | null {
  const archive = category.split('.')[0]!.toLowerCase();
  if (PHYSICS_ARCHIVES.has(archive)) return 'physics';
  if (['math', 'cs', 'q-bio', 'q-fin', 'stat', 'eess', 'econ'].includes(archive)) return archive as CategoryGroup;
  return null;
}

export const CATEGORY_GROUP_LABEL: Record<CategoryGroup, string> = {
  physics: 'Physics',
  math: 'Mathematics',
  cs: 'Computer Science',
  'q-bio': 'Quantitative Biology',
  'q-fin': 'Quantitative Finance',
  stat: 'Statistics',
  eess: 'Electrical Engineering and Systems Science',
  econ: 'Economics',
};

// ---------------------------------------------------------------- query text

/** Split free text into quoted phrases and single terms, dropping provider syntax characters. */
export function queryParts(text: string): { phrases: string[]; terms: string[] } {
  const phrases: string[] = [];
  const rest = text.replace(/"([^"]{1,200})"/g, (_, p: string) => {
    const clean = p.replace(/[()[\]{}:|,"\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean) phrases.push(clean);
    return ' ';
  });
  const terms = rest
    .replace(/[()[\]{}:|,"\\*?]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]+/, '').trim())
    .filter((t) => t.length > 0 && !/^(and|or|not|andnot)$/i.test(t));
  return { phrases, terms };
}

/** Text safe to put inside an OpenAlex filter value (`,` and `|` are syntax there). */
export function filterValue(text: string): string {
  return text.replace(/[,|:]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- local filters

/**
 * Check a record against the request's filters (all but categories). Applied
 * to every provider's results: some native filters are only ranking hints
 * (Crossref `query.author`) or coarser than ours (OpenAlex `article`). A record
 * that lacks the value a filter needs (unknown year, unknown type) does not pass.
 */
export function passesFilters(record: ScholarlySourceRecord, filters: LiteratureSearchFilters): boolean {
  if (filters.yearFrom !== undefined && (record.publicationYear === null || record.publicationYear < filters.yearFrom)) return false;
  if (filters.yearTo !== undefined && (record.publicationYear === null || record.publicationYear > filters.yearTo)) return false;
  if (filters.openAccessOnly && record.openAccess.isOpenAccess !== true) return false;
  if (filters.publicationTypes?.length && !(record.publicationType && filters.publicationTypes.includes(record.publicationType))) return false;
  if (filters.venues?.length) {
    const venue = record.venue ? titleKey(record.venue) : '';
    if (!venue || !filters.venues.some((v) => venue.includes(titleKey(v)))) return false;
  }
  for (const wanted of filters.authors ?? []) if (!record.authors.some((a) => authorMatches(a, wanted))) return false;
  return true;
}

/**
 * Every content word of the query occurs in the title (as a word or word
 * prefix, so "code" matches "codes"). Used where a provider's title search
 * also matches other fields.
 */
export function titleContainsTerms(title: string, query: string): boolean {
  const words = ` ${titleKey(title)}`;
  const terms = contentTokens(query);
  return terms.length === 0 || terms.every((t) => words.includes(` ${t}`));
}

/** A free-text author name matches when the family names agree or every name word is present. */
export function authorMatches(author: ScholarlyAuthor, wanted: string): boolean {
  const tokens = nameTokens({ name: wanted });
  const family = familyKey({ name: wanted, familyName: null });
  const have = nameTokens(author);
  return (family !== null && familyKey(author) === family) || (tokens.length > 0 && tokens.every((t) => have.includes(t)));
}

/** Publication types a provider can serve at all (arXiv only has preprints). */
export function wantsType(filters: LiteratureSearchFilters, type: PublicationType): boolean {
  return !filters.publicationTypes?.length || filters.publicationTypes.includes(type);
}

/** Encode an identifier for a URL path, keeping `/` and `:` (DOIs may contain `#`, `?`, `;`, `<`…). */
export function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
}
