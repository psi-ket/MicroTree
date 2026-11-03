import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import type { LibraryItemSummary } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary, keys } from '../../lib/queries';
import { SectionHeading } from '../literature/common';
import { authorsShort } from './model';

function Group({ items, reason }: { items: LibraryItemSummary[]; reason: string }) {
  const [keepId, setKeepId] = useState(items[0]!.id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const keep = items.find((i) => i.id === keepId)!;
  const drop = items.filter((i) => i.id !== keepId);
  const name = `dup-${items[0]!.id}`;

  const merge = async () => {
    setBusy(true);
    const dropped: string[] = [];
    try {
      for (const d of drop) {
        const res = await runtime().library.merge(keepId, d.id);
        if (res.droppedKey) dropped.push(res.droppedKey);
      }
      toast.success('Papers merged', {
        description: dropped.length ? `Citations of ${dropped.join(', ')} should now use ${keep.citationKey ?? 'the kept key'}.` : undefined,
      });
      setConfirming(false);
    } catch (err) {
      toast.error('Could not merge the papers', { description: errorMessage(err) });
    } finally {
      setBusy(false);
      invalidateLibrary();
    }
  };

  return (
    <li className="rounded-md border border-rule bg-panel p-3">
      <p className="text-2xs text-ink-muted">{reason}</p>
      <fieldset className="mt-1.5 space-y-1.5">
        <legend className="sr-only">Which record to keep</legend>
        {items.map((i) => (
          <label key={i.id} className="flex items-start gap-2 text-ui">
            <input type="radio" name={name} checked={keepId === i.id} onChange={() => setKeepId(i.id)} className="mt-1 accent-[var(--rs-accent)]" />
            <span className="min-w-0">
              <span className="block text-ink">{i.title}</span>
              <span className="block text-2xs text-ink-muted">
                {authorsShort(i.authors, i.authorCount)}
                {i.year ? ` · ${i.year}` : ''}
                {i.citationKey ? ` · ${i.citationKey}` : ''}
                {i.pdfCount ? ` · ${i.pdfCount} PDF` : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button size="sm" className="mt-2" onClick={() => setConfirming(true)}>
        Merge into the chosen record
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent aria-describedby={`${name}-desc`}>
          <DialogTitle>Merge {items.length} records?</DialogTitle>
          <DialogDescription id={`${name}-desc`}>
            “{keep.title}” stays{keep.citationKey ? ` with the key ${keep.citationKey}` : ''}. The PDFs, tags, collections, notes and project links of the other
            {drop.length === 1 ? ' record move' : ` ${drop.length} records move`} to it, and {drop.length === 1 ? 'that record is' : 'those records are'} removed.
            {drop.some((d) => d.citationKey) ? ` Citations of ${drop.map((d) => d.citationKey).filter(Boolean).join(', ')} in your manuscripts are not changed.` : ''}
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void merge()}>
              {busy ? <Spinner /> : null}
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Records that look like the same paper; nothing is merged without a choice. */
export function DuplicatesSection() {
  const { data, isLoading } = useQuery({ queryKey: keys.library.duplicates, queryFn: async () => (await runtime().library.duplicates()).groups });
  if (isLoading || !data?.length) return null;
  return (
    <section aria-labelledby="ov-dups" className="md:col-span-2">
      <SectionHeading id="ov-dups" level={2}>
        Possibly the same paper
      </SectionHeading>
      <ul className="mt-2 grid gap-3 md:grid-cols-2">
        {data.map((g) => (
          <Group key={g.items.map((i) => i.id).join()} items={g.items} reason={g.reason} />
        ))}
      </ul>
    </section>
  );
}
