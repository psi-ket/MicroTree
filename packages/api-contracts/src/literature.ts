import { z } from 'zod';
import {
  LITERATURE_CONNECTION_STATES,
  LITERATURE_PROVIDERS,
  LITERATURE_SEARCH_MODES,
  LITERATURE_SORTS,
  PROVIDER_SEARCH_STATUSES,
  PUBLICATION_TYPES,
  type LiteraturePreferences,
  type LiteratureProviderStatus,
  type LiteratureSearchHistoryEntry,
  type LiteratureSearchRequest,
  type LiteratureSearchResult,
  type ScholarlyAuthorProfile,
  type ScholarlySourceRecord,
  type ScholarlyWork,
} from '@research-studio/shared-types';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

export const LiteratureProviderIdSchema = z.enum(LITERATURE_PROVIDERS);

// ------------------------------------------------------------------ works

const Author = z.object({
  name: z.string(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  orcid: z.string().nullable(),
  affiliations: z.array(z.string()),
  providerIds: z.partialRecord(LiteratureProviderIdSchema, z.string()),
});

const Identifiers = z.object({
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  openAlexId: z.string().nullable(),
  semanticScholarId: z.string().nullable(),
  pmid: z.string().nullable(),
});

const Dates = z.object({
  published: z.string().nullable(),
  publishedOnline: z.string().nullable(),
  publishedPrint: z.string().nullable(),
  submitted: z.string().nullable(),
  updated: z.string().nullable(),
});

const Urls = z.object({ landingPage: z.string().nullable(), pdf: z.string().nullable(), abstract: z.string().nullable() });
const OpenAccess = z.object({ isOpenAccess: z.boolean().nullable(), status: z.string().nullable(), license: z.string().nullable(), pdfUrl: z.string().nullable() });
const Bibliographic = z.object({ volume: z.string().nullable(), issue: z.string().nullable(), pages: z.string().nullable(), issn: z.array(z.string()) });
const Category = z.object({ scheme: z.string(), value: z.string() });
const PublicationTypeSchema = z.enum(PUBLICATION_TYPES);

export const ScholarlySourceRecordSchema = z.object({
  provider: LiteratureProviderIdSchema,
  providerId: z.string(),
  recordUrl: z.string().nullable(),
  requestUrl: z.string().nullable(),
  retrievedAt: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  authors: z.array(Author),
  dates: Dates,
  publicationYear: z.number().int().nullable(),
  venue: z.string().nullable(),
  publisher: z.string().nullable(),
  publicationType: PublicationTypeSchema.nullable(),
  rawType: z.string().nullable(),
  identifiers: Identifiers,
  urls: Urls,
  openAccess: OpenAccess,
  citedByCount: z.number().int().nullable(),
  referenceCount: z.number().int().nullable(),
  bibliographic: Bibliographic,
  categories: z.array(Category),
  version: z.string().nullable(),
  extra: z.record(z.string(), z.unknown()),
});
assertType<Exact<z.infer<typeof ScholarlySourceRecordSchema>, ScholarlySourceRecord>>();

export const ScholarlyWorkSchema = z.object({
  id: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  abstractSource: LiteratureProviderIdSchema.nullable(),
  authors: z.array(Author),
  publicationDate: z.string().nullable(),
  publicationYear: z.number().int().nullable(),
  dates: Dates,
  venue: z.string().nullable(),
  publisher: z.string().nullable(),
  publicationType: PublicationTypeSchema.nullable(),
  bibliographic: Bibliographic,
  categories: z.array(Category),
  identifiers: Identifiers,
  urls: Urls,
  openAccess: OpenAccess,
  citation: z.object({
    citedByCount: z.number().int().nullable(),
    citedBySource: LiteratureProviderIdSchema.nullable(),
    referenceCount: z.number().int().nullable(),
    observations: z.array(
      z.object({
        provider: LiteratureProviderIdSchema,
        citedByCount: z.number().int().nullable(),
        referenceCount: z.number().int().nullable(),
        retrievedAt: z.string(),
      }),
    ),
  }),
  conflicts: z.array(
    z.object({ field: z.string(), values: z.array(z.object({ provider: LiteratureProviderIdSchema, value: z.string() })), chosen: LiteratureProviderIdSchema }),
  ),
  sourceRecords: z.array(ScholarlySourceRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
assertType<Exact<z.infer<typeof ScholarlyWorkSchema>, ScholarlyWork>>();

export const ProviderSearchOutcomeSchema = z.object({
  provider: LiteratureProviderIdSchema,
  status: z.enum(PROVIDER_SEARCH_STATUSES),
  resultCount: z.number().int(),
  total: z.number().int().nullable(),
  error: z.string().optional(),
  notes: z.array(z.string()).optional(),
  durationMs: z.number(),
  fromCache: z.boolean(),
});

// ----------------------------------------------------------------- search

/** arXiv category or archive (`quant-ph`, `cs.LG`, `math`). */
const CategoryName = z.string().regex(/^[a-z-]{2,16}(\.[A-Za-z-]{2,8})?$/, 'Invalid category');
const ShortText = (max: number) => z.string().trim().min(1).max(max);
const Year = z.number().int().min(1000).max(2999);

export const LiteratureSearchFiltersSchema = z
  .object({
    authors: z.array(ShortText(100)).max(5).optional(),
    yearFrom: Year.optional(),
    yearTo: Year.optional(),
    publicationTypes: z.array(PublicationTypeSchema).max(PUBLICATION_TYPES.length).optional(),
    venues: z.array(ShortText(200)).max(5).optional(),
    openAccessOnly: z.boolean().optional(),
    categories: z.array(CategoryName).max(20).optional(),
  })
  .strict()
  .refine((f) => f.yearFrom === undefined || f.yearTo === undefined || f.yearFrom <= f.yearTo, {
    message: 'The start year must not be after the end year',
    path: ['yearTo'],
  });

export const LiteratureSearchRequestSchema = z
  .object({
    query: ShortText(500),
    mode: z.enum(LITERATURE_SEARCH_MODES).optional(),
    providers: z.array(LiteratureProviderIdSchema).min(1).max(LITERATURE_PROVIDERS.length).optional(),
    filters: LiteratureSearchFiltersSchema.optional(),
    sort: z.enum(LITERATURE_SORTS).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid cursor').optional(),
  })
  .strict();
assertType<Exact<z.infer<typeof LiteratureSearchRequestSchema>, LiteratureSearchRequest>>();

export const LiteratureSearchResponse = z.object({
  results: z.array(z.object({ work: ScholarlyWorkSchema, score: z.number().nullable(), signals: z.array(z.string()) })),
  total: z.number().int().nullable(),
  pagination: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  providerStatus: z.array(ProviderSearchOutcomeSchema),
  query: z.object({ kind: z.enum(['text', 'doi', 'arxiv', 'openalex', 'semantic-scholar']), text: z.string(), identifier: z.string().nullable() }),
});
assertType<Exact<z.infer<typeof LiteratureSearchResponse>, LiteratureSearchResult>>();

export const LiteratureWorkResponse = z.object({ work: ScholarlyWorkSchema, providerStatus: z.array(ProviderSearchOutcomeSchema) });

export const LiteratureResolveResponse = z.object({
  /** The work the identifier names, first; then works found through it (e.g. a journal version). */
  works: z.array(ScholarlyWorkSchema),
  providerStatus: z.array(ProviderSearchOutcomeSchema),
});

export const LiteratureRelatedResponse = z.object({
  works: z.array(ScholarlyWorkSchema),
  total: z.number().int().nullable(),
  provider: LiteratureProviderIdSchema.nullable(),
  providerStatus: z.array(ProviderSearchOutcomeSchema),
});

export const ScholarlyAuthorProfileSchema = z.object({
  id: z.string(),
  provider: LiteratureProviderIdSchema,
  name: z.string(),
  orcid: z.string().nullable(),
  affiliations: z.array(z.string()),
  worksCount: z.number().int().nullable(),
  citedByCount: z.number().int().nullable(),
  hIndex: z.number().int().nullable(),
  recordUrl: z.string().nullable(),
  retrievedAt: z.string(),
  works: z.array(ScholarlyWorkSchema),
});
assertType<Exact<z.infer<typeof ScholarlyAuthorProfileSchema>, ScholarlyAuthorProfile>>();
export const LiteratureAuthorResponse = z.object({ author: ScholarlyAuthorProfileSchema });

// -------------------------------------------------------------- providers

export const LiteratureProviderStatusSchema = z.object({
  id: LiteratureProviderIdSchema,
  name: z.string(),
  enabled: z.boolean(),
  authentication: z.string(),
  acceptsApiKey: z.boolean(),
  apiKeySource: z.enum(['stored', 'environment']).nullable(),
  connection: z.enum(LITERATURE_CONNECTION_STATES),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  limits: z.string(),
  rateLimit: z.record(z.string(), z.string()).nullable(),
  homepage: z.string(),
  termsUrl: z.string(),
});
assertType<Exact<z.infer<typeof LiteratureProviderStatusSchema>, LiteratureProviderStatus>>();

export const LiteratureProvidersResponse = z.object({
  providers: z.array(LiteratureProviderStatusSchema),
  /** Whether a contact address is configured (Crossref polite pool, OpenAlex); the address is not returned. */
  contactConfigured: z.boolean(),
  cache: z.object({ entries: z.number().int(), bytes: z.number().int() }),
});
export const LiteratureProviderResponse = z.object({ provider: LiteratureProviderStatusSchema });

/** Literature API keys: printable ASCII, no whitespace. Sent once, stored in the secret store, never returned. */
const LiteratureApiKey = z.string().trim().min(8).max(256).regex(/^[\x21-\x7e]+$/, 'The key contains characters that are not allowed');

export const UpdateLiteratureProviderRequest = z
  .object({ enabled: z.boolean().optional(), apiKey: LiteratureApiKey.nullable().optional() })
  .strict()
  .refine((v) => v.enabled !== undefined || v.apiKey !== undefined, { message: 'Nothing to update' });

// ----------------------------------------------------- history and prefs

export const LiteratureHistoryEntrySchema = z.object({
  id: z.number().int(),
  query: z.string(),
  request: LiteratureSearchRequestSchema,
  resultCount: z.number().int(),
  providers: z.array(z.object({ provider: LiteratureProviderIdSchema, status: z.enum(PROVIDER_SEARCH_STATUSES), resultCount: z.number().int() })),
  createdAt: z.string(),
});
assertType<Exact<z.infer<typeof LiteratureHistoryEntrySchema>, LiteratureSearchHistoryEntry>>();
export const LiteratureHistoryResponse = z.object({ entries: z.array(LiteratureHistoryEntrySchema) });

export const LiteraturePreferencesSchema = z.object({
  providers: z.array(LiteratureProviderIdSchema).min(1),
  sort: z.enum(LITERATURE_SORTS),
  pageSize: z.number().int().min(5).max(50),
  saveHistory: z.boolean(),
});
assertType<Exact<z.infer<typeof LiteraturePreferencesSchema>, LiteraturePreferences>>();
export const LiteraturePreferencesResponse = z.object({ preferences: LiteraturePreferencesSchema });
export const UpdateLiteraturePreferencesRequest = LiteraturePreferencesSchema.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const LiteratureCacheClearResponse = z.object({ cleared: z.number().int() });

// ------------------------------------------------------- params & queries

export const LiteratureProviderParams = z.object({ providerId: LiteratureProviderIdSchema });
/** Canonical work ID (`doi:…`, `arxiv:…`, `openalex:W…`, `semantic-scholar:…`), URL-encoded as one segment. */
export const LiteratureWorkParams = z.object({ workId: z.string().min(3).max(400) });
/** The rest of the path after `/resolve/doi/` or `/resolve/arxiv/` (DOIs contain slashes). */
export const LiteratureResolveParams = z.object({ '*': z.string().min(1).max(400) });
export const LiteratureAuthorParams = z.object({ authorId: z.string().min(3).max(64) });
export const LiteratureRelatedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });
export const LiteratureHistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export const LiteratureHistoryParams = z.object({ entryId: z.coerce.number().int().positive() });
