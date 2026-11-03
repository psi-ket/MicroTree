import { BookMarked, ChevronLeft, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, cn, Input, Kbd } from '@research-studio/ui';
import { useLibraryJobs } from '../../lib/queries';
import { DashboardView } from '../documents/DashboardView';
import { SearchView } from '../documents/SearchView';
import { CollectionsView } from './CollectionsView';
import { ImportView } from './ImportView';
import { ItemDetails } from './ItemDetails';
import { isActiveJob } from './model';
import { OverviewView } from './OverviewView';
import { NO_FILTERS, PapersView, type PaperFilters } from './PapersView';

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

type Tab = 'overview' | 'papers' | 'search' | 'collections' | 'fulltext' | 'import';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'papers', label: 'Papers' },
  { id: 'search', label: 'Search text' },
  { id: 'collections', label: 'Collections' },
  { id: 'fulltext', label: 'Full text' },
  { id: 'import', label: 'Import' },
];

export function LibraryScreen({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  const wide = useWide();
  const [tab, setTab] = useState<Tab>('overview');
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<PaperFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [paperScope, setPaperScope] = useState<{ id: string; title: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { data: jobs } = useLibraryJobs();
  const running = jobs?.filter(isActiveJob).length ?? 0;

  // Typing searches after a short pause; it always shows the Papers tab.
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text })), 250);
    return () => clearTimeout(id);
  }, [text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showPapers = (next: Partial<PaperFilters>) => {
    setFilters({ ...NO_FILTERS, q: filters.q, ...next });
    setTab('papers');
  };
  const open = (id: string) => {
    setSelected(id);
    setTab('papers');
  };

  const searchPaper = (id: string, title: string) => {
    setPaperScope({ id, title });
    setTab('search');
  };
  const details = selected ? (
    <ItemDetails key={selected} itemId={selected} onBack={wide ? null : () => setSelected(null)} onDeleted={() => setSelected(null)} onSearchPaper={searchPaper} />
  ) : null;

  return (
    <main className="flex h-dvh flex-col bg-paper" data-testid="library">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-2 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-ink-muted">
          <ChevronLeft /> {backLabel}
        </Button>
        <h1 className="flex items-center gap-2 font-display text-[19px] leading-none text-ink">
          <BookMarked className="size-[18px] text-accent" aria-hidden />
          Library
        </h1>
        <nav aria-label="Library sections" className="flex flex-wrap items-center gap-0.5 sm:ml-3 sm:flex-nowrap">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              className={cn(
                'relative h-8 whitespace-nowrap rounded-ctl px-2.5 text-ui text-ink-muted hover:bg-sunken hover:text-ink',
                tab === t.id && 'text-ink after:absolute after:inset-x-2.5 after:-bottom-[9px] after:h-0.5 after:bg-accent sm:after:-bottom-[13px]',
              )}
            >
              {t.label}
              {t.id === 'import' && running ? (
                <span className="ml-1.5 inline-grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-accent-ink" aria-label={`${running} running`}>
                  {running}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <form
          role="search"
          aria-label="Library"
          className="order-last w-full min-w-0 sm:order-none sm:ml-auto sm:w-auto sm:max-w-sm sm:flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters((f) => ({ ...f, q: text }));
            setTab('papers');
          }}
        >
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <Input
              ref={input}
              type="search"
              aria-label="Search your library"
              placeholder="Title, author, DOI, key, tag or note"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (e.target.value) setTab('papers');
              }}
              maxLength={300}
              className="pl-8 pr-8"
              data-testid="library-query"
            />
            <Kbd className="absolute right-2 top-1/2 hidden -translate-y-1/2 sm:inline-flex" aria-hidden>
              /
            </Kbd>
          </div>
        </form>
        {tab === 'papers' && !wide ? (
          <Button variant="ghost" size="sm" aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
            <SlidersHorizontal /> Filters
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {tab === 'overview' ? (
          <OverviewView
            onOpenItem={open}
            onShowStatus={(readingStatus) => showPapers({ readingStatus })}
            onShowNeedsReview={() => showPapers({ metadataStatus: 'needs-review' })}
            onOpenCollection={(collectionId) => showPapers({ collectionId })}
            onImport={() => setTab('import')}
          />
        ) : tab === 'collections' ? (
          <CollectionsView onOpen={(collectionId) => showPapers({ collectionId })} />
        ) : tab === 'import' ? (
          <ImportView />
        ) : tab === 'search' ? (
          <SearchView paperScope={paperScope} onClearPaperScope={() => setPaperScope(null)} />
        ) : tab === 'fulltext' ? (
          <DashboardView />
        ) : !wide && details ? (
          <div className="min-w-0 flex-1 overflow-y-auto bg-panel">{details}</div>
        ) : (
          <>
            <PapersView filters={filters} onFiltersChange={setFilters} selectedId={selected} onSelect={setSelected} railOpen={wide || railOpen} />
            {wide ? (
              <aside aria-label="Paper details" className="w-[440px] shrink-0 overflow-y-auto border-l border-rule bg-panel">
                {details ?? (
                  <p className="px-6 py-10 font-display text-[17px] italic text-ink-muted">Choose a paper to see its details, files and notes.</p>
                )}
              </aside>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
