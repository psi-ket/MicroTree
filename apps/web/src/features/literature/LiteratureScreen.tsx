import { ChevronLeft, Library, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  LITERATURE_PROVIDERS,
  LITERATURE_SEARCH_MODES,
  type LiteratureProviderId,
  type LiteratureSearchHistoryEntry,
  type LiteratureSearchMode,
  type LiteratureSearchRequest,
  type LiteratureSort,
  type ScholarlyWork,
} from '@research-studio/shared-types';
import { Button, cn, Input, Kbd, Select, Spinner } from '@research-studio/ui';
import { useLiteratureHistory, useLiteraturePreferences, useLiteratureProviders } from '../../lib/queries';
import { FiltersPanel, RecentSearches } from './FiltersPanel';
import { buildFilters, draftFromFilters, EMPTY_FILTERS, formatCount, MODE_LABEL, searchSummary, type FilterDraft } from './model';
import { ProviderStatusStrip } from './ProviderStatusStrip';
import { ResultList } from './ResultList';
import { SourcesDialog } from './SourcesDialog';
import { useLiteratureSearch } from './use-search';
import { AuthorProfile, WorkDetails } from './WorkDetails';

const WIDE = '(min-width: 1180px)';

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(WIDE);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE).matches : true),
  );
}

type Panel = { kind: 'work'; work: ScholarlyWork } | { kind: 'author'; id: string };

const EXAMPLES: { query: string; what: string }[] = [
  { query: 'surface code decoder', what: 'words in titles and abstracts' },
  { query: '10.1103/PhysRevA.52.R2493', what: 'a DOI, or a doi.org link' },
  { query: 'quant-ph/9605011', what: 'an arXiv ID, old or new style' },
];

export function LiteratureScreen({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  const wide = useWide();
  const { preferences, loaded } = useLiteraturePreferences();
  const { data: providerData } = useLiteratureProviders();
  const { data: history } = useLiteratureHistory(preferences.saveHistory);
  const { state, search, loadMore, cancel, busy } = useLiteratureSearch();

  const [text, setText] = useState('');
  const [mode, setMode] = useState<LiteratureSearchMode>('all');
  const [providers, setProviders] = useState<LiteratureProviderId[]>([...LITERATURE_PROVIDERS]);
  const [sort, setSort] = useState<LiteratureSort>('relevance');
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [stack, setStack] = useState<Panel[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Start from the saved defaults once they arrive.
  const seeded = useRef(false);
  useEffect(() => {
    if (!loaded || seeded.current) return;
    seeded.current = true;
    setProviders(preferences.providers);
    setSort(preferences.sort);
  }, [loaded, preferences]);

  // "/" focuses the search box; Escape stops a running search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      } else if (e.key === 'Escape' && busy && !document.querySelector('[role="dialog"]')) {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, cancel]);

  // A single exact match (DOI, arXiv ID) opens straight away.
  useEffect(() => {
    if (state.phase === 'done' && state.query && state.query.kind !== 'text' && state.results.length === 1) {
      setStack([{ kind: 'work', work: state.results[0]!.work }]);
    }
  }, [state.phase, state.query, state.results]);

  const run = (o: { query?: string; mode?: LiteratureSearchMode; providers?: LiteratureProviderId[]; sort?: LiteratureSort; draft?: FilterDraft } = {}) => {
    const query = (o.query ?? text).trim();
    const built = buildFilters(o.draft ?? draft);
    setFilterError(built.error ?? null);
    if (built.error) {
      setFiltersOpen(true);
      return;
    }
    if (!query) {
      input.current?.focus();
      return;
    }
    const request: LiteratureSearchRequest = {
      query,
      mode: o.mode ?? mode,
      providers: o.providers ?? providers,
      sort: o.sort ?? sort,
      ...(built.filters ? { filters: built.filters } : {}),
    };
    setStack([]);
    void search(request);
  };

  // Changing a choice re-runs the current search; typed filters wait for Enter or "Apply".
  const searched = state.request !== null;
  const rerun = (o: Parameters<typeof run>[0]) => {
    if (searched) run(o);
  };

  const runHistory = (e: LiteratureSearchHistoryEntry) => {
    const r = e.request;
    const next = {
      query: r.query,
      mode: r.mode ?? 'all',
      providers: r.providers?.length ? r.providers : providers,
      sort: r.sort ?? sort,
      draft: draftFromFilters(r.filters),
    };
    setText(next.query);
    setMode(next.mode);
    setProviders(next.providers);
    setSort(next.sort);
    setDraft(next.draft);
    setFiltersOpen(false);
    run(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy && state.phase === 'searching') cancel();
    else run();
  };

  const top = stack.at(-1) ?? null;
  const selectedId = stack[0]?.kind === 'work' ? stack[0].work.id : null;
  const push = (p: Panel) => setStack((s) => [...s, p]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const showDetails = top !== null;
  const showList = wide || !showDetails;

  const announce =
    state.phase === 'searching'
      ? 'Searching…'
      : state.phase === 'cancelled'
        ? 'Search cancelled.'
        : state.phase === 'error'
          ? `Search failed: ${state.error}`
          : state.phase === 'done'
            ? searchSummary(state.results.length, state.total, state.providerStatus)
            : '';

  const filters = (
    <>
      <FiltersPanel
        providers={providers}
        onProvidersChange={(p) => {
          setProviders(p);
          rerun({ providers: p });
        }}
        providerStatus={providerData?.providers}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          rerun({ sort: s });
        }}
        draft={draft}
        onDraftChange={(d, apply) => {
          setDraft(d);
          if (apply) rerun({ draft: d });
        }}
        onApply={() => run()}
        error={filterError}
      />
      {preferences.saveHistory && history ? <RecentSearches entries={history} onRun={runHistory} /> : null}
    </>
  );

  return (
    <main className="flex h-dvh flex-col bg-paper" data-testid="literature">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-2 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-ink-muted">
          <ChevronLeft /> {backLabel}
        </Button>
        <h1 className="flex items-center gap-2 font-display text-[19px] leading-none text-ink">
          <Library className="size-[18px] text-accent" aria-hidden />
          Literature
        </h1>
        <form role="search" aria-label="Literature" onSubmit={submit} className="order-last flex w-full min-w-0 items-center gap-1.5 sm:order-none sm:ml-4 sm:max-w-3xl sm:flex-1">
          <Select aria-label="Search in" value={mode} onChange={(e) => setMode(e.target.value as LiteratureSearchMode)} className="w-auto max-w-[6.5rem] shrink-0 text-xs sm:max-w-none">
            {LITERATURE_SEARCH_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <Input
              ref={input}
              type="search"
              aria-label="Search terms, DOI or arXiv ID"
              placeholder="Words, a DOI or an arXiv ID"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              className="pl-8 pr-8"
              autoFocus
              data-testid="literature-query"
            />
            <Kbd className="absolute right-2 top-1/2 hidden -translate-y-1/2 sm:inline-flex" aria-hidden>
              /
            </Kbd>
          </div>
          {state.phase === 'searching' ? (
            <Button type="submit" className="w-[5.5rem]">
              <X /> Cancel
            </Button>
          ) : (
            <Button type="submit" variant="primary" className="w-[5.5rem]">
              Search
            </Button>
          )}
        </form>
        <div className="ml-auto flex items-center gap-1">
          {!wide ? (
            <Button variant="ghost" size="sm" aria-expanded={filtersOpen} aria-controls="lit-filters" onClick={() => setFiltersOpen((o) => !o)}>
              <SlidersHorizontal /> Filters
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setSourcesOpen(true)}>
            Sources
          </Button>
        </div>
      </header>

      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div className="relative flex min-h-0 flex-1">
        {wide || filtersOpen ? (
          <aside
            id="lit-filters"
            aria-label="Filters and recent searches"
            className={cn('w-[236px] shrink-0 overflow-y-auto border-r border-rule bg-paper', !wide && 'absolute inset-y-0 left-0 z-20 w-[min(300px,85vw)] shadow-float')}
          >
            {filters}
          </aside>
        ) : null}

        {showList ? (
          <section aria-label="Results" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-panel" aria-busy={state.phase === 'searching'}>
            {state.phase !== 'searching' ? <ProviderStatusStrip outcomes={state.providerStatus} /> : null}
            {state.phase === 'searching' ? (
              <div className="flex items-center gap-2 px-5 py-6 text-ui text-ink-muted">
                <Spinner /> Asking {providers.length === 1 ? 'one source' : `${providers.length} sources`}… <span className="text-ink-muted">Press Esc to stop.</span>
              </div>
            ) : state.phase === 'error' ? (
              <div className="px-5 py-8">
                <p role="alert" className="text-ui text-danger">
                  {state.error}
                </p>
                <Button className="mt-3" onClick={() => run()}>
                  Search again
                </Button>
              </div>
            ) : state.phase === 'cancelled' ? (
              <p className="px-5 py-8 text-ui text-ink-muted">Search stopped. Press Search to run it again.</p>
            ) : state.phase === 'idle' ? (
              <div className="mx-auto max-w-lg px-6 py-16">
                <p className="font-display text-[22px] italic leading-snug text-ink-muted">Search OpenAlex, Semantic Scholar, arXiv and Crossref at once.</p>
                <p className="mt-2 text-ui text-ink-muted">
                  Duplicates are merged into one entry. The marks on the left edge of each result show which sources returned it.
                </p>
                <ul className="mt-6 space-y-1.5">
                  {EXAMPLES.map((ex) => (
                    <li key={ex.query} className="flex items-baseline gap-3 text-ui">
                      <button
                        type="button"
                        className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                        onClick={() => {
                          setText(ex.query);
                          run({ query: ex.query });
                        }}
                      >
                        {ex.query}
                      </button>
                      <span className="text-ink-muted">{ex.what}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : state.results.length === 0 ? (
              <div className="px-5 py-10">
                <p className="font-display text-[18px] italic text-ink-muted">No works matched.</p>
                <p className="mt-1 text-ui text-ink-muted">Try fewer filters, other words, or turn on more sources.</p>
              </div>
            ) : (
              <>
                <p className="px-4 pb-1 pt-3 text-2xs text-ink-muted">
                  {formatCount(state.results.length)} shown
                  {state.total && state.total > state.results.length ? ` · about ${formatCount(state.total)} in the largest source` : ''}
                  {state.error ? <span className="text-danger"> · {state.error}</span> : null}
                </p>
                <ResultList
                  results={state.results}
                  selectedId={selectedId}
                  onSelect={(item) => setStack([{ kind: 'work', work: item.work }])}
                  hasMore={state.nextCursor !== null}
                  loadingMore={state.phase === 'loading-more'}
                  onLoadMore={loadMore}
                />
              </>
            )}
          </section>
        ) : null}

        {wide || showDetails ? (
          <aside aria-label="Details" className={cn('min-w-0 overflow-y-auto border-l border-rule bg-panel', wide ? 'w-[min(460px,38vw)] shrink-0' : 'flex-1')}>
            {top?.kind === 'work' ? (
              <WorkDetails
                key={top.work.id}
                work={top.work}
                onBack={stack.length > 1 || !wide ? pop : null}
                backLabel={stack.length > 1 ? 'Back' : 'Back to results'}
                onAuthor={(id) => push({ kind: 'author', id })}
                onOpenWork={(w) => push({ kind: 'work', work: w })}
              />
            ) : top?.kind === 'author' ? (
              <AuthorProfile key={top.id} authorId={top.id} onBack={pop} backLabel="Back" onOpenWork={(w) => push({ kind: 'work', work: w })} />
            ) : (
              <p className="px-6 py-16 text-center text-ui text-ink-muted">Choose a result to see its details, where each value came from, and its BibTeX.</p>
            )}
          </aside>
        ) : null}
      </div>
      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </main>
  );
}
