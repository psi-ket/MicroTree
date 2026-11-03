import type { PublicationType, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeOrcid, normalizeOpenAlexId, arxivDoi, type ArxivIdentifier } from '../../normalization/identifier-normalizer';
import { cleanText } from '../../normalization/work-normalizer';
import type {
  LiteratureProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderSearchPage,
  ProviderSearchQuery,
  RelatedWorksPage,
} from '../../types/provider';
import { ProviderHttp } from '../http';
import {
  CATEGORY_GROUP_LABEL,
  categoryGroup,
  encodePath,
  filterValue,
  invalidResponse,
  mapItems,
  nowIso,
  userAgent,
  type CategoryGroup,
  type ProviderConfig,
} from '../shared';
import { mapOpenAlexWork } from './mapper';
import { OpenAlexAuthor, OpenAlexList, OpenAlexWork } from './schemas';

export const OPENALEX_BASE_URL = 'https://api.openalex.org';

/** Fields requested for every work (keeps responses small; `select` does not change the cost). */
export const OPENALEX_SELECT = [
  'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date', 'type', 'ids', 'authorships',
  'primary_location', 'best_oa_location', 'open_access', 'cited_by_count', 'referenced_works_count', 'biblio',
  'abstract_inverted_index', 'primary_topic', 'language', 'is_retracted', 'updated_date', 'created_date',
].join(',');

/** OpenAlex fields (https://api.openalex.org/fields) used to approximate arXiv category groups. */
const FIELD_BY_GROUP: Record<CategoryGroup, string> = {
  physics: 'fields/31',
  math: 'fields/26',
  stat: 'fields/26',
  cs: 'fields/17',
  'q-bio': 'fields/13',
  'q-fin': 'fields/20',
  econ: 'fields/20',
  eess: 'fields/22',
};

const TYPE_FILTER: Partial<Record<PublicationType, string>> = {
  'journal-article': 'article',
  'conference-paper': 'article',
  preprint: 'preprint',
  review: 'review',
  book: 'book',
  'book-chapter': 'book-chapter',
  dissertation: 'dissertation',
  report: 'report',
  dataset: 'dataset',
  editorial: 'editorial',
  letter: 'letter',
  erratum: 'erratum',
};

const CAPABILITIES: ProviderCapabilities = {
  modes: { all: 'native', title: 'native', author: 'native', 'title-abstract': 'native' },
  filters: {
    authors: 'native',
    yearFrom: 'native',
    yearTo: 'native',
    // `article` covers journal and conference papers, so the exact type is also checked locally.
    publicationTypes: 'local',
    venues: 'local',
    openAccessOnly: 'native',
    categories: 'native',
  },
  sorts: ['relevance', 'newest', 'oldest', 'citations'],
  lookups: { doi: true, arxiv: true, openalex: true, semanticScholar: false },
  references: true,
  citations: true,
  authors: true,
  maxResults: 10_000,
  maxPageSize: 100,
};

export class OpenAlexProvider implements LiteratureProvider {
  readonly id = 'openalex' as const;
  readonly capabilities = CAPABILITIES;
  private readonly http: ProviderHttp;
  private readonly base: string;

  constructor(private readonly config: ProviderConfig = {}) {
    this.base = (config.baseUrl ?? OPENALEX_BASE_URL).replace(/\/+$/, '');
    this.http = new ProviderHttp({
      provider: 'openalex',
      fetch: config.fetch,
      userAgent: userAgent(config),
      // Documented: 10 requests/s without a key; stay well below.
      minIntervalMs: config.minIntervalMs ?? 150,
      maxConcurrent: 2,
      timeoutMs: config.timeoutMs ?? 15_000,
      backoffBaseMs: config.backoffBaseMs,
      maxRetries: config.maxRetries,
      secretParams: ['api_key', 'mailto'],
      rateLimitHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-limit-usd', 'x-ratelimit-remaining-usd', 'x-ratelimit-reset', 'x-ratelimit-cost-usd'],
      onObservation: config.onObservation,
      sleep: config.sleep,
      now: config.now,
    });
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    if (this.config.apiKey) u.searchParams.set('api_key', this.config.apiKey);
    if (this.config.mailto) u.searchParams.set('mailto', this.config.mailto);
    return u.toString();
  }

  private async list(params: Record<string, string | number | undefined>, ctx: ProviderContext) {
    const { data, url } = await this.http.getJson(this.url('/works', { select: OPENALEX_SELECT, ...params }), { signal: ctx.signal });
    const parsed = OpenAlexList.safeParse(data);
    if (!parsed.success) throw invalidResponse('openalex', 'list');
    const retrievedAt = nowIso(this.config);
    const { records, skipped } = mapItems(parsed.data.results, OpenAlexWork, (w) => mapOpenAlexWork(w, retrievedAt, url));
    return { records, skipped, meta: parsed.data.meta };
  }

  async search(q: ProviderSearchQuery, ctx: ProviderContext): Promise<ProviderSearchPage> {
    const filters: string[] = [];
    const notes: string[] = [];
    const text = q.text.trim();
    let search: string | undefined;
    if (q.mode === 'all') search = text;
    else if (q.mode === 'title') filters.push(`title.search:${filterValue(text)}`);
    else if (q.mode === 'author') filters.push(`raw_author_name.search:${filterValue(text)}`);
    else filters.push(`title_and_abstract.search:${filterValue(text)}`);

    const f = q.filters;
    for (const a of f.authors ?? []) if (filterValue(a)) filters.push(`raw_author_name.search:${filterValue(a)}`);
    if (f.yearFrom !== undefined && f.yearTo !== undefined) filters.push(`publication_year:${f.yearFrom}-${f.yearTo}`);
    else if (f.yearFrom !== undefined) filters.push(`publication_year:>${f.yearFrom - 1}`);
    else if (f.yearTo !== undefined) filters.push(`publication_year:<${f.yearTo + 1}`);
    if (f.openAccessOnly) filters.push('is_oa:true');
    if (f.publicationTypes?.length) {
      const types = [...new Set(f.publicationTypes.map((t) => TYPE_FILTER[t]).filter((t): t is string => !!t))];
      if (types.length) filters.push(`type:${types.join('|')}`);
    }
    if (f.categories?.length) {
      const groups = [...new Set(f.categories.map(categoryGroup).filter((g): g is CategoryGroup => g !== null))];
      if (groups.length) {
        filters.push(`primary_topic.field.id:${[...new Set(groups.map((g) => FIELD_BY_GROUP[g]))].join('|')}`);
        notes.push(`Categories approximated by OpenAlex fields: ${groups.map((g) => CATEGORY_GROUP_LABEL[g]).join(', ')}`);
      }
    }

    const sort =
      q.sort === 'newest' ? 'publication_date:desc' : q.sort === 'oldest' ? 'publication_date:asc' : q.sort === 'citations' ? 'cited_by_count:desc' : undefined;
    const page = typeof q.position === 'number' ? q.position : 1;
    const perPage = Math.min(q.pageSize, CAPABILITIES.maxPageSize);
    const { records, skipped, meta } = await this.list(
      { search, filter: filters.length ? filters.join(',') : undefined, sort, per_page: perPage, page },
      ctx,
    );
    const total = meta.count ?? null;
    const more = records.length + skipped > 0 && page * perPage < Math.min(total ?? 0, CAPABILITIES.maxResults);
    return { records, total, next: more ? page + 1 : null, notes, skipped };
  }

  private async single(path: string, ctx: ProviderContext): Promise<ScholarlySourceRecord | null> {
    const { status, data, url } = await this.http.getJson(this.url(path, { select: `${OPENALEX_SELECT},referenced_works` }), {
      signal: ctx.signal,
      acceptStatuses: [404],
    });
    if (status === 404) return null;
    const parsed = OpenAlexWork.safeParse(data);
    if (!parsed.success) throw invalidResponse('openalex', 'work');
    return mapOpenAlexWork(parsed.data, nowIso(this.config), url);
  }

  getByDoi(doi: string, ctx: ProviderContext) {
    return this.single(`/works/doi:${encodePath(doi)}`, ctx);
  }

  getByArxivId(id: ArxivIdentifier, ctx: ProviderContext) {
    return this.single(`/works/doi:${encodePath(arxivDoi(id.id))}`, ctx);
  }

  getById(providerId: string, ctx: ProviderContext) {
    const id = normalizeOpenAlexId(providerId);
    if (!id) return Promise.resolve(null);
    return this.single(`/works/${id}`, ctx);
  }

  private async related(filter: 'cites' | 'cited_by', record: ScholarlySourceRecord, limit: number, ctx: ProviderContext): Promise<RelatedWorksPage> {
    const id = record.identifiers.openAlexId;
    if (!id) return { records: [], total: null };
    const { records, meta } = await this.list({ filter: `${filter}:${id}`, per_page: Math.min(limit, 100), sort: 'cited_by_count:desc' }, ctx);
    return { records, total: meta.count ?? null };
  }

  /** Works this work cites. */
  references(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext) {
    return this.related('cited_by', record, limit, ctx);
  }

  /** Works that cite this work. */
  citations(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext) {
    return this.related('cites', record, limit, ctx);
  }

  async getAuthor(authorId: string, ctx: ProviderContext) {
    const id = normalizeOpenAlexId(authorId, 'A');
    if (!id) return null;
    const { status, data } = await this.http.getJson(
      this.url(`/authors/${id}`, { select: 'id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions' }),
      { signal: ctx.signal, acceptStatuses: [404] },
    );
    if (status === 404) return null;
    const parsed = OpenAlexAuthor.safeParse(data);
    if (!parsed.success) throw invalidResponse('openalex', 'author');
    const a = parsed.data;
    const { records } = await this.list({ filter: `authorships.author.id:${id}`, sort: 'publication_date:desc', per_page: 10 }, ctx);
    return {
      id: `openalex:${id}`,
      provider: 'openalex' as const,
      name: cleanText(a.display_name) ?? id,
      orcid: normalizeOrcid(a.orcid),
      affiliations: (a.last_known_institutions ?? []).map((i) => cleanText(i.display_name)).filter((n): n is string => n !== null),
      worksCount: a.works_count ?? null,
      citedByCount: a.cited_by_count ?? null,
      hIndex: a.summary_stats?.h_index ?? null,
      recordUrl: `https://openalex.org/${id}`,
      retrievedAt: nowIso(this.config),
      works: records,
    };
  }

  async check(ctx: ProviderContext): Promise<void> {
    // Single-entity requests are free of charge.
    await this.http.getJson(this.url('/works/W2741809807', { select: 'id' }), { signal: ctx.signal });
  }
}
