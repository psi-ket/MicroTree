// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiteratureProviderStatus,
  LiteratureSearchRequest,
  LiteratureSearchResult,
  ProviderSearchOutcome,
  ScholarlySourceRecord,
  ScholarlyWork,
} from '@research-studio/shared-types';
import { QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------- runtime mock

const literature = {
  search: vi.fn<(input: LiteratureSearchRequest, signal?: AbortSignal) => Promise<LiteratureSearchResult>>(),
  providers: vi.fn(),
  updateProvider: vi.fn(),
  testProvider: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
  history: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  clearHistory: vi.fn(),
  clearCache: vi.fn(),
  references: vi.fn(),
  citations: vi.fn(),
  author: vi.fn(),
};

vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ literature }),
  useConnection: Object.assign(() => 'connected', { getState: () => ({ runtimeUrl: 'http://127.0.0.1:4317' }) }),
}));

const { queryClient } = await import('../src/lib/queries');
const { LiteratureScreen } = await import('../src/features/literature/LiteratureScreen');
const { SourcesDialog } = await import('../src/features/literature/SourcesDialog');
const { buildFilters, draftFromFilters, EMPTY_FILTERS, rateLimitSummary, searchSummary } = await import('../src/features/literature/model');

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-03T09:00:00.000Z';

function source(provider: ScholarlySourceRecord['provider'], patch: Partial<ScholarlySourceRecord> = {}): ScholarlySourceRecord {
  return {
    provider,
    providerId: `${provider}-id`,
    recordUrl: `https://example.org/${provider}`,
    requestUrl: null,
    retrievedAt: AT,
    title: 'Scheme for reducing decoherence in quantum computer memory',
    abstract: null,
    authors: [],
    dates: { published: '1995-10-01', publishedOnline: null, publishedPrint: null, submitted: null, updated: null },
    publicationYear: 1995,
    venue: 'Physical Review A',
    publisher: null,
    publicationType: 'journal-article',
    rawType: null,
    identifiers: { doi: '10.1103/physreva.52.r2493', arxivId: null, openAlexId: null, semanticScholarId: null, pmid: null },
    urls: { landingPage: null, pdf: null, abstract: null },
    openAccess: { isOpenAccess: null, status: null, license: null, pdfUrl: null },
    citedByCount: null,
    referenceCount: null,
    bibliographic: { volume: null, issue: null, pages: null, issn: [] },
    categories: [],
    version: null,
    extra: {},
    ...patch,
  };
}

const SHOR: ScholarlyWork = {
  id: 'doi:10.1103/physreva.52.r2493',
  title: 'Scheme for reducing decoherence in quantum computer memory',
  abstract: 'Recently, it was realized that use of the properties of quantum mechanics might speed up certain computations dramatically.',
  abstractSource: 'semantic-scholar',
  authors: [{ name: 'Peter W. Shor', givenName: 'Peter W.', familyName: 'Shor', orcid: null, affiliations: [], providerIds: { openalex: 'A5020744800' } }],
  publicationDate: '1995-10-01',
  publicationYear: 1995,
  dates: { published: '1995-10-01', publishedOnline: null, publishedPrint: null, submitted: null, updated: null },
  venue: 'Physical Review A',
  publisher: 'American Physical Society (APS)',
  publicationType: 'journal-article',
  bibliographic: { volume: '52', issue: '4', pages: 'R2493-R2496', issn: [] },
  categories: [],
  identifiers: { doi: '10.1103/physreva.52.r2493', arxivId: null, openAlexId: 'W1999706070', semanticScholarId: null, pmid: null },
  // An unsafe URL from a provider must never become a link.
  urls: { landingPage: 'javascript:alert(1)', pdf: null, abstract: null },
  openAccess: { isOpenAccess: false, status: 'closed', license: null, pdfUrl: null },
  citation: {
    citedByCount: 2431,
    citedBySource: 'openalex',
    referenceCount: 9,
    observations: [
      { provider: 'openalex', citedByCount: 2431, referenceCount: 9, retrievedAt: AT },
      { provider: 'crossref', citedByCount: 2101, referenceCount: 9, retrievedAt: AT },
    ],
  },
  conflicts: [
    {
      field: 'publicationType',
      values: [
        { provider: 'openalex', value: 'journal-article' },
        { provider: 'crossref', value: 'letter' },
      ],
      chosen: 'crossref',
    },
  ],
  sourceRecords: [source('openalex', { citedByCount: 2431 }), source('crossref', { citedByCount: 2101 })],
  createdAt: AT,
  updatedAt: AT,
};

const KITAEV: ScholarlyWork = {
  ...SHOR,
  id: 'arxiv:quant-ph/9707021',
  title: 'Fault-tolerant quantum computation by anyons',
  abstract: null,
  abstractSource: null,
  authors: [{ name: 'A. Yu. Kitaev', givenName: null, familyName: 'Kitaev', orcid: null, affiliations: [], providerIds: {} }],
  publicationYear: 2003,
  publicationDate: '2003-01-01',
  venue: 'Annals of Physics',
  identifiers: { ...SHOR.identifiers, doi: null, arxivId: 'quant-ph/9707021' },
  urls: { landingPage: 'https://arxiv.org/abs/quant-ph/9707021', pdf: 'https://arxiv.org/pdf/quant-ph/9707021', abstract: null },
  openAccess: { isOpenAccess: true, status: 'green', license: null, pdfUrl: 'https://arxiv.org/pdf/quant-ph/9707021' },
  conflicts: [],
  sourceRecords: [source('arxiv', { providerId: 'quant-ph/9707021v1' })],
  citation: { citedByCount: null, citedBySource: null, referenceCount: null, observations: [] },
};

function outcome(provider: ProviderSearchOutcome['provider'], patch: Partial<ProviderSearchOutcome> = {}): ProviderSearchOutcome {
  return { provider, status: 'success', resultCount: 1, total: 1, durationMs: 10, fromCache: false, ...patch };
}

const RESULT: LiteratureSearchResult = {
  results: [
    { work: SHOR, score: 9, signals: ['title-phrase'] },
    { work: KITAEV, score: 5, signals: [] },
  ],
  total: 120,
  pagination: { hasMore: true, nextCursor: 'cursor-0123456789' },
  providerStatus: [
    outcome('openalex'),
    outcome('semantic-scholar', { status: 'rate_limited', resultCount: 0, total: null, error: 'Semantic Scholar: rate limit reached; try again later' }),
    outcome('arxiv'),
    outcome('crossref', { fromCache: true }),
  ],
  query: { kind: 'text', text: 'quantum memory', identifier: null },
};

const PROVIDERS: LiteratureProviderStatus[] = (['openalex', 'semantic-scholar', 'arxiv', 'crossref'] as const).map((id) => ({
  id,
  name: { openalex: 'OpenAlex', 'semantic-scholar': 'Semantic Scholar', arxiv: 'arXiv', crossref: 'Crossref' }[id],
  enabled: id !== 'crossref',
  authentication: 'No account needed.',
  acceptsApiKey: id === 'openalex' || id === 'semantic-scholar',
  apiKeySource: id === 'openalex' ? 'environment' : null,
  connection: id === 'crossref' ? 'disabled' : id === 'semantic-scholar' ? 'rate_limited' : 'ok',
  lastSuccessAt: AT,
  lastErrorAt: id === 'semantic-scholar' ? '2026-11-03T10:00:00.000Z' : null,
  lastError: id === 'semantic-scholar' ? 'Semantic Scholar: rate limit reached; try again later' : null,
  limits: 'Some limits.',
  rateLimit: null,
  homepage: 'https://example.org/api',
  termsUrl: 'https://example.org/terms',
}));

// ---------------------------------------------------------------- helpers

const writeText = vi.fn<(text: string) => Promise<void>>();

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function noAxeViolations(container: Element) {
  // jsdom cannot compute colours; contrast is covered by the design tokens.
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function searchFor(text: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search terms, DOI or arXiv ID' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

beforeEach(() => {
  queryClient.clear();
  for (const fn of Object.values(literature)) fn.mockReset();
  literature.preferences.mockResolvedValue({ preferences: { providers: ['openalex', 'semantic-scholar', 'arxiv', 'crossref'], sort: 'relevance', pageSize: 20, saveHistory: true } });
  literature.providers.mockResolvedValue({ providers: PROVIDERS, contactConfigured: false, cache: { entries: 3, bytes: 4096 } });
  literature.history.mockResolvedValue({ entries: [] });
  literature.search.mockResolvedValue(RESULT);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(cleanup);

// ---------------------------------------------------------------- model

describe('literature filters', () => {
  it('turns typed filters into request filters', () => {
    expect(buildFilters(EMPTY_FILTERS)).toEqual({});
    expect(
      buildFilters({ ...EMPTY_FILTERS, authors: 'Shor, Peter; Preskill ', yearFrom: '1995', yearTo: '2001', types: ['preprint'], categories: 'quant-ph, cs.LG', venue: ' Physical Review A ' }),
    ).toEqual({
      filters: { authors: ['Shor, Peter', 'Preskill'], yearFrom: 1995, yearTo: 2001, publicationTypes: ['preprint'], categories: ['quant-ph', 'cs.LG'], venues: ['Physical Review A'] },
    });
  });

  it('explains invalid filters instead of sending them', () => {
    expect(buildFilters({ ...EMPTY_FILTERS, yearFrom: '95' }).error).toMatch(/four-digit/);
    expect(buildFilters({ ...EMPTY_FILTERS, yearFrom: '2010', yearTo: '2000' }).error).toMatch(/after the end year/);
    expect(buildFilters({ ...EMPTY_FILTERS, categories: 'quant ph!' }).error).toMatch(/not an arXiv category/);
    expect(buildFilters({ ...EMPTY_FILTERS, authors: 'a;b;c;d;e;f' }).error).toMatch(/at most 5/);
  });

  it('round-trips saved filters', () => {
    const filters = { authors: ['Shor, Peter'], yearFrom: 1995, categories: ['quant-ph'], openAccessOnly: true };
    expect(buildFilters(draftFromFilters(filters)).filters).toEqual(filters);
  });

  it('repeats only the limits a provider reported', () => {
    expect(rateLimitSummary(null)).toBeNull();
    expect(rateLimitSummary({ 'x-ratelimit-remaining-usd': '0.0950', 'x-ratelimit-limit-usd': '0.1' })).toBe('Last reported: $0.0950 of $0.1 of daily allowance left.');
    expect(rateLimitSummary({ 'x-api-pool': 'public', 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '1s', 'x-concurrency-limit': '1' })).toBe(
      'Last reported: public pool, 1 request per 1s, 1 at a time.',
    );
    expect(rateLimitSummary({ 'retry-after': '3' })).toBeNull();
  });

  it('summarises a search for screen readers', () => {
    expect(searchSummary(2, 120, RESULT.providerStatus)).toBe('2 results of about 120. Semantic Scholar: rate limited.');
    expect(searchSummary(0, null, [])).toBe('No results.');
  });
});

// ---------------------------------------------------------------- screen

describe('LiteratureScreen', () => {
  it('starts with examples and passes an accessibility audit', async () => {
    const { container } = wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    expect(screen.getByRole('button', { name: '10.1103/PhysRevA.52.R2493' })).toBeTruthy();
    await waitFor(() => expect(literature.providers).toHaveBeenCalled());
    await noAxeViolations(container);
  });

  it('searches, shows provenance and provider status, and announces the outcome', async () => {
    const { container } = wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await waitFor(() => expect(literature.preferences).toHaveBeenCalled());
    await searchFor('quantum memory');

    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('button')).toHaveLength(2);
    expect(within(results).getByRole('img', { name: 'Found in OpenAlex and Crossref' })).toBeTruthy();
    expect(within(results).getByText('Sources disagree on 1 field')).toBeTruthy();
    expect(within(results).getByText(/2,431 citations/)).toBeTruthy();

    const status = screen.getByRole('list', { name: 'Sources searched' });
    expect(within(status).getByText('Rate limited')).toBeTruthy();
    expect(within(status).getByText('cached')).toBeTruthy();
    expect(screen.getByText('Semantic Scholar: rate limit reached; try again later')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('2 results of about 120. Semantic Scholar: rate limited.');

    const [request] = literature.search.mock.calls[0]!;
    expect(request).toEqual({ query: 'quantum memory', mode: 'all', providers: ['openalex', 'semantic-scholar', 'arxiv', 'crossref'], sort: 'relevance' });
    await noAxeViolations(container);
  });

  it('shows details with attribution, conflicts and safe links, and copies BibTeX', async () => {
    const { container } = wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await searchFor('quantum memory');
    fireEvent.click(await screen.findByRole('button', { name: /Scheme for reducing decoherence/ }));

    const details = screen.getByTestId('work-details');
    expect(within(details).getByRole('heading', { level: 2 }).textContent).toBe(SHOR.title);
    expect(within(details).getByText('according to OpenAlex')).toBeTruthy();
    expect(within(details).getByText('Crossref 2,101')).toBeTruthy();
    expect(within(details).getByText('Abstract from Semantic Scholar.')).toBeTruthy();
    // The conflict shows both values and which one is displayed.
    expect(within(details).getByText('Where sources disagree')).toBeTruthy();
    expect(within(details).getByText('Letter')).toBeTruthy();
    // DOI link is safe and opens in a new tab; the javascript: landing page is dropped.
    const doi = within(details).getByRole('link', { name: /10\.1103\/physreva\.52\.r2493/ });
    expect(doi.getAttribute('href')).toBe('https://doi.org/10.1103/physreva.52.r2493');
    expect(doi.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();

    fireEvent.click(within(details).getByRole('button', { name: 'Copy BibTeX' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toMatch(/^@article\{shor1995scheme,/);
    expect(writeText.mock.calls[0]![0]).toMatch(/\n {2}doi\s+= \{10\.1103\/physreva\.52\.r2493\}\n/);

    fireEvent.click(within(details).getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]![0]).toContain('Shor, P. W. (1995)');

    // Download .bib saves the same entry under its citation key.
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:bib';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('shor1995scheme.bib');
      expect(this.href).toBe('blob:bib');
    });
    fireEvent.click(within(details).getByRole('button', { name: 'Download .bib' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(await blobs[0]!.text()).toBe(writeText.mock.calls[0]![0]);
    click.mockRestore();
    await noAxeViolations(container);
  });

  it('moves between results with the arrow keys', async () => {
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await searchFor('quantum memory');
    const first = await screen.findByRole('button', { name: /Scheme for reducing decoherence/ });
    first.focus();
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByRole('button', { name: /Fault-tolerant quantum computation by anyons/ });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('work-details').textContent).toContain('Fault-tolerant quantum computation by anyons');
  });

  it('cancels a running search and tells the runtime', async () => {
    let seen: AbortSignal | undefined;
    literature.search.mockImplementation(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await searchFor('slow query');
    expect(await screen.findByText(/Press Esc to stop/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Search stopped/)).toBeTruthy();
    expect(seen?.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Search cancelled.');
  });

  it('cancels with Escape too', async () => {
    let seen: AbortSignal | undefined;
    literature.search.mockImplementation(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await searchFor('slow query');
    await screen.findByText(/Press Esc to stop/);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(await screen.findByText(/Search stopped/)).toBeTruthy();
    expect(seen?.aborted).toBe(true);
  });

  it('refuses invalid filters without searching', async () => {
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'From year' }), { target: { value: '19x5' } });
    await searchFor('quantum memory');
    expect(screen.getByRole('alert').textContent).toMatch(/four-digit year/);
    expect(literature.search).not.toHaveBeenCalled();
  });

  it('re-runs the search when a source or type is toggled, and loads more pages', async () => {
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await waitFor(() => expect(literature.providers).toHaveBeenCalled());
    await searchFor('quantum memory');
    await screen.findByRole('list', { name: 'Search results' });

    // Crossref is turned off at the runtime: its box is disabled.
    expect((screen.getByRole('checkbox', { name: /Crossref/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'arXiv' }));
    await waitFor(() => expect(literature.search).toHaveBeenCalledTimes(2));
    expect(literature.search.mock.calls[1]![0].providers).toEqual(['openalex', 'semantic-scholar', 'crossref']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Preprint' }));
    await waitFor(() => expect(literature.search).toHaveBeenCalledTimes(3));
    expect(literature.search.mock.calls[2]![0].filters).toEqual({ publicationTypes: ['preprint'] });

    await screen.findByRole('list', { name: 'Search results' });
    literature.search.mockResolvedValueOnce({ ...RESULT, results: [{ work: { ...KITAEV, id: 'doi:10.1/next' }, score: 1, signals: [] }], pagination: { hasMore: false, nextCursor: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('button')).toHaveLength(3));
    expect(literature.search.mock.calls[3]![0].cursor).toBe('cursor-0123456789');
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();
  });

  it('shows the runtime’s error and offers to search again', async () => {
    literature.search.mockRejectedValueOnce(new Error('No source could be reached.'));
    wrap(<LiteratureScreen backLabel="Projects" onBack={() => undefined} />);
    await searchFor('quantum memory');
    expect((await screen.findByRole('alert')).textContent).toBe('No source could be reached.');
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    await screen.findByRole('list', { name: 'Search results' });
  });
});

describe('SourcesDialog', () => {
  it('stores keys through the runtime without echoing them, and passes an accessibility audit', async () => {
    literature.updateProvider.mockResolvedValue({ provider: { ...PROVIDERS[1], apiKeySource: 'stored' } });
    wrap(<SourcesDialog open onOpenChange={() => undefined} />);
    const s2 = await screen.findByTestId('source-semantic-scholar');
    expect(within(s2).getByText('Rate limited')).toBeTruthy();
    const input = within(s2).getByLabelText('API key (optional)') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 's2-secret-key-0123' } });
    fireEvent.click(within(s2).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(literature.updateProvider).toHaveBeenCalledWith('semantic-scholar', { apiKey: 's2-secret-key-0123' }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.body.textContent).not.toContain('s2-secret-key');

    // The environment key is described, not shown, and arXiv offers no key field.
    expect(within(screen.getByTestId('source-openalex')).getByText(/Using the key from the runtime’s environment/)).toBeTruthy();
    expect(within(screen.getByTestId('source-arxiv')).queryByLabelText('API key (optional)')).toBeNull();
    await noAxeViolations(document.body);
  });

  it('turns a source on and off', async () => {
    literature.updateProvider.mockResolvedValue({ provider: PROVIDERS[3] });
    wrap(<SourcesDialog open onOpenChange={() => undefined} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Search Crossref' }));
    await waitFor(() => expect(literature.updateProvider).toHaveBeenCalledWith('crossref', { enabled: true }));
  });
});
