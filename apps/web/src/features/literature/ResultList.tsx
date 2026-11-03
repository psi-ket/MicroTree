import { useRef, type KeyboardEvent } from 'react';
import type { RankedWork } from '@research-studio/shared-types';
import { Button, cn, Spinner } from '@research-studio/ui';
import { Notches, ProofBar, Tag } from './common';
import { authorLine, formatCount, providerName, providersOf, TYPE_LABEL } from './model';

function ResultItem({ item, selected, onSelect }: { item: RankedWork; selected: boolean; onSelect: () => void }) {
  const { work } = item;
  const providers = providersOf(work);
  const cites = work.citation.citedByCount;
  return (
    <li className={cn('relative border-b border-rule last:border-b-0', selected && 'bg-accent-soft/55')}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        data-result={work.id}
        className="group flex w-full gap-3 py-3 pl-0 pr-4 text-left outline-none hover:bg-sunken/50 focus-visible:bg-sunken/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <Notches providers={providers} className="mt-[5px] shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[15.5px] leading-[1.3] text-ink group-hover:text-accent-hover">{work.title}</span>
          <span className="mt-1 block truncate text-xs text-ink-muted">
            {authorLine(work.authors)}
            {work.publicationYear ? <> · {work.publicationYear}</> : null}
            {work.venue ? (
              <>
                {' '}
                · <i className="font-display text-[13px]">{work.venue}</i>
              </>
            ) : null}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
            {work.publicationType ? <Tag>{TYPE_LABEL[work.publicationType]}</Tag> : null}
            {work.openAccess.isOpenAccess ? <Tag dot="success">Open access</Tag> : null}
            {cites !== null && work.citation.citedBySource ? (
              <span className="tabular-nums">
                {formatCount(cites)} citation{cites === 1 ? '' : 's'} <span className="text-ink-muted">({providerName(work.citation.citedBySource)})</span>
              </span>
            ) : null}
            {work.conflicts.length ? (
              <span className="inline-flex items-center gap-1.5">
                <ProofBar />
                {work.conflicts.length === 1 ? 'Sources disagree on 1 field' : `Sources disagree on ${work.conflicts.length} fields`}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function ResultList({
  results,
  selectedId,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  results: RankedWork[];
  selectedId: string | null;
  onSelect: (item: RankedWork) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);

  // Up/Down move between results (and open them), like a reading list.
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-result]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = buttons[e.key === 'ArrowDown' ? Math.min(at + 1, buttons.length - 1) : Math.max(at - 1, 0)];
    if (!next || next === buttons[at]) return;
    e.preventDefault();
    next.focus();
    next.click();
  };

  return (
    <>
      <ol ref={list} aria-label="Search results" className="bg-panel" onKeyDown={onKeyDown} data-testid="results">
        {results.map((item) => (
          <ResultItem key={item.work.id} item={item} selected={item.work.id === selectedId} onSelect={() => onSelect(item)} />
        ))}
      </ol>
      {hasMore ? (
        <div className="flex justify-center border-t border-rule py-4">
          <Button onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner /> : null}
            Load more results
          </Button>
        </div>
      ) : null}
    </>
  );
}
