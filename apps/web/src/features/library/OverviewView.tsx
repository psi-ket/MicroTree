import { READING_STATUSES, type LibraryItemSummary, type ReadingStatus } from '@research-studio/shared-types';
import { Button, Spinner } from '@research-studio/ui';
import { errorMessage, useLibraryOverview } from '../../lib/queries';
import { SectionHeading } from '../literature/common';
import { StatusSpine } from './common';
import { DuplicatesSection } from './DuplicatesSection';
import { authorsShort, STATUS_LABEL } from './model';

function ShortList({ items, onOpen, empty }: { items: LibraryItemSummary[]; onOpen: (id: string) => void; empty: string }) {
  if (!items.length) return <p className="mt-2 text-ui text-ink-muted">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-rule border-y border-rule">
      {items.map((i) => (
        <li key={i.id}>
          <button type="button" onClick={() => onOpen(i.id)} className="flex w-full items-start gap-2.5 py-2 text-left hover:bg-sunken/50">
            <StatusSpine status={i.readingStatus} className="mt-0.5 h-7" />
            <span className="min-w-0">
              <span className="block font-display text-[14px] leading-snug text-ink">{i.title}</span>
              <span className="block truncate text-2xs text-ink-muted">
                {authorsShort(i.authors, i.authorCount)}
                {i.year ? ` · ${i.year}` : ''}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function OverviewView({
  onOpenItem,
  onShowStatus,
  onShowNeedsReview,
  onOpenCollection,
  onImport,
}: {
  onOpenItem: (id: string) => void;
  onShowStatus: (status: ReadingStatus) => void;
  onShowNeedsReview: () => void;
  onOpenCollection: (id: string) => void;
  onImport: () => void;
}) {
  const { data, error, isLoading } = useLibraryOverview();
  if (isLoading) return <Spinner className="m-8 text-ink-muted" />;
  if (error || !data) return <p className="m-8 text-danger">{error ? errorMessage(error) : ''}</p>;

  if (data.total === 0 && data.archived === 0) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16" data-testid="library-overview">
        <p className="font-display text-[22px] italic leading-snug text-ink-muted">Your library is empty.</p>
        <p className="mt-2 text-ui text-ink-muted">
          Add papers from literature search, or import PDFs, BibTeX, RIS files or your Zotero library. Each paper keeps its PDF, notes, tags and citation key in one place.
        </p>
        <Button className="mt-5" variant="primary" onClick={onImport}>
          Import papers
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 overflow-y-auto px-6 py-6 md:grid-cols-[1fr_1fr]" data-testid="library-overview">
      <section aria-labelledby="ov-shelf" className="md:col-span-2">
        <SectionHeading id="ov-shelf" level={2}>Reading</SectionHeading>
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {READING_STATUSES.map((s) => (
            <li key={s}>
              <button type="button" onClick={() => onShowStatus(s)} className="flex w-full items-stretch gap-3 rounded-md border border-rule bg-panel p-3 text-left hover:border-rule-strong">
                <StatusSpine status={s} className="h-auto w-[9px]" decorative />
                <span>
                  <span className="block font-display text-[26px] leading-none tabular-nums text-ink">{data.byStatus[s] ?? 0}</span>
                  <span className="mt-1 block text-xs text-ink-muted">{STATUS_LABEL[s]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-muted">
          {data.total} paper{data.total === 1 ? '' : 's'} · {data.withPdf} with a PDF · {data.favorites} favourite{data.favorites === 1 ? '' : 's'}
          {data.archived ? ` · ${data.archived} archived` : ''}
        </p>
        {data.needsReview ? (
          <p className="mt-3 flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft/40 px-3 py-2 text-ui">
            <span className="flex-1">
              {data.needsReview === 1 ? 'One paper has' : `${data.needsReview} papers have`} possible matches waiting for your choice.
            </span>
            <Button size="sm" onClick={onShowNeedsReview}>
              Review
            </Button>
          </p>
        ) : null}
      </section>
      <section aria-labelledby="ov-added">
        <SectionHeading id="ov-added" level={2}>Recently added</SectionHeading>
        <ShortList items={data.recentlyAdded} onOpen={onOpenItem} empty="Nothing yet." />
      </section>
      <section aria-labelledby="ov-opened">
        <SectionHeading id="ov-opened" level={2}>Recently opened</SectionHeading>
        <ShortList items={data.recentlyOpened} onOpen={onOpenItem} empty="Papers you open appear here." />
      </section>
      <DuplicatesSection />
      {data.collections.length ? (
        <section aria-labelledby="ov-collections" className="md:col-span-2">
          <SectionHeading id="ov-collections" level={2}>Collections</SectionHeading>
          <ul className="mt-2 flex flex-wrap gap-2">
            {data.collections.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onOpenCollection(c.id)} className="inline-flex items-center gap-2 rounded-md border border-rule bg-panel px-3 py-1.5 text-ui text-ink hover:border-rule-strong">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: c.color ?? 'var(--rs-ink-faint)' }} />
                  {c.name}
                  <span className="text-2xs tabular-nums text-ink-muted">{c.itemCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
