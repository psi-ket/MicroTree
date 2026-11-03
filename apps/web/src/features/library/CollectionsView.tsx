import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { LibraryCollection } from '@research-studio/shared-types';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Label, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, useCollections } from '../../lib/queries';
import { change } from './common';

/** A small, fixed palette that reads in both themes. */
const COLORS = ['#24508f', '#2a7f6d', '#9a6a12', '#b8382a', '#6b4fa0', '#4f6b7a'];

function ColorPicker({ value, onChange, name }: { value: string | null; onChange: (c: string | null) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={`Colour of ${name}`} className="flex items-center gap-1.5">
      {[null, ...COLORS].map((c) => (
        <button
          key={c ?? 'none'}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c ?? 'No colour'}
          onClick={() => onChange(c)}
          className="grid size-5 place-items-center rounded-full border border-rule aria-checked:ring-2 aria-checked:ring-accent aria-checked:ring-offset-1 aria-checked:ring-offset-panel"
          style={c ? { background: c } : undefined}
        >
          {c ? null : <span aria-hidden className="h-px w-3 rotate-45 bg-ink-muted" />}
        </button>
      ))}
    </div>
  );
}

function CollectionRow({ collection, onOpen }: { collection: LibraryCollection; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.name);
  const [deleting, setDeleting] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await change('rename the collection', () => runtime().library.updateCollection(collection.id, { name: name.trim() }))) setEditing(false);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
      <span aria-hidden className="h-8 w-1.5 rounded-full" style={{ background: collection.color ?? 'var(--rs-rule-strong)' }} />
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input aria-label="Collection name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="h-7" autoFocus />
          <Button size="sm" type="submit" disabled={!name.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block font-display text-[16px] text-ink hover:text-accent">{collection.name}</span>
          <span className="text-2xs text-ink-muted">
            {collection.itemCount} paper{collection.itemCount === 1 ? '' : 's'}
            {collection.description ? ` · ${collection.description}` : ''}
          </span>
        </button>
      )}
      <ColorPicker name={collection.name} value={collection.color} onChange={(color) => void change('change the colour', () => runtime().library.updateCollection(collection.id, { color }))} />
      <Button size="icon-sm" variant="ghost" aria-label={`Rename ${collection.name}`} onClick={() => setEditing(true)}>
        <Pencil />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={`Delete ${collection.name}`} onClick={() => setDeleting(true)}>
        <Trash2 />
      </Button>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent aria-describedby={`del-${collection.id}`}>
          <DialogTitle>Delete “{collection.name}”?</DialogTitle>
          <DialogDescription id={`del-${collection.id}`}>
            Only the collection is deleted. Its {collection.itemCount === 1 ? 'paper stays' : `${collection.itemCount} papers stay`} in your library.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Keep
            </Button>
            <Button variant="danger" onClick={() => void change('delete the collection', () => runtime().library.deleteCollection(collection.id)).then(() => setDeleting(false))}>
              Delete collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function CollectionsView({ onOpen }: { onOpen: (collectionId: string) => void }) {
  const { data, error, isLoading } = useCollections();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(COLORS[0]!);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await change('create the collection', () => runtime().library.createCollection({ name: name.trim(), color }))) setName('');
  };

  return (
    <section aria-label="Collections" className="mx-auto w-full max-w-3xl overflow-y-auto px-2 py-6">
      <form onSubmit={(e) => void create(e)} className="flex flex-wrap items-end gap-3 px-4 pb-5">
        <div className="min-w-48 flex-1">
          <Label htmlFor="new-collection">New collection</Label>
          <Input id="new-collection" placeholder="e.g. Thesis chapter 2" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        <ColorPicker name="the new collection" value={color} onChange={setColor} />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          <Plus /> Create
        </Button>
      </form>
      {isLoading ? (
        <Spinner className="mx-4 text-ink-muted" />
      ) : error ? (
        <p className="px-4 text-danger">{errorMessage(error)}</p>
      ) : data?.length ? (
        <ul className="border-t border-rule bg-panel">
          {data.map((c) => (
            <CollectionRow key={c.id} collection={c} onOpen={() => onOpen(c.id)} />
          ))}
        </ul>
      ) : (
        <p className="px-4 font-display text-[17px] italic text-ink-muted">No collections yet. A paper can be in several collections at once.</p>
      )}
    </section>
  );
}
