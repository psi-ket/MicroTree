import { History, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  LITERATURE_PROVIDERS,
  LITERATURE_SORTS,
  type LiteratureProviderId,
  type LiteratureProviderStatus,
  type LiteratureSearchHistoryEntry,
  type LiteratureSort,
} from '@research-studio/shared-types';
import { Button, Input, Label, PanelHeading, Select } from '@research-studio/ui';
import { useQueryClient } from '@tanstack/react-query';
import { runtime } from '../../lib/connection';
import { errorMessage, keys } from '../../lib/queries';
import { EMPTY_FILTERS, FILTER_TYPES, isEmptyDraft, MODE_LABEL, providerName, SORT_LABEL, TYPE_LABEL, type FilterDraft } from './model';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-rule px-3 pb-3 pt-1 first:border-t-0">
      <legend className="sr-only">{title}</legend>
      <PanelHeading aria-hidden className="h-7 px-0 text-ink-muted">
        {title}
      </PanelHeading>
      {children}
    </fieldset>
  );
}

function Check({ checked, onChange, disabled, children, hint }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-baseline gap-2 py-[3px] text-ui text-ink has-[:disabled]:cursor-default has-[:disabled]:text-ink-muted">
      <input type="checkbox" className="translate-y-[1px] accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {children}
        {hint ? <span className="ml-1 text-2xs text-ink-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function FiltersPanel({
  providers,
  onProvidersChange,
  providerStatus,
  sort,
  onSortChange,
  draft,
  onDraftChange,
  onApply,
  error,
}: {
  providers: LiteratureProviderId[];
  onProvidersChange: (p: LiteratureProviderId[]) => void;
  providerStatus: LiteratureProviderStatus[] | undefined;
  sort: LiteratureSort;
  onSortChange: (s: LiteratureSort) => void;
  draft: FilterDraft;
  /** `apply`: re-run the search now (checkboxes); typed fields apply on Enter. */
  onDraftChange: (d: FilterDraft, apply: boolean) => void;
  onApply: () => void;
  error: string | null;
}) {
  const enabled = (id: LiteratureProviderId) => providerStatus?.find((p) => p.id === id)?.enabled ?? true;
  const set = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K], apply: boolean) => onDraftChange({ ...draft, [key]: value }, apply);
  const textField = (key: 'authors' | 'venue' | 'categories', label: string, placeholder: string, hint?: string) => (
    <div className="mt-2 space-y-1">
      <Label htmlFor={`lit-${key}`}>{label}</Label>
      <Input id={`lit-${key}`} value={draft[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value, false)} className="h-7 text-xs" />
      {hint ? <p className="text-2xs text-ink-muted">{hint}</p> : null}
    </div>
  );

  return (
    <form
      aria-label="Filters"
      className="pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      <Group title="Sources">
        {LITERATURE_PROVIDERS.map((id) => {
          const on = enabled(id);
          const checked = on && providers.includes(id);
          const last = checked && providers.filter(enabled).length === 1;
          return (
            <Check
              key={id}
              checked={checked}
              disabled={!on || last}
              hint={!on ? 'turned off' : undefined}
              onChange={(v) => onProvidersChange(v ? LITERATURE_PROVIDERS.filter((p) => p === id || providers.includes(p)) : providers.filter((p) => p !== id))}
            >
              {providerName(id)}
            </Check>
          );
        })}
      </Group>

      <Group title="Sort">
        <Select aria-label="Sort results" value={sort} onChange={(e) => onSortChange(e.target.value as LiteratureSort)} className="h-7 text-xs">
          {LITERATURE_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </Select>
      </Group>

      <Group title="Published">
        <div className="flex items-center gap-2">
          <Input
            aria-label="From year"
            inputMode="numeric"
            placeholder="From"
            value={draft.yearFrom}
            onChange={(e) => set('yearFrom', e.target.value, false)}
            className="h-7 w-[4.75rem] text-xs tabular-nums"
          />
          <span aria-hidden className="text-ink-muted">
            –
          </span>
          <Input
            aria-label="To year"
            inputMode="numeric"
            placeholder="To"
            value={draft.yearTo}
            onChange={(e) => set('yearTo', e.target.value, false)}
            className="h-7 w-[4.75rem] text-xs tabular-nums"
          />
        </div>
        <div className="mt-2">
          <Check checked={draft.openAccessOnly} onChange={(v) => set('openAccessOnly', v, true)}>
            Open access only
          </Check>
        </div>
      </Group>

      <Group title="Type">
        {FILTER_TYPES.map((t) => (
          <Check key={t} checked={draft.types.includes(t)} onChange={(v) => set('types', v ? [...draft.types, t] : draft.types.filter((x) => x !== t), true)}>
            {TYPE_LABEL[t]}
          </Check>
        ))}
      </Group>

      <Group title="Narrow down">
        {textField('authors', 'Author', 'Shor, Peter', 'Separate several authors with “;”.')}
        {textField('venue', 'Journal or venue', 'Physical Review A')}
        {textField('categories', 'arXiv categories', 'quant-ph, cs.LG', 'Other sources approximate these by field.')}
      </Group>

      {error ? (
        <p role="alert" className="mx-3 rounded-ctl border border-danger/30 bg-danger-soft px-2 py-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2 px-3">
        <Button type="submit" size="sm" variant="primary">
          Apply filters
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isEmptyDraft(draft)} onClick={() => onDraftChange(EMPTY_FILTERS, true)}>
          Clear filters
        </Button>
      </div>
    </form>
  );
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function RecentSearches({ entries, onRun }: { entries: LiteratureSearchHistoryEntry[]; onRun: (e: LiteratureSearchHistoryEntry) => void }) {
  const qc = useQueryClient();
  const remove = async (id: number) => {
    try {
      await runtime().literature.deleteHistoryEntry(id);
      void qc.invalidateQueries({ queryKey: keys.literature.history });
    } catch (err) {
      toast.error('Could not remove the search', { description: errorMessage(err) });
    }
  };
  if (!entries.length) return null;
  return (
    <section aria-labelledby="lit-recent" className="border-t border-rule px-3 pb-4">
      <PanelHeading id="lit-recent" className="h-8 px-0 text-ink-muted">
        <History className="size-3" aria-hidden /> Recent searches
      </PanelHeading>
      <ul className="space-y-0.5">
        {entries.slice(0, 12).map((e) => (
          <li key={e.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onRun(e)}
              className="min-w-0 flex-1 rounded px-1.5 py-1 text-left hover:bg-sunken"
              title={`${MODE_LABEL[e.request.mode ?? 'all']} · ${time.format(new Date(e.createdAt))}`}
            >
              <span className="block truncate text-xs text-ink">{e.query}</span>
              <span className="block text-2xs tabular-nums text-ink-muted">
                {e.resultCount} result{e.resultCount === 1 ? '' : 's'} · {time.format(new Date(e.createdAt))}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove “${e.query}” from recent searches`}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => void remove(e.id)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
