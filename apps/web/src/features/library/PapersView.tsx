import { Archive, ArchiveRestore, Download, FileText, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  LIBRARY_SORTS,
  METADATA_STATUSES,
  READING_STATUSES,
  type LibraryItemQuery,
  type LibraryItemSummary,
  type LibrarySort,
  type MetadataStatus,
  type ReadingStatus,
} from '@research-studio/shared-types';
import { Button, cn, Input, Label, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, useCollections, useLibraryItems, useLibraryTags, useZoteroStatus } from '../../lib/queries';
import { Tag } from '../literature/common';
import { change, downloadText, MetadataTag, StatusSpine } from './common';
import { DeleteDialog } from './DeleteDialog';
import { ZoteroExportDialog } from './ZoteroSection';
import { authorsShort, METADATA_LABEL, STATUS_LABEL, type ArchivedFilter } from './model';

const PAGE = 50;

const SORT_LABEL: Record<LibrarySort, string> = {
  'added-desc': 'Newest added',
  'added-asc': 'Oldest added',
  'year-desc': 'Newest published',
  'year-asc': 'Oldest published',
  'title-asc': 'Title A–Z',
  'title-desc': 'Title Z–A',
};

export interface PaperFilters {
  q: string;
  readingStatus: ReadingStatus | '';
  metadataStatus: MetadataStatus | '';
  collectionId: string;
  tag: string;
  favorite: boolean;
  hasPdf: boolean;
  archived: ArchivedFilter;
  sort: LibrarySort;
}

export const NO_FILTERS: PaperFilters = { q: '', readingStatus: '', metadataStatus: '', collectionId: '', tag: '', favorite: false, hasPdf: false, archived: 'active', sort: 'added-desc' };

export function toQuery(f: PaperFilters, offset: number): LibraryItemQuery {
  return {
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(f.readingStatus ? { readingStatus: f.readingStatus } : {}),
    ...(f.metadataStatus ? { metadataStatus: f.metadataStatus } : {}),
    ...(f.collectionId ? { collectionId: f.collectionId } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(f.favorite ? { favorite: true } : {}),
    ...(f.hasPdf ? { hasPdf: true } : {}),
    archived: f.archived,
    sort: f.sort,
    limit: PAGE,
    offset,
  };
}

function FilterRail({ filters, onChange }: { filters: PaperFilters; onChange: (f: PaperFilters) => void }) {
  const { data: collections } = useCollections();
  const { data: tags } = useLibraryTags();
  const set = <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => onChange({ ...filters, [key]: value });
  const changed = JSON.stringify({ ...filters, q: '' }) !== JSON.stringify({ ...NO_FILTERS, q: '' });
  return (
    <div className="space-y-4 p-4 text-ui">
      <div>
        <Label htmlFor="lib-f-status">Reading status</Label>
        <Select id="lib-f-status" value={filters.readingStatus} onChange={(e) => set('readingStatus', e.target.value as ReadingStatus | '')}>
          <option value="">Any</option>
          {READING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="lib-f-collection">Collection</Label>
        <Select id="lib-f-collection" value={filters.collectionId} onChange={(e) => set('collectionId', e.target.value)}>
          <option value="">All papers</option>
          {collections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.itemCount})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="lib-f-tag">Tag</Label>
        <Select id="lib-f-tag" value={filters.tag} onChange={(e) => set('tag', e.target.value)}>
          <option value="">Any</option>
          {tags?.map((t) => (
            <option key={t.id} value={t.name}>
              {t.name} ({t.itemCount})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="lib-f-meta">Details</Label>
        <Select id="lib-f-meta" value={filters.metadataStatus} onChange={(e) => set('metadataStatus', e.target.value as MetadataStatus | '')}>
          <option value="">Any</option>
          {METADATA_STATUSES.map((s) => (
            <option key={s} value={s}>
              {METADATA_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-ink">Show only</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={filters.favorite} onChange={(e) => set('favorite', e.target.checked)} className="accent-[var(--rs-accent)]" />
          Favourites
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={filters.hasPdf} onChange={(e) => set('hasPdf', e.target.checked)} className="accent-[var(--rs-accent)]" />
          Papers with a PDF
        </label>
      </fieldset>
      <div>
        <Label htmlFor="lib-f-archived">Archive</Label>
        <Select id="lib-f-archived" value={filters.archived} onChange={(e) => set('archived', e.target.value as ArchivedFilter)}>
          <option value="active">Hide archived papers</option>
          <option value="archived">Only archived papers</option>
          <option value="all">Show everything</option>
        </Select>
      </div>
      {changed ? (
        <Button variant="link" size="sm" className="px-0" onClick={() => onChange({ ...NO_FILTERS, q: filters.q })}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function PaperRow({ item, selected, checked, onOpen, onCheck }: { item: LibraryItemSummary; selected: boolean; checked: boolean; onOpen: () => void; onCheck: (v: boolean) => void }) {
  return (
    <li className={cn('flex items-stretch border-b border-rule', selected && 'bg-accent-soft/55', item.archivedAt && 'opacity-70')}>
      <label className="flex items-start px-3 pt-3.5">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select ${item.title}`} className="accent-[var(--rs-accent)]" />
      </label>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        data-item={item.id}
        className="group flex min-w-0 flex-1 gap-3 py-3 pr-4 text-left outline-none hover:bg-sunken/50 focus-visible:bg-sunken/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <StatusSpine status={item.readingStatus} className="h-10" />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-1.5">
            <span className="font-display text-[15px] leading-[1.3] text-ink group-hover:text-accent-hover">{item.title}</span>
            {item.isFavorite ? <Star aria-label="Favourite" className="mt-1 size-3 shrink-0 fill-warning text-warning" /> : null}
          </span>
          <span className="mt-1 block truncate text-xs text-ink-muted">
            {authorsShort(item.authors, item.authorCount)}
            {item.year ? <> · {item.year}</> : null}
            {item.venue ? (
              <>
                {' '}
                · <i className="font-display text-[13px]">{item.venue}</i>
              </>
            ) : null}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {item.citationKey ? <span className="font-mono text-2xs text-ink-muted">{item.citationKey}</span> : null}
            {item.metadataStatus !== 'resolved' ? <MetadataTag status={item.metadataStatus} /> : null}
            {item.pdfCount ? (
              <Tag>
                <FileText aria-hidden className="size-3" />
                PDF
              </Tag>
            ) : null}
            {item.tags.slice(0, 4).map((t) => (
              <Tag key={t} className="bg-transparent px-0 text-ink-muted">
                #{t}
              </Tag>
            ))}
            {item.archivedAt ? <Tag>Archived</Tag> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function BulkBar({ ids, collectionId, onDone }: { ids: string[]; collectionId: string; onDone: () => void }) {
  const { data: collections } = useCollections();
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const { data: zotero } = useZoteroStatus();
  const [tag, setTag] = useState('');
  const bulk = (action: Parameters<ReturnType<typeof runtime>['library']['bulk']>[0]['action']) =>
    void change('update the papers', () => runtime().library.bulk({ itemIds: ids, action }));
  const exportBib = async () => {
    const res = await change('export the papers', () => runtime().library.export({ format: 'bibtex', selection: { itemIds: ids } }));
    if (res) downloadText(res.text, res.fileName, 'application/x-bibtex;charset=utf-8');
  };
  return (
    <div role="toolbar" aria-label="Selected papers" className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-rule bg-raised px-3 py-2 text-xs">
      <span className="mr-1 font-medium text-ink">{ids.length} selected</span>
      <Select aria-label="Set reading status" className="h-6 w-auto text-xs" value="" onChange={(e) => e.target.value && bulk({ kind: 'set-status', readingStatus: e.target.value as ReadingStatus })}>
        <option value="">Mark as…</option>
        {READING_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Add to collection"
        className="h-6 w-auto text-xs"
        value=""
        onChange={(e) => e.target.value && bulk({ kind: 'add-to-collection', collectionId: e.target.value })}
      >
        <option value="">Add to collection…</option>
        {collections?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {collectionId ? (
        <Button size="sm" variant="ghost" onClick={() => bulk({ kind: 'remove-from-collection', collectionId })}>
          Remove from this collection
        </Button>
      ) : null}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) bulk({ kind: 'add-tags', tags: [tag.trim()] });
          setTag('');
        }}
      >
        <Input aria-label="Tag to add" placeholder="Add tag" value={tag} onChange={(e) => setTag(e.target.value)} className="h-6 w-28 text-xs" maxLength={80} />
      </form>
      <Button size="sm" variant="ghost" onClick={() => bulk({ kind: 'favorite', value: true })}>
        <Star /> Favourite
      </Button>
      <Button size="sm" variant="ghost" onClick={() => bulk({ kind: 'archive', value: true })}>
        <Archive /> Archive
      </Button>
      <Button size="sm" variant="ghost" onClick={() => bulk({ kind: 'archive', value: false })}>
        <ArchiveRestore /> Unarchive
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void exportBib()}>
        <Download /> BibTeX
      </Button>
      {zotero?.web.configured && zotero.web.canWrite ? (
        <Button size="sm" variant="ghost" onClick={() => setSending(true)}>
          Send to Zotero
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(true)}>
        <Trash2 /> Delete
      </Button>
      <Button size="sm" variant="link" className="ml-auto" onClick={onDone}>
        Clear selection
      </Button>
      <DeleteDialog itemIds={ids} open={deleting} onClose={() => setDeleting(false)} onDeleted={onDone} />
      {sending ? <ZoteroExportDialog itemIds={ids} open onClose={() => setSending(false)} /> : null}
    </div>
  );
}

export function PapersView({
  filters,
  onFiltersChange,
  selectedId,
  onSelect,
  railOpen,
}: {
  filters: PaperFilters;
  onFiltersChange: (f: PaperFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  railOpen: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const query = toQuery(filters, offset);
  const { data, error, isLoading, isFetching } = useLibraryItems(query);

  // A different filter starts again at the first page with nothing selected.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    setOffset(0);
    setChecked(new Set());
  }, [filterKey]);

  const items = data?.items ?? [];
  const toggle = (id: string, on: boolean) =>
    setChecked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChecked = items.length > 0 && items.every((i) => checked.has(i.id));

  return (
    <div className="flex min-h-0 flex-1">
      {railOpen ? (
        <aside aria-label="Filters" className="w-[220px] shrink-0 overflow-y-auto border-r border-rule bg-paper">
          <FilterRail filters={filters} onChange={onFiltersChange} />
        </aside>
      ) : null}
      <section aria-label="Papers" aria-busy={isFetching} className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
        {checked.size ? <BulkBar ids={[...checked]} collectionId={filters.collectionId} onDone={() => setChecked(new Set())} /> : null}
        <div className="flex items-center gap-3 border-b border-rule px-3 py-2 text-2xs text-ink-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => setChecked(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
              aria-label="Select all papers on this page"
              className="accent-[var(--rs-accent)]"
            />
            {data ? `${data.total} paper${data.total === 1 ? '' : 's'}` : ''}
          </label>
          {isFetching && !isLoading ? <Spinner className="size-3" /> : null}
          <Select aria-label="Sort by" className="ml-auto h-6 w-auto text-xs" value={filters.sort} onChange={(e) => onFiltersChange({ ...filters, sort: e.target.value as LibrarySort })}>
            {LIBRARY_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        {isLoading ? (
          <div className="px-5 py-6">
            <Spinner className="text-ink-muted" />
          </div>
        ) : error ? (
          <p role="alert" className="px-5 py-6 text-ui text-danger">
            {errorMessage(error)}
          </p>
        ) : items.length === 0 ? (
          <div className="px-6 py-14">
            <p className="font-display text-[18px] italic text-ink-muted">{filters.q || JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) ? 'No papers match.' : 'Your library is empty.'}</p>
            <p className="mt-1 text-ui text-ink-muted">Add papers from literature search, or import PDFs, BibTeX, RIS or Zotero on the Import tab.</p>
          </div>
        ) : (
          <>
            <ul aria-label="Papers" data-testid="library-items">
              {items.map((item) => (
                <PaperRow key={item.id} item={item} selected={item.id === selectedId} checked={checked.has(item.id)} onOpen={() => onSelect(item.id)} onCheck={(v) => toggle(item.id, v)} />
              ))}
            </ul>
            {data && data.total > PAGE ? (
              <nav aria-label="Pages" className="flex items-center justify-center gap-3 border-t border-rule py-3 text-xs text-ink-muted">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
                <Button size="sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
