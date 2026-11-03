import {
  LITERATURE_PROVIDER_NAMES,
  LITERATURE_PROVIDERS,
  type LiteratureProviderId,
  type LiteratureSearchFilters,
  type LiteratureSearchMode,
  type LiteratureSort,
  type ProviderSearchOutcome,
  type PublicationType,
  type ScholarlyAuthor,
  type ScholarlyWork,
} from '@research-studio/shared-types';

export const providerName = (id: LiteratureProviderId) => LITERATURE_PROVIDER_NAMES[id];

export const TYPE_LABEL: Record<PublicationType, string> = {
  'journal-article': 'Journal article',
  preprint: 'Preprint',
  review: 'Review',
  'conference-paper': 'Conference paper',
  book: 'Book',
  'book-chapter': 'Book chapter',
  dissertation: 'Thesis',
  report: 'Report',
  dataset: 'Dataset',
  editorial: 'Editorial',
  letter: 'Letter',
  erratum: 'Erratum',
  other: 'Other',
};

/** Types offered as filters; the rest are rare enough to reach through "All types". */
export const FILTER_TYPES: PublicationType[] = ['journal-article', 'preprint', 'conference-paper', 'review', 'book', 'book-chapter', 'dissertation', 'report'];

export const MODE_LABEL: Record<LiteratureSearchMode, string> = {
  all: 'All fields',
  title: 'Title',
  author: 'Author',
  'title-abstract': 'Title and abstract',
};

export const SORT_LABEL: Record<LiteratureSort, string> = {
  relevance: 'Relevance',
  newest: 'Newest first',
  oldest: 'Oldest first',
  citations: 'Most cited',
};

/** The text form of the filters, as typed. */
export interface FilterDraft {
  authors: string;
  venue: string;
  yearFrom: string;
  yearTo: string;
  types: PublicationType[];
  openAccessOnly: boolean;
  categories: string;
}

export const EMPTY_FILTERS: FilterDraft = { authors: '', venue: '', yearFrom: '', yearTo: '', types: [], openAccessOnly: false, categories: '' };

export function isEmptyDraft(d: FilterDraft): boolean {
  return !d.authors.trim() && !d.venue.trim() && !d.yearFrom.trim() && !d.yearTo.trim() && !d.types.length && !d.openAccessOnly && !d.categories.trim();
}

const CATEGORY = /^[a-z-]{2,16}(\.[A-Za-z-]{2,8})?$/;

function year(raw: string, label: string): number | undefined | string {
  const t = raw.trim();
  if (!t) return undefined;
  if (!/^\d{4}$/.test(t)) return `${label} must be a four-digit year.`;
  return Number(t);
}

/** Turn the typed filters into request filters, or explain what is wrong. */
export function buildFilters(d: FilterDraft): { filters?: LiteratureSearchFilters; error?: string } {
  const filters: LiteratureSearchFilters = {};
  // Names contain commas ("Shor, Peter"), so several authors are separated by semicolons.
  const authors = d.authors.split(';').map((a) => a.trim()).filter(Boolean);
  if (authors.length > 5) return { error: 'Filter by at most 5 authors.' };
  if (authors.some((a) => a.length > 100)) return { error: 'An author name is too long.' };
  if (authors.length) filters.authors = authors;

  const venue = d.venue.trim();
  if (venue.length > 200) return { error: 'The venue name is too long.' };
  if (venue) filters.venues = [venue];

  const from = year(d.yearFrom, 'The start year');
  if (typeof from === 'string') return { error: from };
  const to = year(d.yearTo, 'The end year');
  if (typeof to === 'string') return { error: to };
  if (from !== undefined && to !== undefined && from > to) return { error: 'The start year is after the end year.' };
  if (from !== undefined) filters.yearFrom = from;
  if (to !== undefined) filters.yearTo = to;

  if (d.types.length) filters.publicationTypes = [...d.types];
  if (d.openAccessOnly) filters.openAccessOnly = true;

  const categories = d.categories.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
  const bad = categories.find((c) => !CATEGORY.test(c));
  if (bad) return { error: `“${bad}” is not an arXiv category (for example quant-ph, math.PR or cs.LG).` };
  if (categories.length > 20) return { error: 'Filter by at most 20 categories.' };
  if (categories.length) filters.categories = categories;

  return Object.keys(filters).length ? { filters } : {};
}

/** The typed form of saved filters (history entries). */
export function draftFromFilters(f: LiteratureSearchFilters | undefined): FilterDraft {
  if (!f) return EMPTY_FILTERS;
  return {
    authors: (f.authors ?? []).join('; '),
    venue: f.venues?.[0] ?? '',
    yearFrom: f.yearFrom !== undefined ? String(f.yearFrom) : '',
    yearTo: f.yearTo !== undefined ? String(f.yearTo) : '',
    types: [...(f.publicationTypes ?? [])],
    openAccessOnly: f.openAccessOnly ?? false,
    categories: (f.categories ?? []).join(', '),
  };
}

/** "Shor, Preskill and Gottesman" / "Shor, Preskill, Gottesman +4 more". */
export function authorLine(authors: ScholarlyAuthor[], max = 3): string {
  if (!authors.length) return 'Unknown authors';
  const names = authors.slice(0, max).map((a) => a.name);
  if (authors.length > max) return `${names.join(', ')} +${authors.length - max} more`;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function providersOf(work: ScholarlyWork): LiteratureProviderId[] {
  const present = new Set(work.sourceRecords.map((r) => r.provider));
  return LITERATURE_PROVIDERS.filter((p) => present.has(p));
}

/** "Found in OpenAlex and Crossref". */
export function foundIn(providers: LiteratureProviderId[]): string {
  const names = providers.map(providerName);
  if (!names.length) return 'No source recorded';
  if (names.length === 1) return `Found in ${names[0]}`;
  return `Found in ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const number = new Intl.NumberFormat();
export const formatCount = (n: number) => number.format(n);

/** Short status of one provider's part in a search. */
export function outcomeLabel(o: ProviderSearchOutcome): string {
  switch (o.status) {
    case 'success':
      return o.resultCount === 1 ? '1 result' : `${formatCount(o.resultCount)} results`;
    case 'partial':
      return `${formatCount(o.resultCount)} results, incomplete`;
    case 'rate_limited':
      return 'Rate limited';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Not searched';
  }
}

/** One sentence for screen readers after a search. */
export function searchSummary(resultCount: number, total: number | null, outcomes: ProviderSearchOutcome[]): string {
  const head = resultCount === 0 ? 'No results' : `${formatCount(resultCount)} result${resultCount === 1 ? '' : 's'}${total && total > resultCount ? ` of about ${formatCount(total)}` : ''}`;
  const trouble = outcomes.filter((o) => o.status === 'failed' || o.status === 'rate_limited' || o.status === 'partial');
  if (!trouble.length) return `${head}.`;
  return `${head}. ${trouble.map((o) => `${providerName(o.provider)}: ${outcomeLabel(o).toLowerCase()}`).join('; ')}.`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "3 minutes ago", for provider health. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return relative.format(s, 'second');
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86_400), 'day');
}

/**
 * What the provider last said about its limits, from its response headers
 * (only values it reported; nothing is estimated).
 */
export function rateLimitSummary(rl: Record<string, string> | null): string | null {
  if (!rl) return null;
  const parts: string[] = [];
  const remUsd = rl['x-ratelimit-remaining-usd'];
  const limUsd = rl['x-ratelimit-limit-usd'];
  if (remUsd !== undefined) parts.push(`$${remUsd}${limUsd !== undefined ? ` of $${limUsd}` : ''} of daily allowance left`);
  else if (rl['x-ratelimit-remaining'] !== undefined) {
    const lim = rl['x-ratelimit-limit'];
    parts.push(`${rl['x-ratelimit-remaining']}${lim !== undefined ? ` of ${lim}` : ''} requests left`);
  }
  if (rl['x-api-pool']) parts.push(`${rl['x-api-pool']} pool`);
  if (rl['x-rate-limit-limit'] && rl['x-rate-limit-interval']) parts.push(`${rl['x-rate-limit-limit']} request${rl['x-rate-limit-limit'] === '1' ? '' : 's'} per ${rl['x-rate-limit-interval']}`);
  if (rl['x-concurrency-limit']) parts.push(`${rl['x-concurrency-limit']} at a time`);
  return parts.length ? `Last reported: ${parts.join(', ')}.` : null;
}

/** Canonical author ID for the profile route, if the author carries one. */
export function authorProfileId(a: ScholarlyAuthor): string | null {
  if (a.providerIds.openalex) return `openalex:${a.providerIds.openalex}`;
  if (a.providerIds['semantic-scholar']) return `semantic-scholar:${a.providerIds['semantic-scholar']}`;
  return null;
}
