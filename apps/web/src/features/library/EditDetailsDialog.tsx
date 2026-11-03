import { useEffect, useState, type FormEvent } from 'react';
import { PUBLICATION_TYPES, type EditableField, type LibraryItem, type PublicationType, type WorkEdits } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Label, Select } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { TYPE_LABEL } from '../literature/model';
import { change } from './common';

type Draft = Record<'title' | 'authors' | 'year' | 'date' | 'venue' | 'publisher' | 'type' | 'volume' | 'issue' | 'pages' | 'doi' | 'arxivId' | 'url' | 'abstract', string>;

function draftOf(item: LibraryItem): Draft {
  const w = item.work;
  return {
    title: w.title,
    // One author per line: "Family, Given" or a single name (organisations).
    authors: w.authors.map((a) => (a.familyName ? `${a.familyName}${a.givenName ? `, ${a.givenName}` : ''}` : a.name)).join('\n'),
    year: w.publicationYear?.toString() ?? '',
    date: w.publicationDate ?? '',
    venue: w.venue ?? '',
    publisher: w.publisher ?? '',
    type: w.publicationType ?? '',
    volume: w.bibliographic.volume ?? '',
    issue: w.bibliographic.issue ?? '',
    pages: w.bibliographic.pages ?? '',
    doi: w.identifiers.doi ?? '',
    arxivId: w.identifiers.arxivId ?? '',
    url: w.urls.landingPage ?? '',
    abstract: w.abstract ?? '',
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Only fields that differ from what is shown become corrections. */
function editsFrom(before: Draft, after: Draft): { edits: WorkEdits; error: string | null } {
  const edits: WorkEdits = {};
  if (after.title !== before.title) {
    if (!after.title.trim()) return { edits, error: 'A paper needs a title' };
    edits.title = after.title.trim();
  }
  if (after.authors !== before.authors) {
    edits.authors = after.authors
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const comma = l.indexOf(',');
        return comma > 0 ? { familyName: l.slice(0, comma).trim(), givenName: orNull(l.slice(comma + 1)), name: null } : { familyName: null, givenName: null, name: l };
      });
  }
  if (after.year !== before.year) {
    const y = after.year.trim() ? Number(after.year) : null;
    if (y !== null && !(Number.isInteger(y) && y > 0 && y < 3000)) return { edits, error: 'The year must be a number such as 1995' };
    edits.publicationYear = y;
  }
  if (after.date !== before.date) {
    if (after.date.trim() && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(after.date.trim())) return { edits, error: 'Write the date as YYYY, YYYY-MM or YYYY-MM-DD' };
    edits.publicationDate = orNull(after.date);
  }
  const simple: [keyof Draft, Exclude<EditableField, 'title' | 'authors' | 'publicationYear' | 'publicationDate' | 'publicationType'>][] = [
    ['venue', 'venue'],
    ['publisher', 'publisher'],
    ['volume', 'volume'],
    ['issue', 'issue'],
    ['pages', 'pages'],
    ['doi', 'doi'],
    ['arxivId', 'arxivId'],
    ['url', 'url'],
    ['abstract', 'abstract'],
  ];
  for (const [d, field] of simple) if (after[d] !== before[d]) edits[field] = orNull(after[d]);
  if (after.type !== before.type) edits.publicationType = (after.type || null) as PublicationType | null;
  return { edits, error: null };
}

export function EditDetailsDialog({ item, open, onClose }: { item: LibraryItem; open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(draftOf(item));
      setError(null);
    }
  }, [open, item]);
  const edited = Object.keys(item.edits) as EditableField[];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { edits, error: problem } = editsFrom(draftOf(item), draft);
    setError(problem);
    if (problem) return;
    if (!Object.keys(edits).length) return onClose();
    if (await change('save the details', () => runtime().library.update(item.id, { edits }))) onClose();
  };
  const revert = async () => {
    if (await change('restore the details', () => runtime().library.update(item.id, { revertFields: edited }))) onClose();
  };

  const field = (key: keyof Draft, label: string, props: { mono?: boolean; placeholder?: string } = {}) => (
    <div>
      <Label htmlFor={`edit-${key}`}>{label}</Label>
      <Input id={`edit-${key}`} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={props.mono ? 'font-mono text-xs' : undefined} placeholder={props.placeholder} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[4vh] max-h-[92vh] w-[min(640px,calc(100vw-32px))] overflow-y-auto" aria-describedby="lib-edit-desc">
        <DialogTitle>Edit details</DialogTitle>
        <DialogDescription id="lib-edit-desc">
          Your corrections are kept separately from the source record{edited.length ? ` (corrected now: ${edited.join(', ')})` : ''}. Leave a field empty to remove its value.
        </DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3 text-ui">
          {field('title', 'Title')}
          <div>
            <Label htmlFor="edit-authors">Authors, one per line (“Family, Given”)</Label>
            <textarea
              id="edit-authors"
              rows={4}
              value={draft.authors}
              onChange={(e) => setDraft({ ...draft, authors: e.target.value })}
              className="w-full resize-y rounded-ctl border border-rule bg-raised px-2 py-1.5 text-ui text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field('year', 'Year')}
            {field('date', 'Date', { placeholder: 'YYYY-MM-DD' })}
            <div>
              <Label htmlFor="edit-type">Type</Label>
              <Select id="edit-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                <option value="">Unknown</option>
                {PUBLICATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {field('venue', 'Journal, conference or repository')}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {field('publisher', 'Publisher')}
            {field('volume', 'Volume')}
            {field('issue', 'Issue')}
            {field('pages', 'Pages')}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {field('doi', 'DOI', { mono: true })}
            {field('arxivId', 'arXiv ID', { mono: true })}
          </div>
          {field('url', 'Web page', { mono: true })}
          <div>
            <Label htmlFor="edit-abstract">Abstract</Label>
            <textarea
              id="edit-abstract"
              rows={5}
              value={draft.abstract}
              onChange={(e) => setDraft({ ...draft, abstract: e.target.value })}
              className="w-full resize-y rounded-ctl border border-rule bg-raised px-2 py-1.5 text-ui text-ink focus:border-accent focus:outline-none"
            />
          </div>
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="items-center">
            {edited.length ? (
              <Button variant="link" className="mr-auto px-0" onClick={() => void revert()}>
                Restore the source details
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save details
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
