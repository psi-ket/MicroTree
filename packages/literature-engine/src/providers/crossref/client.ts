import type { PublicationType, ScholarlySourceRecord } from '@research-studio/shared-types';
import type { LiteratureProvider, ProviderCapabilities, ProviderContext, ProviderSearchPage, ProviderSearchQuery } from '../../types/provider';
import { ProviderHttp } from '../http';
import { encodePath, invalidResponse, mapItems, nowIso, titleContainsTerms, userAgent, type ProviderConfig } from '../shared';
import { mapCrossrefWork } from './mapper';
import { CROSSREF_SELECT, CrossrefList, CrossrefSingle, CrossrefWork } from './schemas';

export const CROSSREF_BASE_URL = 'https://api.crossref.org';

const TYPE_FILTER: Partial<Record<PublicationType, string[]>> = {
  'journal-article': ['journal-article'],
  'conference-paper': ['proceedings-article'],
  preprint: ['posted-content'],
  book: ['book', 'monograph', 'edited-book', 'reference-book'],
  'book-chapter': ['book-chapter', 'book-section', 'book-part'],
  dissertation: ['dissertation'],
  report: ['report'],
  dataset: ['dataset'],
};

const CAPABILITIES: ProviderCapabilities = {
  modes: { all: 'native', title: 'native', author: 'native', 'title-abstract': 'native' },
  filters: {
    authors: 'native',
    yearFrom: 'native',
    yearTo: 'native',
    publicationTypes: 'native',
    venues: 'native',
    // Crossref says nothing about open access or subject categories that could be filtered on.
    openAccessOnly: 'unsupported',
    categories: 'unsupported',
  },
  sorts: ['relevance', 'newest', 'oldest', 'citations'],
  lookups: { doi: true, arxiv: false, openalex: false, semanticScholar: false },
  references: false,
  citations: false,
  authors: false,
  // `offset` is limited to 10 000; deeper paging needs cursors.
  maxResults: 10_000,
  maxPageSize: 100,
};

export class CrossrefProvider implements LiteratureProvider {
  readonly id = 'crossref' as const;
  readonly capabilities = CAPABILITIES;
  private readonly http: ProviderHttp;
  private readonly base: string;

  constructor(private readonly config: ProviderConfig = {}) {
    this.base = (config.baseUrl ?? CROSSREF_BASE_URL).replace(/\/+$/, '');
    const polite = !!config.mailto;
    this.http = new ProviderHttp({
      provider: 'crossref',
      fetch: config.fetch,
      userAgent: userAgent(config),
      // Since 2025-12-01: public pool 1 list request/s, concurrency 1; polite pool 3/s, concurrency 3.
      minIntervalMs: config.minIntervalMs ?? (polite ? 350 : 1000),
      maxConcurrent: polite ? 3 : 1,
      timeoutMs: config.timeoutMs ?? 15_000,
      backoffBaseMs: config.backoffBaseMs,
      maxRetries: config.maxRetries,
      secretParams: ['mailto'],
      rateLimitHeaders: ['x-rate-limit-limit', 'x-rate-limit-interval', 'x-concurrency-limit', 'x-api-pool'],
      onObservation: config.onObservation,
      sleep: config.sleep,
      now: config.now,
    });
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    if (this.config.mailto) u.searchParams.set('mailto', this.config.mailto);
    return u.toString();
  }

  skipReason(q: ProviderSearchQuery): string | null {
    const types = q.filters.publicationTypes;
    if (types?.length && !types.some((t) => TYPE_FILTER[t])) return 'Crossref has no matching publication types';
    return null;
  }

  async search(q: ProviderSearchQuery, ctx: ProviderContext): Promise<ProviderSearchPage> {
    const notes: string[] = [];
    const params: Record<string, string | number | undefined> = {};
    const text = q.text.trim();
    if (q.mode === 'author') params['query.author'] = text;
    else if (q.mode === 'all') params.query = text;
    else {
      params['query.bibliographic'] = text;
      notes.push(
        q.mode === 'title'
          ? 'Crossref title matches are checked locally against the title'
          : 'Crossref rarely has abstracts; matched on bibliographic fields',
      );
    }
    const f = q.filters;
    if (f.authors?.length) params['query.author'] = [params['query.author'], ...f.authors].filter(Boolean).join(' ');
    if (f.venues?.length) params['query.container-title'] = f.venues.join(' ');
    const filters: string[] = [];
    if (f.yearFrom !== undefined) filters.push(`from-pub-date:${f.yearFrom}`);
    if (f.yearTo !== undefined) filters.push(`until-pub-date:${f.yearTo}`);
    for (const t of new Set((f.publicationTypes ?? []).flatMap((t) => TYPE_FILTER[t] ?? []))) filters.push(`type:${t}`);
    if (filters.length) params.filter = filters.join(',');
    if (q.sort === 'newest' || q.sort === 'oldest') {
      params.sort = 'published';
      params.order = q.sort === 'newest' ? 'desc' : 'asc';
    } else if (q.sort === 'citations') {
      params.sort = 'is-referenced-by-count';
      params.order = 'desc';
    }
    const offset = typeof q.position === 'number' ? q.position : 0;
    const rows = Math.min(q.pageSize, CAPABILITIES.maxPageSize);
    if (offset >= CAPABILITIES.maxResults) return { records: [], total: null, next: null, notes };

    const { data, url } = await this.http.getJson(this.url('/works', { ...params, select: CROSSREF_SELECT, rows, offset }), { signal: ctx.signal });
    const parsed = CrossrefList.safeParse(data);
    if (!parsed.success || parsed.data.status !== 'ok') throw invalidResponse('crossref', 'work list');
    const retrievedAt = nowIso(this.config);
    const mapped = mapItems(parsed.data.message.items, CrossrefWork, (w) => mapCrossrefWork(w, retrievedAt, url));
    const { skipped } = mapped;
    // `query.bibliographic` also matches authors and venues; title mode keeps only works whose title has the words.
    const records = q.mode === 'title' ? mapped.records.filter((r) => titleContainsTerms(r.title, text)) : mapped.records;
    const total = parsed.data.message['total-results'] ?? null;
    const next = offset + rows;
    return { records, total, next: mapped.records.length + skipped > 0 && next < Math.min(total ?? 0, CAPABILITIES.maxResults) ? next : null, notes, skipped };
  }

  async getByDoi(doi: string, ctx: ProviderContext): Promise<ScholarlySourceRecord | null> {
    const { status, data, url } = await this.http.getJson(this.url(`/works/${encodePath(doi)}`), { signal: ctx.signal, acceptStatuses: [404] });
    if (status === 404) return null;
    const parsed = CrossrefSingle.safeParse(data);
    const work = parsed.success ? CrossrefWork.safeParse(parsed.data.message) : null;
    if (!work?.success) throw invalidResponse('crossref', 'work');
    return mapCrossrefWork(work.data, nowIso(this.config), url);
  }

  async check(ctx: ProviderContext): Promise<void> {
    await this.http.getJson(this.url('/works/10.1103/physreva.52.r2493'), { signal: ctx.signal });
  }
}
