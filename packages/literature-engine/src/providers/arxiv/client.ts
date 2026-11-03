import type { ScholarlySourceRecord } from '@research-studio/shared-types';
import { LiteratureProviderError } from '../../errors/provider-errors';
import type { ArxivIdentifier } from '../../normalization/identifier-normalizer';
import type { LiteratureProvider, ProviderCapabilities, ProviderContext, ProviderSearchPage, ProviderSearchQuery } from '../../types/provider';
import { ProviderHttp } from '../http';
import { CATEGORY_PATTERN, mapItems, nowIso, queryParts, userAgent, wantsType, type ProviderConfig } from '../shared';
import { mapArxivEntry } from './mapper';
import { ArxivEntry, readFeed } from './schemas';
import { parseXml, XmlError } from './xml';

export const ARXIV_BASE_URL = 'https://export.arxiv.org/api/query';

/** Archives that have subject classes (`math.GT`), so the archive alone needs `cat:math OR cat:math.*`. */
const ARCHIVES_WITH_SUBJECTS = new Set(['astro-ph', 'cond-mat', 'cs', 'econ', 'eess', 'math', 'nlin', 'physics', 'q-bio', 'q-fin', 'stat']);

const CAPABILITIES: ProviderCapabilities = {
  modes: { all: 'native', title: 'native', author: 'native', 'title-abstract': 'native' },
  filters: {
    authors: 'native',
    yearFrom: 'native',
    yearTo: 'native',
    publicationTypes: 'native',
    venues: 'unsupported',
    openAccessOnly: 'native',
    categories: 'native',
  },
  sorts: ['relevance', 'newest', 'oldest'],
  lookups: { doi: false, arxiv: true, openalex: false, semanticScholar: false },
  references: false,
  citations: false,
  authors: false,
  maxResults: 10_000,
  maxPageSize: 100,
};

function nameClause(name: string): string | null {
  const tokens = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return tokens.length ? tokens.map((t) => `au:${t}`).join(' AND ') : null;
}

function textClause(text: string, fields: string[]): string | null {
  const { phrases, terms } = queryParts(text);
  const parts = [...phrases.map((p) => `"${p}"`), ...terms];
  if (!parts.length) return null;
  return parts
    .map((part) => (fields.length === 1 ? `${fields[0]}:${part}` : `(${fields.map((f) => `${f}:${part}`).join(' OR ')})`))
    .join(' AND ');
}

function categoryClause(category: string): string | null {
  if (!CATEGORY_PATTERN.test(category)) return null;
  if (category.includes('.')) return `cat:${category}`;
  return ARCHIVES_WITH_SUBJECTS.has(category) ? `(cat:${category} OR cat:${category}.*)` : `cat:${category}`;
}

/** Build an arXiv `search_query` (field prefixes, AND/OR, submittedDate ranges). */
export function buildArxivQuery(q: Pick<ProviderSearchQuery, 'text' | 'mode' | 'filters'>): string | null {
  const clauses: string[] = [];
  const main =
    q.mode === 'title'
      ? textClause(q.text, ['ti'])
      : q.mode === 'author'
        ? nameClause(q.text)
        : q.mode === 'title-abstract'
          ? textClause(q.text, ['ti', 'abs'])
          : textClause(q.text, ['all']);
  if (!main) return null;
  clauses.push(main.includes(' OR ') && !main.startsWith('(') ? `(${main})` : main);
  for (const a of q.filters.authors ?? []) {
    const c = nameClause(a);
    if (c) clauses.push(c);
  }
  const cats = (q.filters.categories ?? []).map(categoryClause).filter((c): c is string => c !== null);
  if (cats.length) clauses.push(cats.length === 1 ? cats[0]! : `(${cats.join(' OR ')})`);
  if (q.filters.yearFrom !== undefined || q.filters.yearTo !== undefined) {
    const from = q.filters.yearFrom ?? 1991;
    const to = q.filters.yearTo ?? 2999;
    clauses.push(`submittedDate:[${from}01010000 TO ${to}12312359]`);
  }
  return clauses.join(' AND ');
}

export class ArxivProvider implements LiteratureProvider {
  readonly id = 'arxiv' as const;
  readonly capabilities = CAPABILITIES;
  private readonly http: ProviderHttp;
  private readonly base: string;

  constructor(private readonly config: ProviderConfig = {}) {
    this.base = config.baseUrl ?? ARXIV_BASE_URL;
    this.http = new ProviderHttp({
      provider: 'arxiv',
      fetch: config.fetch,
      userAgent: userAgent(config),
      // Terms of use: one request every three seconds, one connection at a time.
      minIntervalMs: config.minIntervalMs ?? 3000,
      spacing: 'end',
      maxConcurrent: 1,
      timeoutMs: config.timeoutMs ?? 20_000,
      backoffBaseMs: config.backoffBaseMs ?? 3000,
      maxRetries: config.maxRetries ?? 1,
      onObservation: config.onObservation,
      sleep: config.sleep,
      now: config.now,
    });
  }

  skipReason(q: ProviderSearchQuery): string | null {
    if (!wantsType(q.filters, 'preprint')) return 'arXiv only has preprints';
    return null;
  }

  private async feed(params: Record<string, string | number>, ctx: ProviderContext) {
    const u = new URL(this.base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const res = await this.http.get(u.toString(), { signal: ctx.signal, acceptStatuses: [400] });
    let feed;
    try {
      feed = readFeed(parseXml(res.text));
    } catch (err) {
      throw new LiteratureProviderError('arxiv', 'invalid_response', err instanceof XmlError ? `unreadable response (${err.message})` : 'unexpected response format', res.status);
    }
    if (feed.error || res.status === 400) throw new LiteratureProviderError('arxiv', 'bad_request', feed.error ?? 'the query was rejected', res.status);
    const retrievedAt = nowIso(this.config);
    const { records, skipped } = mapItems(feed.entries, ArxivEntry, (e) => mapArxivEntry(e, retrievedAt, res.url));
    return { records, skipped, total: feed.totalResults };
  }

  async search(q: ProviderSearchQuery, ctx: ProviderContext): Promise<ProviderSearchPage> {
    const notes: string[] = [];
    const searchQuery = buildArxivQuery(q);
    if (!searchQuery) return { records: [], total: 0, next: null, notes };
    const sortBy = q.sort === 'newest' || q.sort === 'oldest' ? 'submittedDate' : 'relevance';
    if (q.sort === 'citations') notes.push('arXiv does not report citations; results are in relevance order');
    if (q.sort === 'newest' || q.sort === 'oldest') notes.push('arXiv sorts by first submission date');
    const start = typeof q.position === 'number' ? q.position : 0;
    const max = Math.min(q.pageSize, CAPABILITIES.maxPageSize);
    const { records, skipped, total } = await this.feed(
      { search_query: searchQuery, start, max_results: max, sortBy, sortOrder: q.sort === 'oldest' ? 'ascending' : 'descending' },
      ctx,
    );
    const next = start + max;
    return { records, total, next: records.length + skipped > 0 && next < Math.min(total ?? 0, CAPABILITIES.maxResults) ? next : null, notes, skipped };
  }

  getByDoi(): Promise<ScholarlySourceRecord | null> {
    // arXiv DOIs (10.48550) are resolved through getByArxivId; other DOIs are not arXiv identifiers.
    return Promise.resolve(null);
  }

  async getByArxivId(id: ArxivIdentifier, ctx: ProviderContext): Promise<ScholarlySourceRecord | null> {
    const { records } = await this.feed({ id_list: `${id.id}${id.version ?? ''}`, max_results: 1 }, ctx);
    return records[0] ?? null;
  }

  async check(ctx: ProviderContext): Promise<void> {
    await this.feed({ id_list: '1706.03762', max_results: 1 }, ctx);
  }
}
