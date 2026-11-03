import type { PublicationType, ScholarlySourceRecord } from '@research-studio/shared-types';
import { normalizeOrcid, normalizeSemanticScholarId, type ArxivIdentifier } from '../../normalization/identifier-normalizer';
import { cleanText, safeUrl } from '../../normalization/work-normalizer';
import type {
  LiteratureProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderSearchPage,
  ProviderSearchQuery,
  RelatedWorksPage,
} from '../../types/provider';
import { ProviderHttp } from '../http';
import { CATEGORY_GROUP_LABEL, categoryGroup, encodePath, invalidResponse, mapItems, nowIso, queryParts, titleContainsTerms, userAgent, type CategoryGroup, type ProviderConfig } from '../shared';
import { mapS2Paper } from './mapper';
import { S2Author, S2AuthorPapers, S2Paper, S2RelatedResponse, S2SearchResponse, S2_PAPER_FIELDS } from './schemas';

export const SEMANTIC_SCHOLAR_BASE_URL = 'https://api.semanticscholar.org/graph/v1';

const FIELD_BY_GROUP: Record<CategoryGroup, string> = {
  physics: 'Physics',
  math: 'Mathematics',
  stat: 'Mathematics',
  cs: 'Computer Science',
  'q-bio': 'Biology',
  'q-fin': 'Economics',
  econ: 'Economics',
  eess: 'Engineering',
};

const TYPE_PARAM: Partial<Record<PublicationType, string[]>> = {
  'journal-article': ['JournalArticle'],
  review: ['Review', 'MetaAnalysis'],
  'conference-paper': ['Conference'],
  book: ['Book'],
  'book-chapter': ['BookSection'],
  dataset: ['Dataset'],
  editorial: ['Editorial'],
  letter: ['LettersAndComments'],
};

const CAPABILITIES: ProviderCapabilities = {
  // No title-only or author search on /paper/search.
  modes: { all: 'native', title: 'local', author: 'unsupported', 'title-abstract': 'native' },
  filters: {
    authors: 'local',
    yearFrom: 'native',
    yearTo: 'native',
    publicationTypes: 'local',
    venues: 'local',
    openAccessOnly: 'native',
    categories: 'native',
  },
  sorts: ['relevance'],
  lookups: { doi: true, arxiv: true, openalex: false, semanticScholar: true },
  references: true,
  citations: true,
  authors: true,
  maxResults: 1000,
  maxPageSize: 100,
};

const RELATED_FIELDS = 'paperId,externalIds,url,title,venue,year,publicationDate,publicationTypes,authors,citationCount,isOpenAccess';

export class SemanticScholarProvider implements LiteratureProvider {
  readonly id = 'semantic-scholar' as const;
  readonly capabilities = CAPABILITIES;
  private readonly http: ProviderHttp;
  private readonly base: string;

  constructor(private readonly config: ProviderConfig = {}) {
    this.base = (config.baseUrl ?? SEMANTIC_SCHOLAR_BASE_URL).replace(/\/+$/, '');
    this.http = new ProviderHttp({
      provider: 'semantic-scholar',
      fetch: config.fetch,
      userAgent: userAgent(config),
      // A key allows 1 request/s; keyless requests share a public pool.
      minIntervalMs: config.minIntervalMs ?? 1100,
      maxConcurrent: 1,
      timeoutMs: config.timeoutMs ?? 15_000,
      backoffBaseMs: config.backoffBaseMs ?? 1500,
      maxRetries: config.maxRetries,
      rateLimitHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
      onObservation: config.onObservation,
      sleep: config.sleep,
      now: config.now,
    });
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {};
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async search(q: ProviderSearchQuery, ctx: ProviderContext): Promise<ProviderSearchPage> {
    const notes: string[] = [];
    // Plain text only: quotes are not supported and hyphenated terms match nothing.
    const { phrases, terms } = queryParts(q.text);
    const query = [...phrases, ...terms].join(' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.mode === 'title') notes.push('Semantic Scholar has no title-only search; titles were checked after retrieval');

    const f = q.filters;
    const year =
      f.yearFrom !== undefined && f.yearTo !== undefined
        ? `${f.yearFrom}-${f.yearTo}`
        : f.yearFrom !== undefined
          ? `${f.yearFrom}-`
          : f.yearTo !== undefined
            ? `-${f.yearTo}`
            : undefined;
    let publicationTypes: string | undefined;
    if (f.publicationTypes?.length && f.publicationTypes.every((t) => TYPE_PARAM[t])) {
      publicationTypes = f.publicationTypes.flatMap((t) => TYPE_PARAM[t]!).join(',');
    }
    let fieldsOfStudy: string | undefined;
    if (f.categories?.length) {
      const groups = [...new Set(f.categories.map(categoryGroup).filter((g): g is CategoryGroup => g !== null))];
      if (groups.length) {
        fieldsOfStudy = [...new Set(groups.map((g) => FIELD_BY_GROUP[g]))].join(',');
        notes.push(`Categories approximated by fields of study: ${groups.map((g) => CATEGORY_GROUP_LABEL[g]).join(', ')}`);
      }
    }
    const offset = typeof q.position === 'number' ? q.position : 0;
    const limit = Math.min(q.pageSize, CAPABILITIES.maxPageSize, CAPABILITIES.maxResults - offset);
    if (limit <= 0) return { records: [], total: null, next: null, notes };

    const params: Record<string, string | number | undefined> = {
      query,
      offset,
      limit,
      fields: S2_PAPER_FIELDS,
      year,
      publicationTypes,
      fieldsOfStudy,
      venue: f.venues?.length ? f.venues.map((v) => v.replace(/,/g, ' ')).join(',') : undefined,
    };
    const u = new URL(this.url('/paper/search', params));
    if (f.openAccessOnly) u.searchParams.set('openAccessPdf', '');
    const { data, url } = await this.http.getJson(u.toString(), { signal: ctx.signal, headers: this.headers() });
    const parsed = S2SearchResponse.safeParse(data);
    if (!parsed.success) throw invalidResponse('semantic-scholar', 'search');
    const retrievedAt = nowIso(this.config);
    const { records, skipped } = mapItems(parsed.data.data ?? [], S2Paper, (p) => mapS2Paper(p, retrievedAt, url));
    const next = parsed.data.next ?? null;
    return {
      records: q.mode === 'title' ? records.filter((r) => titleContainsTerms(r.title, query)) : records,
      total: parsed.data.total ?? null,
      next: next !== null && next < CAPABILITIES.maxResults && records.length + skipped > 0 ? next : null,
      notes,
      skipped,
    };
  }

  private async paper(paperRef: string, ctx: ProviderContext): Promise<ScholarlySourceRecord | null> {
    const { status, data, url } = await this.http.getJson(this.url(`/paper/${encodePath(paperRef)}`, { fields: S2_PAPER_FIELDS }), {
      signal: ctx.signal,
      headers: this.headers(),
      acceptStatuses: [404],
    });
    if (status === 404) return null;
    const parsed = S2Paper.safeParse(data);
    if (!parsed.success) throw invalidResponse('semantic-scholar', 'paper');
    return mapS2Paper(parsed.data, nowIso(this.config), url);
  }

  getByDoi(doi: string, ctx: ProviderContext) {
    return this.paper(`DOI:${doi}`, ctx);
  }

  getByArxivId(id: ArxivIdentifier, ctx: ProviderContext) {
    return this.paper(`ARXIV:${id.id}`, ctx);
  }

  getById(providerId: string, ctx: ProviderContext) {
    const id = normalizeSemanticScholarId(providerId);
    return id ? this.paper(id, ctx) : Promise.resolve(null);
  }

  private async related(kind: 'references' | 'citations', record: ScholarlySourceRecord, limit: number, ctx: ProviderContext): Promise<RelatedWorksPage> {
    const ref = record.identifiers.semanticScholarId ?? (record.identifiers.doi ? `DOI:${record.identifiers.doi}` : record.identifiers.arxivId ? `ARXIV:${record.identifiers.arxivId}` : null);
    if (!ref) return { records: [], total: null };
    const { status, data, url } = await this.http.getJson(
      this.url(`/paper/${encodePath(ref)}/${kind}`, { limit: Math.min(limit, 100), fields: RELATED_FIELDS }),
      { signal: ctx.signal, headers: this.headers(), acceptStatuses: [404] },
    );
    if (status === 404) return { records: [], total: null };
    const parsed = S2RelatedResponse.safeParse(data);
    if (!parsed.success) throw invalidResponse('semantic-scholar', kind);
    const retrievedAt = nowIso(this.config);
    const items = (parsed.data.data ?? []).map((d) => (kind === 'citations' ? d.citingPaper : d.citedPaper));
    const { records } = mapItems(items, S2Paper, (p) => mapS2Paper(p, retrievedAt, url));
    const total = kind === 'citations' ? record.citedByCount : record.referenceCount;
    return { records, total: total ?? null };
  }

  references(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext) {
    return this.related('references', record, limit, ctx);
  }

  citations(record: ScholarlySourceRecord, limit: number, ctx: ProviderContext) {
    return this.related('citations', record, limit, ctx);
  }

  async getAuthor(authorId: string, ctx: ProviderContext) {
    const id = authorId.replace(/^semantic-scholar:/, '');
    if (!/^\d{1,15}$/.test(id)) return null;
    const { status, data } = await this.http.getJson(
      this.url(`/author/${id}`, { fields: 'name,url,affiliations,paperCount,citationCount,hIndex,externalIds' }),
      { signal: ctx.signal, headers: this.headers(), acceptStatuses: [404] },
    );
    if (status === 404) return null;
    const parsed = S2Author.safeParse(data);
    if (!parsed.success) throw invalidResponse('semantic-scholar', 'author');
    const a = parsed.data;
    const papers = await this.http.getJson(this.url(`/author/${id}/papers`, { limit: 10, fields: S2_PAPER_FIELDS }), {
      signal: ctx.signal,
      headers: this.headers(),
    });
    const list = S2AuthorPapers.safeParse(papers.data);
    const retrievedAt = nowIso(this.config);
    const { records } = mapItems(list.success ? (list.data.data ?? []) : [], S2Paper, (p) => mapS2Paper(p, retrievedAt, papers.url));
    const orcid = a.externalIds?.ORCID;
    return {
      id: `semantic-scholar:${id}`,
      provider: 'semantic-scholar' as const,
      name: cleanText(a.name) ?? id,
      orcid: normalizeOrcid(typeof orcid === 'string' ? orcid : null),
      affiliations: (a.affiliations ?? []).map((x) => cleanText(x)).filter((x): x is string => x !== null),
      worksCount: a.paperCount ?? null,
      citedByCount: a.citationCount ?? null,
      hIndex: a.hIndex ?? null,
      recordUrl: safeUrl(a.url) ?? `https://www.semanticscholar.org/author/${id}`,
      retrievedAt,
      works: records,
    };
  }

  async check(ctx: ProviderContext): Promise<void> {
    await this.http.getJson(this.url('/paper/649def34f8be52c8b66281af98ae884c09aef38b', { fields: 'title' }), {
      signal: ctx.signal,
      headers: this.headers(),
    });
  }
}

