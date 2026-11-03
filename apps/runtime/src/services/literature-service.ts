import type { FastifyBaseLogger } from 'fastify';
import { LiteraturePreferencesSchema, type LiteratureSearchRequestSchema, type UpdateLiteratureProviderRequest } from '@research-studio/api-contracts';
import type { SecretStore } from '@research-studio/ai-storage';
import type { Repositories } from '@research-studio/database';
import {
  ArxivProvider,
  CrossrefProvider,
  isProviderError,
  LiteratureCancelledError,
  LiteratureRequestError,
  LiteratureSearchService,
  LiteratureUnavailableError,
  normalizeDoi,
  OpenAlexProvider,
  parseArxivId,
  SemanticScholarProvider,
  type HttpObservation,
  type LiteratureCache,
  type LiteratureProvider,
  type ProviderConfig,
} from '@research-studio/literature-engine';
import {
  DEFAULT_LITERATURE_PREFERENCES,
  LITERATURE_PROVIDER_NAMES,
  LITERATURE_PROVIDERS,
  StudioError,
  type LiteraturePreferences,
  type LiteratureProviderId,
  type LiteratureProviderStatus,
  type LiteratureSearchResult,
  type ProviderSearchOutcome,
  type ScholarlyAuthorProfile,
  type ScholarlyWork,
} from '@research-studio/shared-types';
import type { z } from 'zod';
import type { RuntimeConfig } from '../config';
import type { AuditService } from './audit-service';
import type { Actor } from './project-service';

const SCOPE = 'literature';
const secretRef = (id: LiteratureProviderId) => `literature:${id}`;

interface ProviderInfo {
  acceptsApiKey: boolean;
  envKey: string | null;
  authentication: string;
  limits: (ctx: { key: boolean; mailto: boolean }) => string;
  homepage: string;
  termsUrl: string;
}

/** What each provider needs and allows (checked against the providers' documentation on 2026-11-02). */
const PROVIDERS: Record<LiteratureProviderId, ProviderInfo> = {
  openalex: {
    acceptsApiKey: true,
    envKey: 'OPENALEX_API_KEY',
    authentication: 'No account needed. A free API key raises the daily allowance.',
    limits: ({ key }) =>
      key
        ? 'With a key: $1 of usage per day (a search costs $0.001, a single work is free).'
        : 'Without a key: $0.10 of usage per day, shared by everyone on this network address (about 100 searches).',
    homepage: 'https://openalex.org',
    termsUrl: 'https://openalex.org/pricing',
  },
  'semantic-scholar': {
    acceptsApiKey: true,
    envKey: 'SEMANTIC_SCHOLAR_API_KEY',
    authentication: 'No account needed. Without a key, requests share a public pool that is often busy; a free key gives a dedicated limit.',
    limits: ({ key }) => (key ? 'With a key: 1 request per second.' : 'Without a key: shared public pool; expect "rate limited" at busy times.'),
    homepage: 'https://www.semanticscholar.org/product/api',
    termsUrl: 'https://www.semanticscholar.org/product/api/license',
  },
  arxiv: {
    acceptsApiKey: false,
    envKey: null,
    authentication: 'No account or key.',
    limits: () => 'One request every 3 seconds, one at a time. Results are cached for 6 hours.',
    homepage: 'https://info.arxiv.org/help/api/index.html',
    termsUrl: 'https://info.arxiv.org/help/api/tou.html',
  },
  crossref: {
    acceptsApiKey: false,
    envKey: null,
    authentication: 'No account or key. A contact address (RS_LITERATURE_MAILTO) moves requests to the faster "polite" pool.',
    limits: ({ mailto }) =>
      mailto ? 'Polite pool: 3 searches per second, 3 at a time.' : 'Public pool: 1 search per second, one at a time.',
    homepage: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
    termsUrl: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/',
  },
};

export interface LiteratureServiceOptions {
  /** Test seam: merged into every provider's configuration (e.g. no request spacing). */
  providerConfig?: Partial<ProviderConfig>;
}

/** Map engine errors to API errors. */
function toStudioError(err: unknown): unknown {
  if (err instanceof StudioError) return err;
  if (err instanceof LiteratureRequestError) return new StudioError('VALIDATION_FAILED', err.message);
  if (err instanceof LiteratureCancelledError) return new StudioError('BAD_REQUEST', 'The request was cancelled');
  if (err instanceof LiteratureUnavailableError) {
    const answered = err.outcomes.filter((o) => o.status !== 'skipped');
    const allLimited = answered.length > 0 && answered.every((o) => o.status === 'rate_limited');
    return new StudioError(allLimited ? 'RATE_LIMITED' : 'PROVIDER_ERROR', err.message, { providerStatus: err.outcomes });
  }
  if (isProviderError(err)) {
    const code = err.kind === 'rate_limited' ? 'RATE_LIMITED' : err.kind === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR';
    return new StudioError(code, err.message);
  }
  return err;
}

export class LiteratureService {
  private engineCache: LiteratureSearchService | null = null;
  private readonly purge: NodeJS.Timeout;

  constructor(
    private readonly repos: Repositories,
    private readonly secrets: SecretStore,
    private readonly config: RuntimeConfig,
    private readonly audit: AuditService,
    private readonly env: Record<string, string | undefined>,
    private readonly log: FastifyBaseLogger,
    private readonly options: LiteratureServiceOptions = {},
  ) {
    this.purgeExpired();
    this.purge = setInterval(() => this.purgeExpired(), 3_600_000);
    this.purge.unref();
  }

  get enabled(): boolean {
    return this.config.literature.enabled;
  }

  private purgeExpired(): void {
    try {
      this.repos.literatureCache.purgeExpired();
    } catch (err) {
      this.log.warn({ err }, 'could not purge the literature cache');
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new StudioError('NOT_CONFIGURED', 'Literature search is turned off (RS_LITERATURE=off).');
  }

  // ------------------------------------------------------------ settings

  private enabledMap(): Record<LiteratureProviderId, boolean> {
    const stored = this.repos.settings.get(SCOPE, 'providerEnabled');
    const map = Object.fromEntries(LITERATURE_PROVIDERS.map((id) => [id, true])) as Record<LiteratureProviderId, boolean>;
    if (stored && typeof stored === 'object') {
      for (const id of LITERATURE_PROVIDERS) {
        const v = (stored as Record<string, unknown>)[id];
        if (typeof v === 'boolean') map[id] = v;
      }
    }
    return map;
  }

  preferences(): LiteraturePreferences {
    const parsed = LiteraturePreferencesSchema.safeParse(this.repos.settings.get(SCOPE, 'preferences'));
    return parsed.success ? parsed.data : { ...DEFAULT_LITERATURE_PREFERENCES, providers: [...DEFAULT_LITERATURE_PREFERENCES.providers] };
  }

  updatePreferences(patch: Partial<LiteraturePreferences>): LiteraturePreferences {
    this.requireEnabled();
    const next = LiteraturePreferencesSchema.parse({ ...this.preferences(), ...patch });
    next.providers = LITERATURE_PROVIDERS.filter((p) => next.providers.includes(p));
    this.repos.settings.setMany(SCOPE, { preferences: next });
    if (patch.saveHistory === false) this.repos.literatureHistory.clear();
    return next;
  }

  private async apiKey(id: LiteratureProviderId): Promise<{ key: string | null; source: 'stored' | 'environment' | null }> {
    const info = PROVIDERS[id];
    if (!info.acceptsApiKey) return { key: null, source: null };
    const stored = await this.secrets.get(secretRef(id));
    if (stored) return { key: stored, source: 'stored' };
    const fromEnv = info.envKey ? this.env[info.envKey] : undefined;
    return fromEnv ? { key: fromEnv, source: 'environment' } : { key: null, source: null };
  }

  // -------------------------------------------------------------- engine

  private observe = (o: HttpObservation) => {
    try {
      this.repos.literatureProviders.record(o.provider, { ok: o.ok, at: o.at, errorKind: o.error, error: o.message, rateLimit: o.rateLimit });
    } catch (err) {
      this.log.warn({ err }, 'could not record provider health');
    }
  };

  private cache(): LiteratureCache {
    const repo = this.repos.literatureCache;
    return {
      get: (key) => {
        const hit = repo.get(key);
        return Promise.resolve(hit ? { value: hit.value, retrievedAt: hit.retrievedAt } : null);
      },
      set: (key, entry) => {
        const at = Date.now();
        repo.set(key, {
          provider: entry.provider,
          kind: entry.kind,
          value: entry.value,
          retrievedAt: new Date(at).toISOString(),
          expiresAt: new Date(at + entry.ttlMs).toISOString(),
        });
        return Promise.resolve();
      },
    };
  }

  /** The engine with one client per enabled provider. Rebuilt only when keys or switches change, so rate gates persist. */
  private async engine(): Promise<LiteratureSearchService> {
    if (this.engineCache) return this.engineCache;
    const enabled = this.enabledMap();
    const lit = this.config.literature;
    const providers: LiteratureProvider[] = [];
    for (const id of LITERATURE_PROVIDERS) {
      if (!enabled[id]) continue;
      const { key } = await this.apiKey(id);
      const base: ProviderConfig = {
        baseUrl: lit.baseUrls[id],
        apiKey: key ?? undefined,
        // The contact address only goes to providers that ask for one.
        mailto: id === 'openalex' || id === 'crossref' ? (lit.mailto ?? undefined) : undefined,
        onObservation: this.observe,
        ...this.options.providerConfig,
      };
      providers.push(
        id === 'openalex'
          ? new OpenAlexProvider(base)
          : id === 'semantic-scholar'
            ? new SemanticScholarProvider(base)
            : id === 'arxiv'
              ? new ArxivProvider(base)
              : new CrossrefProvider(base),
      );
    }
    this.engineCache = new LiteratureSearchService({ providers, cache: this.cache(), timeoutMs: lit.timeoutMs });
    return this.engineCache;
  }

  private invalidate(): void {
    this.engineCache?.dispose();
    this.engineCache = null;
  }

  private async run<T>(fn: (engine: LiteratureSearchService) => Promise<T>): Promise<T> {
    this.requireEnabled();
    try {
      return await fn(await this.engine());
    } catch (err) {
      throw toStudioError(err);
    }
  }

  // -------------------------------------------------------------- search

  /** `saveHistory: false` for searches the user did not type (library metadata lookups). */
  async search(input: z.infer<typeof LiteratureSearchRequestSchema>, signal: AbortSignal, options: { saveHistory?: boolean } = {}): Promise<LiteratureSearchResult> {
    const prefs = this.preferences();
    const request = { ...input, providers: input.providers ?? prefs.providers, sort: input.sort ?? prefs.sort, limit: input.limit ?? prefs.pageSize };
    const result = await this.run((engine) => engine.search(request, signal));
    if (prefs.saveHistory && options.saveHistory !== false && !input.cursor) {
      try {
        const saved = { ...request };
        delete saved.cursor;
        this.repos.literatureHistory.add({
          query: request.query,
          request: saved,
          resultCount: result.results.length,
          providers: result.providerStatus.map((s) => ({ provider: s.provider, status: s.status, resultCount: s.resultCount })),
        });
      } catch (err) {
        this.log.warn({ err }, 'could not save search history');
      }
    }
    return result;
  }

  async work(id: string, signal: AbortSignal): Promise<{ work: ScholarlyWork; providerStatus: ProviderSearchOutcome[] }> {
    const { work, outcomes } = await this.run((engine) => engine.getWork(id, signal));
    if (!work) throw new StudioError('NOT_FOUND', 'No provider knows this work', { providerStatus: outcomes });
    return { work, providerStatus: outcomes };
  }

  private async resolve(target: Parameters<LiteratureSearchService['resolve']>[0], signal: AbortSignal) {
    const prefs = this.preferences();
    const { works, outcomes } = await this.run((engine) => engine.resolve(target, prefs.providers, signal));
    if (!works.length) {
      const answered = outcomes.filter((o) => o.status !== 'skipped');
      if (answered.length && answered.every((o) => o.status === 'failed' || o.status === 'rate_limited')) {
        throw toStudioError(new LiteratureUnavailableError('No provider could be reached to resolve this identifier.', outcomes));
      }
      throw new StudioError('NOT_FOUND', 'No provider knows this identifier', { providerStatus: outcomes });
    }
    return { works, providerStatus: outcomes };
  }

  resolveDoi(raw: string, signal: AbortSignal) {
    const doi = normalizeDoi(raw);
    if (!doi || parseArxivId(doi)) {
      const arxiv = parseArxivId(raw);
      if (arxiv) return this.resolve({ scheme: 'arxiv', value: arxiv.id, version: arxiv.version }, signal);
      throw new StudioError('VALIDATION_FAILED', 'This is not a valid DOI');
    }
    return this.resolve({ scheme: 'doi', value: doi }, signal);
  }

  resolveArxiv(raw: string, signal: AbortSignal) {
    const arxiv = parseArxivId(raw);
    if (!arxiv) throw new StudioError('VALIDATION_FAILED', 'This is not a valid arXiv identifier');
    return this.resolve({ scheme: 'arxiv', value: arxiv.id, version: arxiv.version }, signal);
  }

  async related(kind: 'references' | 'citations', id: string, limit: number, signal: AbortSignal) {
    const res = await this.run((engine) => (kind === 'references' ? engine.references(id, limit, signal) : engine.citations(id, limit, signal)));
    return { works: res.works, total: res.total, provider: res.provider, providerStatus: res.outcomes };
  }

  async author(id: string, signal: AbortSignal): Promise<ScholarlyAuthorProfile> {
    if (!/^(openalex:A\d{1,12}|semantic-scholar:\d{1,15})$/.test(id)) throw new StudioError('VALIDATION_FAILED', 'Unknown author ID format');
    const enabled = this.enabledMap();
    const provider = id.startsWith('openalex:') ? 'openalex' : 'semantic-scholar';
    if (!enabled[provider]) throw new StudioError('NOT_CONFIGURED', `${LITERATURE_PROVIDER_NAMES[provider]} is turned off`);
    const profile = await this.run((engine) => engine.getAuthor(id, signal));
    if (!profile) throw new StudioError('NOT_FOUND', 'Author not found');
    return profile;
  }

  // ----------------------------------------------------------- providers

  async providers(): Promise<LiteratureProviderStatus[]> {
    const enabled = this.enabledMap();
    const health = new Map(this.repos.literatureProviders.list().map((h) => [h.provider, h]));
    const statuses: LiteratureProviderStatus[] = [];
    for (const id of LITERATURE_PROVIDERS) {
      const info = PROVIDERS[id];
      const h = health.get(id);
      const { source } = await this.apiKey(id);
      const failingNow = !!h?.lastErrorAt && (!h.lastSuccessAt || h.lastErrorAt > h.lastSuccessAt);
      statuses.push({
        id,
        name: LITERATURE_PROVIDER_NAMES[id],
        enabled: this.enabled && enabled[id],
        authentication: info.authentication,
        acceptsApiKey: info.acceptsApiKey,
        apiKeySource: source,
        connection: !this.enabled || !enabled[id] ? 'disabled' : !h ? 'unknown' : failingNow ? (h.lastErrorKind === 'rate_limited' ? 'rate_limited' : 'error') : 'ok',
        lastSuccessAt: h?.lastSuccessAt ?? null,
        lastErrorAt: h?.lastErrorAt ?? null,
        lastError: h?.lastError ?? null,
        limits: info.limits({ key: source !== null, mailto: !!this.config.literature.mailto }),
        rateLimit: h?.rateLimit ?? null,
        homepage: info.homepage,
        termsUrl: info.termsUrl,
      });
    }
    return statuses;
  }

  async provider(id: LiteratureProviderId): Promise<LiteratureProviderStatus> {
    return (await this.providers()).find((p) => p.id === id)!;
  }

  status() {
    return { contactConfigured: !!this.config.literature.mailto, cache: this.repos.literatureCache.stats() };
  }

  async updateProvider(id: LiteratureProviderId, patch: z.infer<typeof UpdateLiteratureProviderRequest>, actor: Actor): Promise<LiteratureProviderStatus> {
    this.requireEnabled();
    const info = PROVIDERS[id];
    if (patch.apiKey !== undefined && !info.acceptsApiKey) {
      throw new StudioError('VALIDATION_FAILED', `${LITERATURE_PROVIDER_NAMES[id]} does not use API keys`);
    }
    if (patch.enabled !== undefined) {
      this.repos.settings.setMany(SCOPE, { providerEnabled: { ...this.enabledMap(), [id]: patch.enabled } });
    }
    if (patch.apiKey === null) await this.secrets.delete(secretRef(id));
    else if (patch.apiKey !== undefined) await this.secrets.set(secretRef(id), patch.apiKey);
    if (patch.apiKey !== undefined) {
      // A new key deserves a fresh health record and fresh cached answers (e.g. cached 401s).
      this.repos.literatureProviders.reset(id);
      this.repos.literatureCache.clear(id);
    }
    this.invalidate();
    this.audit.record({
      action: 'literature.provider.update',
      outcome: 'success',
      actor: actor.sessionId,
      target: id,
      details: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey === null ? 'removed' : 'stored' } : {}),
      },
    });
    return this.provider(id);
  }

  async testProvider(id: LiteratureProviderId, signal: AbortSignal): Promise<LiteratureProviderStatus> {
    this.requireEnabled();
    if (!this.enabledMap()[id]) throw new StudioError('NOT_CONFIGURED', `${LITERATURE_PROVIDER_NAMES[id]} is turned off`);
    try {
      await (await this.engine()).check(id, signal);
    } catch (err) {
      // The failure is recorded as provider health; the status below shows it.
      if (signal.aborted) throw toStudioError(new LiteratureCancelledError('cancelled'));
      if (!isProviderError(err)) throw err;
    }
    return this.provider(id);
  }

  // ------------------------------------------------------ history, cache

  history(limit: number) {
    return this.repos.literatureHistory.list(limit);
  }

  deleteHistoryEntry(id: number): void {
    if (!this.repos.literatureHistory.delete(id)) throw new StudioError('NOT_FOUND', 'History entry not found');
  }

  clearHistory(actor: Actor): void {
    const removed = this.repos.literatureHistory.clear();
    this.audit.record({ action: 'literature.history.clear', outcome: 'success', actor: actor.sessionId, details: { removed } });
  }

  clearCache(actor: Actor): number {
    const cleared = this.repos.literatureCache.clear();
    this.invalidate();
    this.audit.record({ action: 'literature.cache.clear', outcome: 'success', actor: actor.sessionId, details: { cleared } });
    return cleared;
  }

  dispose(): void {
    clearInterval(this.purge);
    this.invalidate();
  }
}
