import { createHash } from 'node:crypto';
import {
  LITERATURE_PROVIDER_NAMES,
  LITERATURE_PROVIDERS,
  type InterpretedQuery,
  type LiteratureProviderId,
  type LiteratureSearchFilters,
  type LiteratureSearchMode,
  type LiteratureSearchRequest,
  type LiteratureSearchResult,
  type LiteratureSort,
  type ProviderSearchOutcome,
  type ScholarlyAuthorProfile,
  type ScholarlySourceRecord,
  type ScholarlyWork,
} from '@research-studio/shared-types';
import { deduplicate } from '../deduplication/deduplicate';
import { identifierKeys } from '../deduplication/identifier-matching';
import { sameWorkByMetadata } from '../deduplication/title-matching';
import { isProviderError, LiteratureProviderError } from '../errors/provider-errors';
import { mergeRecords } from '../metadata/metadata-merger';
import { parseWorkId, workKeys } from '../metadata/work-metadata';
import { parseArxivId, type ArxivIdentifier } from '../normalization/identifier-normalizer';
import { baseRecord } from '../normalization/work-normalizer';
import { passesFilters } from '../providers/shared';
import type { LiteratureProvider, ProviderSearchPage, ProviderSearchQuery } from '../types/provider';
import { CursorStore, LiteratureRequestError } from './pagination';
import { interpretQuery, queryIntent } from './query-parser';
import { rankWorks, type RankingCandidate } from './ranking';

/** Optional persistent cache (the runtime stores it in SQLite). */
export interface LiteratureCache {
  get(key: string): Promise<{ value: unknown; retrievedAt: string } | null>;
  set(key: string, entry: { provider: LiteratureProviderId; kind: 'record' | 'search'; value: unknown; ttlMs: number }): Promise<void>;
}

export interface SearchServiceOptions {
  providers: LiteratureProvider[];
  cache?: LiteratureCache;
  /** Whole-search deadline; providers still running are reported as timed out. */
  timeoutMs?: number;
  cursorTtlMs?: number;
  /** How long a provider's result page stays cached (arXiv asks clients to cache; its index updates daily). */
  searchTtlMs?: Partial<Record<LiteratureProviderId, number>> & { default?: number };
  recordTtlMs?: number;
  notFoundTtlMs?: number;
  maxLimit?: number;
  now?: () => number;
}

/** Raised when every provider asked failed, so "not found" would be a guess. */
export class LiteratureUnavailableError extends Error {
  override name = 'LiteratureUnavailableError';
  constructor(
    message: string,
    readonly outcomes: ProviderSearchOutcome[],
  ) {
    super(message);
  }
}

export class LiteratureCancelledError extends Error {
  override name = 'LiteratureCancelledError';
}

interface NormalizedRequest {
  query: string;
  mode: LiteratureSearchMode;
  providers: LiteratureProviderId[];
  filters: LiteratureSearchFilters;
  sort: LiteratureSort;
  limit: number;
}

interface SearchState {
  key: string;
  request: NormalizedRequest;
  positions: Partial<Record<LiteratureProviderId, unknown>>;
  active: LiteratureProviderId[];
  pending: ScholarlySourceRecord[];
  /** Best rank of each pending record in its provider's list (0…1). */
  rank: Record<string, number>;
  seenKeys: string[];
  seenWorks: ScholarlySourceRecord[];
  outcomes: Partial<Record<LiteratureProviderId, ProviderSearchOutcome>>;
}

export interface RelatedWorks {
  works: ScholarlyWork[];
  total: number | null;
  provider: LiteratureProviderId | null;
  outcomes: ProviderSearchOutcome[];
}

const recordKey = (r: ScholarlySourceRecord) => `${r.provider}:${r.providerId}`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('base64url').slice(0, 32);

function cleanList(values: string[] | undefined, max = 20): string[] | undefined {
  const list = [...new Set((values ?? []).map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, max);
  return list.length ? list : undefined;
}

/** A stand-in record for a returned work, for metadata duplicate checks on later pages. */
function fingerprint(work: ScholarlyWork): ScholarlySourceRecord {
  const r = baseRecord(work.sourceRecords[0]!.provider, work.id, work.title, work.createdAt, null);
  r.authors = work.authors;
  r.publicationYear = work.publicationYear;
  r.identifiers = { ...work.identifiers };
  return r;
}

export class LiteratureSearchService {
  private readonly providers = new Map<LiteratureProviderId, LiteratureProvider>();
  private readonly cursors: CursorStore<SearchState>;
  private readonly now: () => number;

  constructor(private readonly options: SearchServiceOptions) {
    for (const p of options.providers) this.providers.set(p.id, p);
    this.now = options.now ?? Date.now;
    this.cursors = new CursorStore<SearchState>({ ttlMs: options.cursorTtlMs, now: this.now });
  }

  get providerIds(): LiteratureProviderId[] {
    return LITERATURE_PROVIDERS.filter((id) => this.providers.has(id));
  }

  // ------------------------------------------------------------------ search

  private normalize(req: LiteratureSearchRequest): NormalizedRequest {
    const available = this.providerIds;
    const requested = req.providers?.length ? LITERATURE_PROVIDERS.filter((p) => req.providers!.includes(p)) : available;
    const f = req.filters ?? {};
    const filters: LiteratureSearchFilters = {
      authors: cleanList(f.authors, 5),
      yearFrom: f.yearFrom,
      yearTo: f.yearTo,
      publicationTypes: f.publicationTypes?.length ? [...new Set(f.publicationTypes)] : undefined,
      venues: cleanList(f.venues, 5),
      openAccessOnly: f.openAccessOnly || undefined,
      categories: cleanList(f.categories),
    };
    const max = this.options.maxLimit ?? 50;
    return {
      query: req.query.replace(/\s+/g, ' ').trim(),
      mode: req.mode ?? 'all',
      providers: requested,
      filters: JSON.parse(JSON.stringify(filters)) as LiteratureSearchFilters,
      sort: req.sort ?? 'relevance',
      limit: Math.max(1, Math.min(max, Math.floor(req.limit ?? 20))),
    };
  }

  /** Why a provider cannot take part in this search, or null. */
  private skipReason(provider: LiteratureProvider | undefined, id: LiteratureProviderId, q: ProviderSearchQuery): string | null {
    if (!provider) return `${LITERATURE_PROVIDER_NAMES[id]} is turned off`;
    const caps = provider.capabilities;
    if (caps.modes[q.mode] === 'unsupported') return `${LITERATURE_PROVIDER_NAMES[id]} cannot search by ${q.mode === 'author' ? 'author' : q.mode}`;
    for (const [name, value] of Object.entries(q.filters) as [keyof LiteratureSearchFilters, unknown][]) {
      if (value === undefined) continue;
      if (caps.filters[name] === 'unsupported') return `${LITERATURE_PROVIDER_NAMES[id]} cannot filter by ${FILTER_LABEL[name]}`;
    }
    return provider.skipReason?.(q) ?? null;
  }

  async search(req: LiteratureSearchRequest, signal: AbortSignal = new AbortController().signal): Promise<LiteratureSearchResult> {
    const request = this.normalize(req);
    const interpreted = interpretQuery(request.query);
    if (!req.cursor && interpreted.kind !== 'text') return this.searchIdentifier(interpreted, request, signal);
    if (interpreted.kind === 'text' && !request.query) throw new LiteratureRequestError('Enter a search query.');

    const key = hash(request);
    let state: SearchState;
    if (req.cursor) {
      state = this.cursors.take(req.cursor);
      if (state.key !== key) throw new LiteratureRequestError('The cursor belongs to a different search. Run the search again.');
    } else {
      state = { key, request, positions: {}, active: [], pending: [], rank: {}, seenKeys: [], seenWorks: [], outcomes: {} };
      for (const id of request.providers) {
        const reason = this.skipReason(this.providers.get(id), id, this.providerQuery(request, null));
        if (reason) state.outcomes[id] = { provider: id, status: 'skipped', resultCount: 0, total: null, error: reason, durationMs: 0, fromCache: false };
        else state.active.push(id);
      }
    }

    if (state.pending.length < request.limit && state.active.length) await this.round(state, signal);

    const seen = new Set(state.seenKeys);
    const groups = deduplicate(state.pending).filter((g) => !g.some((r) => identifierKeys(r).some((k) => seen.has(k))));
    const candidates: RankingCandidate[] = [];
    for (const group of groups) {
      const work = mergeRecords(group);
      if (workKeys(work).some((k) => seen.has(k))) continue;
      if (state.seenWorks.some((s) => sameWorkByMetadata(s, fingerprint(work)))) continue;
      const ranks = group.map((r) => state.rank[recordKey(r)]).filter((n): n is number => n !== undefined);
      candidates.push({ work, providerPosition: ranks.length ? Math.min(...ranks) : null });
    }
    const ranked = rankWorks(candidates, queryIntent(request.query), request.mode, request.sort, new Date(this.now()).getUTCFullYear());
    const page = ranked.slice(0, request.limit);
    const rest = ranked.slice(request.limit);

    for (const r of page) {
      state.seenKeys.push(...workKeys(r.work), ...r.work.sourceRecords.flatMap(identifierKeys));
      state.seenWorks.push(fingerprint(r.work));
    }
    state.pending = rest.flatMap((r) => r.work.sourceRecords);
    const hasMore = state.pending.length > 0 || state.active.length > 0;
    const outcomes = request.providers.map((id) => state.outcomes[id]!).filter(Boolean);
    const totals = outcomes.map((o) => o.total).filter((t): t is number => t !== null);
    return {
      results: page,
      total: totals.length ? Math.max(...totals) : null,
      pagination: { hasMore, nextCursor: hasMore ? this.cursors.put(state) : null },
      providerStatus: outcomes,
      query: interpreted,
    };
  }

  private providerQuery(request: NormalizedRequest, position: unknown): ProviderSearchQuery {
    return { text: request.query, mode: request.mode, filters: request.filters, sort: request.sort, pageSize: request.limit, position };
  }

  private deadline(signal: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 25_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('search deadline reached'));
    }, timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      done: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      },
    };
  }

  private failure(id: LiteratureProviderId, err: unknown, started: number, timedOut: boolean): ProviderSearchOutcome {
    const durationMs = this.now() - started;
    if (timedOut) return { provider: id, status: 'failed', resultCount: 0, total: null, error: `${LITERATURE_PROVIDER_NAMES[id]} did not answer in time`, durationMs, fromCache: false };
    if (isProviderError(err)) {
      return {
        provider: id,
        status: err.kind === 'rate_limited' ? 'rate_limited' : 'failed',
        resultCount: 0,
        total: null,
        error: err.message,
        durationMs,
        fromCache: false,
      };
    }
    return { provider: id, status: 'failed', resultCount: 0, total: null, error: `${LITERATURE_PROVIDER_NAMES[id]}: unexpected error`, durationMs, fromCache: false };
  }

  private async cachedSearch(provider: LiteratureProvider, q: ProviderSearchQuery, signal: AbortSignal): Promise<{ page: ProviderSearchPage; fromCache: boolean }> {
    const cache = this.options.cache;
    const key = `search:${provider.id}:${hash(q)}`;
    if (cache) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) return { page: hit.value as ProviderSearchPage, fromCache: true };
    }
    const page = await provider.search(q, { signal });
    if (cache) {
      const ttls = this.options.searchTtlMs ?? {};
      const ttlMs = ttls[provider.id] ?? ttls.default ?? (provider.id === 'arxiv' ? 6 * 3_600_000 : 3_600_000);
      await cache.set(key, { provider: provider.id, kind: 'search', value: page, ttlMs }).catch(() => undefined);
    }
    return { page, fromCache: false };
  }

  /** Fetch the next page from every active provider in parallel. */
  private async round(state: SearchState, outer: AbortSignal): Promise<void> {
    const deadline = this.deadline(outer);
    try {
      await Promise.all(
        state.active.map(async (id) => {
          const provider = this.providers.get(id)!;
          const started = this.now();
          const previous = state.outcomes[id];
          try {
            const q = this.providerQuery(state.request, state.positions[id] ?? null);
            const { page, fromCache } = await this.cachedSearch(provider, q, deadline.signal);
            const records = page.records.filter((r) => passesFilters(r, state.request.filters));
            records.forEach((r, i) => {
              const k = recordKey(r);
              const rank = i / Math.max(1, q.pageSize);
              state.rank[k] = Math.min(state.rank[k] ?? 1, rank);
            });
            state.pending.push(...records);
            state.positions[id] = page.next;
            if (page.next === null || page.next === undefined) state.active = state.active.filter((p) => p !== id);
            const unreadable = page.skipped ?? 0;
            state.outcomes[id] = {
              provider: id,
              status: unreadable > 0 ? 'partial' : 'success',
              resultCount: (previous?.resultCount ?? 0) + records.length,
              total: page.total,
              ...(unreadable > 0 ? { error: `${unreadable} incomplete or unreadable record(s) left out` } : {}),
              ...(page.notes.length ? { notes: page.notes } : {}),
              durationMs: this.now() - started,
              fromCache,
            };
          } catch (err) {
            if (outer.aborted) throw new LiteratureCancelledError('Search cancelled');
            state.active = state.active.filter((p) => p !== id);
            const failed = this.failure(id, err, started, deadline.timedOut());
            state.outcomes[id] = previous ? { ...failed, resultCount: previous.resultCount, total: previous.total } : failed;
          }
        }),
      );
    } finally {
      deadline.done();
    }
    if (outer.aborted) throw new LiteratureCancelledError('Search cancelled');
  }

  // ------------------------------------------------------------- identifiers

  private async lookup(
    provider: LiteratureProvider,
    kind: string,
    id: string,
    fn: () => Promise<ScholarlySourceRecord | null>,
  ): Promise<{ record: ScholarlySourceRecord | null; fromCache: boolean }> {
    const cache = this.options.cache;
    const key = `record:${provider.id}:${kind}:${id}`;
    if (cache) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) return { record: (hit.value as { record: ScholarlySourceRecord | null }).record, fromCache: true };
    }
    const record = await fn();
    if (cache) {
      const ttlMs = record ? (this.options.recordTtlMs ?? 7 * 86_400_000) : (this.options.notFoundTtlMs ?? 3_600_000);
      await cache.set(key, { provider: provider.id, kind: 'record', value: { record }, ttlMs }).catch(() => undefined);
    }
    return { record, fromCache: false };
  }

  /**
   * Resolve an identifier through every selected provider that can look it
   * up, then once more for identifiers the first answers revealed (an arXiv
   * record's journal DOI, an OpenAlex record's DOI), and merge.
   */
  async resolve(
    target: { scheme: 'doi' | 'arxiv' | 'openalex' | 'semantic-scholar'; value: string; version?: string | null },
    providerIds: LiteratureProviderId[] = this.providerIds,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ works: ScholarlyWork[]; outcomes: ProviderSearchOutcome[] }> {
    const deadline = this.deadline(signal);
    const records: ScholarlySourceRecord[] = [];
    const outcomes = new Map<LiteratureProviderId, ProviderSearchOutcome>();
    const asked = new Set<string>();

    const ask = async (id: LiteratureProviderId, scheme: string, value: string, version: string | null = null) => {
      const askKey = `${id}|${scheme}|${value}`;
      if (asked.has(askKey)) return;
      asked.add(askKey);
      const provider = this.providers.get(id);
      const started = this.now();
      const can =
        provider &&
        (scheme === 'doi'
          ? provider.capabilities.lookups.doi
          : scheme === 'arxiv'
            ? provider.capabilities.lookups.arxiv && !!provider.getByArxivId
            : scheme === 'openalex'
              ? provider.capabilities.lookups.openalex && !!provider.getById
              : provider.capabilities.lookups.semanticScholar && !!provider.getById);
      if (!provider || !can) {
        if (!outcomes.has(id)) {
          const name = LITERATURE_PROVIDER_NAMES[id];
          const label = scheme === 'doi' ? 'DOIs' : scheme === 'arxiv' ? 'arXiv identifiers' : scheme === 'openalex' ? 'OpenAlex IDs' : 'Semantic Scholar IDs';
          outcomes.set(id, { provider: id, status: 'skipped', resultCount: 0, total: null, error: provider ? `${name} cannot look up ${label}` : `${name} is turned off`, durationMs: 0, fromCache: false });
        }
        return;
      }
      try {
        const ctx = { signal: deadline.signal };
        const arxivId: ArxivIdentifier = { id: value, version };
        const { record, fromCache } = await this.lookup(provider, scheme, version ? `${value}${version}` : value, () =>
          scheme === 'doi' ? provider.getByDoi(value, ctx) : scheme === 'arxiv' ? provider.getByArxivId!(arxivId, ctx) : provider.getById!(value, ctx),
        );
        if (record) records.push(record);
        const prev = outcomes.get(id);
        const count = (prev && prev.status !== 'skipped' ? prev.resultCount : 0) + (record ? 1 : 0);
        outcomes.set(id, { provider: id, status: 'success', resultCount: count, total: count, durationMs: this.now() - started, fromCache });
      } catch (err) {
        if (signal.aborted) throw new LiteratureCancelledError('Lookup cancelled');
        const prev = outcomes.get(id);
        if (!prev || prev.status === 'skipped') outcomes.set(id, this.failure(id, err, started, deadline.timedOut()));
      }
    };

    try {
      await Promise.all(providerIds.map((id) => ask(id, target.scheme, target.value, target.version ?? null)));
      // Second round: identifiers revealed by the first answers.
      const followUps: Promise<void>[] = [];
      for (const r of [...records]) {
        const doi = r.identifiers.doi && !parseArxivId(r.identifiers.doi) ? r.identifiers.doi : null;
        const arxiv = r.identifiers.arxivId;
        for (const id of providerIds) {
          if (doi && !(target.scheme === 'doi' && target.value === doi)) followUps.push(ask(id, 'doi', doi));
          if (arxiv && !(target.scheme === 'arxiv' && target.value === arxiv)) followUps.push(ask(id, 'arxiv', arxiv));
        }
      }
      await Promise.all(followUps);
    } finally {
      deadline.done();
    }

    const targetKey = `${target.scheme}:${target.value}`;
    const works = deduplicate(records)
      .map(mergeRecords)
      .sort((a, b) => Number(workKeys(b).includes(targetKey)) - Number(workKeys(a).includes(targetKey)));
    return { works, outcomes: providerIds.map((id) => outcomes.get(id)!).filter(Boolean) };
  }

  private async searchIdentifier(q: InterpretedQuery, request: NormalizedRequest, signal: AbortSignal): Promise<LiteratureSearchResult> {
    const arxiv = q.kind === 'arxiv' ? parseArxivId(q.identifier) : null;
    const target =
      q.kind === 'arxiv' && arxiv
        ? { scheme: 'arxiv' as const, value: arxiv.id, version: arxiv.version }
        : { scheme: q.kind as 'doi' | 'openalex' | 'semantic-scholar', value: q.identifier! };
    const { works, outcomes } = await this.resolve(target, request.providers, signal);
    const targetKey = `${target.scheme}:${target.value}`;
    return {
      results: works.map((work) => ({ work, score: null, signals: [workKeys(work).includes(targetKey) ? 'exact-identifier' : 'related-identifier'] })),
      total: works.length,
      pagination: { hasMore: false, nextCursor: null },
      providerStatus: outcomes,
      query: q,
    };
  }

  /** A work by canonical ID (`doi:…`, `arxiv:…`, `openalex:W…`, `semantic-scholar:…`). */
  async getWork(id: string, signal?: AbortSignal): Promise<{ work: ScholarlyWork | null; outcomes: ProviderSearchOutcome[] }> {
    const parsed = parseWorkId(id);
    if (!parsed) return { work: null, outcomes: [] };
    const arxiv = parsed.scheme === 'arxiv' ? parseArxivId(id.replace(/^arxiv:/i, '')) : null;
    const { works, outcomes } = await this.resolve({ ...parsed, version: arxiv?.version ?? null }, this.providerIds, signal);
    const key = `${parsed.scheme}:${parsed.value}`;
    const work = works.find((w) => workKeys(w).includes(key)) ?? null;
    if (!work && outcomes.length && outcomes.every((o) => o.status === 'failed' || o.status === 'rate_limited' || o.status === 'skipped') && outcomes.some((o) => o.status !== 'skipped')) {
      throw new LiteratureUnavailableError('No provider could be reached to look up this work.', outcomes);
    }
    return { work, outcomes };
  }

  // ---------------------------------------------------------- related works

  private async related(kind: 'references' | 'citations', id: string, limit: number, signal?: AbortSignal): Promise<RelatedWorks> {
    const { work } = await this.getWork(id, signal);
    if (!work) return { works: [], total: null, provider: null, outcomes: [] };
    const outcomes: ProviderSearchOutcome[] = [];
    const order: LiteratureProviderId[] = ['openalex', 'semantic-scholar'];
    for (const pid of order) {
      const provider = this.providers.get(pid);
      const fn = provider?.[kind];
      const record = work.sourceRecords.find((r) => r.provider === pid) ?? work.sourceRecords[0]!;
      if (!provider || !fn) continue;
      if (pid === 'openalex' && !work.identifiers.openAlexId) continue;
      const started = this.now();
      const deadline = this.deadline(signal ?? new AbortController().signal);
      try {
        const synthetic = { ...record, identifiers: { ...record.identifiers, ...work.identifiers } };
        const page = await fn.call(provider, synthetic, limit, { signal: deadline.signal });
        outcomes.push({ provider: pid, status: 'success', resultCount: page.records.length, total: page.total, durationMs: this.now() - started, fromCache: false });
        return { works: page.records.map((r) => mergeRecords([r])), total: page.total, provider: pid, outcomes };
      } catch (err) {
        if (signal?.aborted) throw new LiteratureCancelledError('Request cancelled');
        outcomes.push(this.failure(pid, err, started, deadline.timedOut()));
      } finally {
        deadline.done();
      }
    }
    if (outcomes.length && outcomes.every((o) => o.status !== 'success')) {
      throw new LiteratureUnavailableError(`Could not load ${kind === 'references' ? 'references' : 'citing works'}.`, outcomes);
    }
    return { works: [], total: null, provider: null, outcomes };
  }

  references(id: string, limit = 25, signal?: AbortSignal) {
    return this.related('references', id, limit, signal);
  }

  citations(id: string, limit = 25, signal?: AbortSignal) {
    return this.related('citations', id, limit, signal);
  }

  /** Author profile: `openalex:A…` or `semantic-scholar:<numeric id>`. */
  async getAuthor(id: string, signal?: AbortSignal): Promise<ScholarlyAuthorProfile | null> {
    const m = /^(openalex|semantic-scholar):(.+)$/.exec(id);
    if (!m) return null;
    const provider = this.providers.get(m[1] as LiteratureProviderId);
    if (!provider?.getAuthor) return null;
    const deadline = this.deadline(signal ?? new AbortController().signal);
    try {
      const profile = await provider.getAuthor(m[2]!, { signal: deadline.signal });
      if (!profile) return null;
      return { ...profile, works: profile.works.map((r) => mergeRecords([r])) };
    } catch (err) {
      if (signal?.aborted) throw new LiteratureCancelledError('Request cancelled');
      if (deadline.timedOut()) throw new LiteratureProviderError(provider.id, 'timeout', 'did not answer in time');
      throw err;
    } finally {
      deadline.done();
    }
  }

  /** One inexpensive request to a provider (connection test). */
  async check(id: LiteratureProviderId, signal?: AbortSignal): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`${LITERATURE_PROVIDER_NAMES[id]} is turned off`);
    const deadline = this.deadline(signal ?? new AbortController().signal);
    try {
      await provider.check({ signal: deadline.signal });
    } finally {
      deadline.done();
    }
  }

  dispose(): void {
    this.cursors.clear();
  }
}

const FILTER_LABEL: Record<keyof LiteratureSearchFilters, string> = {
  authors: 'author',
  yearFrom: 'year',
  yearTo: 'year',
  publicationTypes: 'publication type',
  venues: 'venue',
  openAccessOnly: 'open access',
  categories: 'category',
};
