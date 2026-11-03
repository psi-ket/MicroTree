import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { ZoteroImportPreview, ZoteroMode } from '@research-studio/shared-types';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Label, Select, Spinner, Switch } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary, useZoteroStatus } from '../../lib/queries';
import { SectionHeading, Tag } from '../literature/common';
import { upsertLibraryJob } from './jobs';

const STATE_LABEL: Record<ZoteroImportPreview['items'][number]['state'], string> = {
  new: 'New',
  linked: 'Already imported',
  'remote-changes': 'Changed in Zotero',
  conflict: 'Changed on both sides',
  duplicate: 'Same paper already in library',
};
const STATE_DOT = { new: 'success', linked: 'neutral', 'remote-changes': 'success', conflict: 'warning', duplicate: 'neutral' } as const;
/** Entries the import would change by default; the rest are listed for information. */
const IMPORTABLE = new Set(['new', 'remote-changes', 'duplicate']);

function WebKey() {
  const { data: status } = useZoteroStatus();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const web = status?.web;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await runtime().library.zotero.setWebKey(key.trim());
      toast.success('Connected to zotero.org');
      invalidateLibrary();
    } catch (err) {
      toast.error('Could not connect to zotero.org', { description: errorMessage(err) });
    } finally {
      // The key leaves the page as soon as it is sent; it is never kept in browser storage.
      setKey('');
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await runtime().library.zotero.deleteWebKey();
      invalidateLibrary();
    } catch (err) {
      toast.error('Could not remove the key', { description: errorMessage(err) });
    }
  };

  if (web?.configured) {
    return (
      <div className="text-ui">
        <p>
          Connected to zotero.org{web.username ? ` as ${web.username}` : ''}
          {web.canWrite === false ? ' (read-only key: sending papers to Zotero is not possible)' : ''}.
        </p>
        {web.lastError ? <p className="mt-1 text-xs text-danger">Last error: {web.lastError}</p> : null}
        <Button size="sm" variant="ghost" className="mt-1 px-0 text-danger" onClick={() => void remove()}>
          Disconnect and forget the key
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)}>
      <Label htmlFor="zotero-key">zotero.org API key</Label>
      <div className="flex gap-1.5">
        <Input
          id="zotero-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="font-mono text-xs"
          maxLength={64}
          placeholder="Create one at zotero.org/settings/keys"
        />
        <Button type="submit" size="md" disabled={busy || key.trim().length < 10}>
          {busy ? <Spinner /> : null}
          Connect
        </Button>
      </div>
      <p className="mt-1 text-2xs text-ink-muted">The key is stored by Research Studio on this computer and is never shown again or kept in the browser.</p>
    </form>
  );
}

function LocalToggle() {
  const { data: status, isFetching } = useZoteroStatus(true);
  const local = status?.local;
  return (
    <div className="flex items-start gap-3 text-ui">
      <Switch
        id="zotero-local"
        checked={!!local?.enabled}
        onCheckedChange={(enabled) =>
          void runtime()
            .library.zotero.setLocal(enabled)
            .then(invalidateLibrary, (err: unknown) => toast.error('Could not change the setting', { description: errorMessage(err) }))
        }
      />
      <div>
        <Label htmlFor="zotero-local" className="mb-0">
          Read from Zotero on this computer
        </Label>
        <p className="text-2xs text-ink-muted">
          {!local?.enabled
            ? 'Uses the local API of Zotero 7 (turn it on in Zotero’s advanced settings). Read-only.'
            : isFetching
              ? 'Checking…'
              : local.reachable
                ? 'Zotero is running and answering.'
                : `Zotero is not answering${local.lastError ? `: ${local.lastError}` : ''}. Start Zotero and allow other applications to talk to it.`}
        </p>
      </div>
    </div>
  );
}

function ImportPreview({ mode }: { mode: ZoteroMode }) {
  const [collectionKey, setCollectionKey] = useState('');
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [importPdfs, setImportPdfs] = useState(true);
  const [resolveIdentifiers, setResolveIdentifiers] = useState(true);
  const preview = useQuery({
    queryKey: ['library', 'zotero-preview', mode, collectionKey],
    queryFn: ({ signal }) => runtime().library.zotero.previewImport({ mode, ...(collectionKey ? { collectionKey } : {}) }, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const data = preview.data;
  const selected = chosen ?? new Set(data?.items.filter((i) => IMPORTABLE.has(i.state)).map((i) => i.externalItemId) ?? []);

  const run = async () => {
    try {
      const { job } = await runtime().library.zotero.import({
        mode,
        ...(collectionKey ? { collectionKey } : {}),
        itemKeys: [...selected],
        importPdfs,
        resolveIdentifiers,
        importCollections: true,
      });
      upsertLibraryJob(job);
      toast.info('Zotero import started', { description: 'It runs in the background; you can keep working.' });
      setChosen(null);
    } catch (err) {
      toast.error('Could not start the Zotero import', { description: errorMessage(err) });
    }
  };

  if (preview.isLoading) return <Spinner className="mt-2 text-ink-muted" />;
  if (preview.error) return <p className="mt-2 text-ui text-danger">{errorMessage(preview.error)}</p>;
  if (!data) return null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Label htmlFor="zotero-coll" className="mb-0">
          From
        </Label>
        <Select
          id="zotero-coll"
          className="h-6 w-auto text-xs"
          value={collectionKey}
          onChange={(e) => {
            setCollectionKey(e.target.value);
            setChosen(null);
          }}
        >
          <option value="">The whole Zotero library</option>
          {data.collections.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </Select>
        <span className="text-ink-muted">
          {data.items.length} item{data.items.length === 1 ? '' : 's'}
          {data.skipped ? `, ${data.skipped} notes or attachments skipped` : ''}
        </span>
      </div>
      {data.items.length ? (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-rule">
          <table className="w-full text-left text-xs">
            <tbody>
              {data.items.map((i) => (
                <tr key={i.externalItemId} className="border-b border-rule align-top last:border-0">
                  <td className="w-8 px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Import ${i.title}`}
                      checked={selected.has(i.externalItemId)}
                      disabled={i.state === 'linked' || i.state === 'conflict'}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(i.externalItemId);
                        else next.delete(i.externalItemId);
                        setChosen(next);
                      }}
                      className="accent-[var(--rs-accent)]"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="block text-ink">{i.title}</span>
                    <span className="text-ink-muted">
                      {i.creators.slice(0, 2).join(', ')}
                      {i.creators.length > 2 ? ' et al.' : ''}
                      {i.year ? ` · ${i.year}` : ''}
                      {i.hasPdf ? ' · PDF' : ''}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <Tag dot={STATE_DOT[i.state]}>{STATE_LABEL[i.state]}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.items.some((i) => i.state === 'conflict') ? (
        <p className="mt-1 text-2xs text-ink-muted">Items changed on both sides are not imported; settle them on the paper’s page.</p>
      ) : null}
      <fieldset className="mt-2 space-y-1 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={importPdfs} onChange={(e) => setImportPdfs(e.target.checked)} className="accent-[var(--rs-accent)]" />
          Copy attached PDFs
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={resolveIdentifiers} onChange={(e) => setResolveIdentifiers(e.target.checked)} className="accent-[var(--rs-accent)]" />
          Look up DOIs and arXiv IDs
        </label>
      </fieldset>
      <Button variant="primary" className="mt-2" disabled={!selected.size} onClick={() => void run()}>
        Import {selected.size} item{selected.size === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

/** Zotero is optional: everything else in the library works without it. */
export function ZoteroSection() {
  const { data: status } = useZoteroStatus();
  const [previewing, setPreviewing] = useState<ZoteroMode | null>(null);
  const canWeb = !!status?.web.configured;
  const canLocal = !!status?.local.enabled;
  return (
    <section aria-labelledby="imp-zotero">
      <SectionHeading id="imp-zotero" level={2}>Zotero (optional)</SectionHeading>
      <div className="mt-2 space-y-4 rounded-md border border-rule bg-panel p-4">
        <WebKey />
        <LocalToggle />
        {status?.linkedItems ? (
          <p className="text-xs text-ink-muted">
            {status.linkedItems} paper{status.linkedItems === 1 ? ' is' : 's are'} linked to Zotero
            {status.conflicts ? `; ${status.conflicts} changed on both sides` : ''}. To send papers to Zotero, select them on the Papers tab.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={!canWeb} aria-pressed={previewing === 'web'} onClick={() => setPreviewing(previewing === 'web' ? null : 'web')}>
            Import from zotero.org
          </Button>
          <Button size="sm" disabled={!canLocal} aria-pressed={previewing === 'local'} onClick={() => setPreviewing(previewing === 'local' ? null : 'local')}>
            Import from Zotero on this computer
          </Button>
        </div>
        {previewing ? <ImportPreview key={previewing} mode={previewing} /> : null}
      </div>
    </section>
  );
}

const EXPORT_LABEL = { create: 'Will be added', update: 'Will be updated', unchanged: 'Unchanged', conflict: 'Changed on both sides: skipped' } as const;

/** Sending papers to zotero.org: what would change is shown first. */
export function ZoteroExportDialog({ itemIds, open, onClose }: { itemIds: string[]; open: boolean; onClose: () => void }) {
  const preview = useQuery({
    queryKey: ['library', 'zotero-export', itemIds],
    queryFn: () => runtime().library.zotero.previewExport(itemIds),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const items = preview.data?.items ?? [];
  const sending = items.filter((i) => i.action === 'create' || i.action === 'update').length;
  const send = async () => {
    try {
      upsertLibraryJob((await runtime().library.zotero.export(itemIds)).job);
      toast.info('Sending papers to Zotero…');
      onClose();
    } catch (err) {
      toast.error('Could not send the papers', { description: errorMessage(err) });
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))]" aria-describedby="zotero-export-desc">
        <DialogTitle>Send to Zotero</DialogTitle>
        <DialogDescription id="zotero-export-desc">Papers are added to your zotero.org library. Items already linked are updated only if you changed them here.</DialogDescription>
        <div className="mt-3 max-h-72 overflow-y-auto text-xs">
          {preview.isLoading ? (
            <Spinner className="text-ink-muted" />
          ) : preview.error ? (
            <p className="text-ui text-danger">{errorMessage(preview.error)}</p>
          ) : (
            <ul className="divide-y divide-rule border-y border-rule">
              {items.map((i) => (
                <li key={i.libraryItemId} className="flex items-start justify-between gap-3 py-1.5">
                  <span className="text-ink">{i.title}</span>
                  <span className={cn('shrink-0', i.action === 'conflict' ? 'text-warning' : 'text-ink-muted')}>{EXPORT_LABEL[i.action]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!sending} onClick={() => void send()}>
            Send {sending} paper{sending === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
