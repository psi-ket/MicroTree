import { ArrowLeft, Download, FileText, Pencil, RefreshCw, Star, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RuntimeApiError } from '@research-studio/api-contracts';
import { safeExternalUrl } from '@research-studio/literature-engine/format';
import { READING_STATUSES, type LibraryItem, type ReadingStatus } from '@research-studio/shared-types';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Input, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary, useCollections, useLibraryItem } from '../../lib/queries';
import { ExternalLink, SectionHeading, Tag } from '../literature/common';
import { change, downloadText, MetadataTag, StatusSpine } from './common';
import { DeleteDialog } from './DeleteDialog';
import { EditDetailsDialog } from './EditDetailsDialog';
import { upsertLibraryJob } from './jobs';
import { CONFIDENCE_LABEL, formatBytes, METADATA_HINT, ORIGIN_LABEL, STATUS_LABEL } from './model';
import { DocumentPanel } from '../documents/DocumentPanel';
import { PdfViewer } from './PdfViewer';

function ReadingStatusPicker({ item }: { item: LibraryItem }) {
  const set = (readingStatus: ReadingStatus) => void change('change the reading status', () => runtime().library.update(item.id, { readingStatus }));
  return (
    <fieldset>
      <legend className="sr-only">Reading status</legend>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Reading status">
        {READING_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={item.readingStatus === s}
            onClick={() => set(s)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-ctl border px-2 text-xs',
              item.readingStatus === s ? 'border-accent bg-accent-soft text-ink' : 'border-rule text-ink-muted hover:border-rule-strong hover:text-ink',
            )}
          >
            <StatusSpine status={s} className="h-3.5 w-[5px]" decorative />
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Attachments({ item, onOpen }: { item: LibraryItem; onOpen: (attachmentId: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const work = item.work;
  const hasOpenAccess = !!(safeExternalUrl(work.openAccess.pdfUrl) ?? safeExternalUrl(work.urls.pdf));

  const upload = async (file: File) => {
    const res = await change('upload the PDF', () => runtime().library.attachPdf(item.id, file, file.name));
    if (res) {
      upsertLibraryJob(res.job);
      toast.info('Checking the PDF…');
    }
  };
  const fetchOpenAccess = async () => {
    const res = await change('download the open-access PDF', () => runtime().library.fetchOpenAccessPdf(item.id));
    if (res) {
      upsertLibraryJob(res.job);
      toast.info('Downloading the open-access PDF…');
    }
  };
  const download = async (id: string, fileName: string) => {
    try {
      const bytes = await runtime().library.attachmentContent(id);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      toast.error('Could not download the file', { description: errorMessage(err) });
    }
  };

  return (
    <section aria-labelledby="lib-files" className="mt-5">
      <SectionHeading id="lib-files">Files</SectionHeading>
      {item.attachments.length ? (
        <ul className="mt-2 divide-y divide-rule border-y border-rule">
          {item.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 py-2 text-ui">
              <FileText aria-hidden className="size-4 shrink-0 text-ink-muted" />
              {renaming === a.id ? (
                <form
                  className="flex flex-1 items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void change('rename the file', () => runtime().library.renameAttachment(a.id, name)).then(() => setRenaming(null));
                  }}
                >
                  <Input aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} className="h-6 text-xs" maxLength={200} autoFocus />
                  <Button size="sm" type="submit">
                    Rename
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Cancel renaming" onClick={() => setRenaming(null)}>
                    <X />
                  </Button>
                </form>
              ) : (
                <>
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-accent hover:underline disabled:text-ink-muted disabled:no-underline" disabled={!a.available} onClick={() => onOpen(a.id)}>
                    {a.fileName}
                  </button>
                  <span className="shrink-0 text-2xs text-ink-muted">{a.available ? formatBytes(a.fileSize) : 'File missing'}</span>
                  <Button size="icon-sm" variant="ghost" aria-label={`Download ${a.fileName}`} disabled={!a.available} onClick={() => void download(a.id, a.fileName)}>
                    <Download />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Rename ${a.fileName}`}
                    onClick={() => {
                      setName(a.fileName);
                      setRenaming(a.id);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${a.fileName}`}
                    onClick={() => {
                      if (window.confirm(`Remove ${a.fileName} from this paper?`)) void change('remove the file', () => runtime().library.deleteAttachment(a.id));
                    }}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-ui text-ink-muted">No PDF yet.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        <Button size="sm" onClick={() => input.current?.click()}>
          <Upload /> Attach a PDF
        </Button>
        {hasOpenAccess && !item.attachments.length ? (
          <Button size="sm" onClick={() => void fetchOpenAccess()} title="Downloads the open-access PDF listed in the paper's record">
            <Download /> Get the open-access PDF
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function MatchReview({ item }: { item: LibraryItem }) {
  const [busy, setBusy] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const match = item.match;
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    await change(what, fn);
    setBusy(false);
  };
  if (item.metadataStatus !== 'needs-review' && item.metadataStatus !== 'unresolved') return null;

  const link = (e: FormEvent) => {
    e.preventDefault();
    if (identifier.trim()) void act('use that record', () => runtime().library.match(item.id, { action: 'link-work', workId: identifier.trim() }));
  };

  return (
    <section aria-labelledby="lib-match" className="mt-5 rounded-md border border-warning/40 bg-warning-soft/40 p-3">
      <SectionHeading id="lib-match">{item.metadataStatus === 'needs-review' ? 'Is this the right paper?' : 'Not identified'}</SectionHeading>
      <p className="mt-1 text-xs text-ink-muted">{METADATA_HINT[item.metadataStatus]}</p>
      {match?.candidates.length ? (
        <ul className="mt-2 space-y-2">
          {match.candidates.map((c) => (
            <li key={c.work.id} className="rounded border border-rule bg-panel p-2.5">
              <p className="font-display text-[14px] leading-snug text-ink">{c.work.title}</p>
              <p className="mt-0.5 text-2xs text-ink-muted">
                {c.work.authors
                  .slice(0, 3)
                  .map((a) => a.name)
                  .join(', ')}
                {c.work.authors.length > 3 ? ' et al.' : ''}
                {c.work.publicationYear ? ` · ${c.work.publicationYear}` : ''}
                {c.work.venue ? ` · ${c.work.venue}` : ''}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
                <Tag dot={c.confidence.startsWith('exact') || c.confidence === 'strong' ? 'success' : 'warning'}>{CONFIDENCE_LABEL[c.confidence]}</Tag>
                {c.reasons.join('; ')}
              </p>
              <Button size="sm" className="mt-2" disabled={busy} onClick={() => void act('use this record', () => runtime().library.match(item.id, { action: 'accept-candidate', candidateWorkId: c.work.id }))}>
                Use this record
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={link} className="mt-3 flex items-center gap-1.5">
        <Input aria-label="DOI or arXiv ID of the right paper" placeholder="DOI or arXiv ID of the right paper" value={identifier} onChange={(e) => setIdentifier(e.target.value)} className="h-7 text-xs" maxLength={400} />
        <Button size="sm" type="submit" disabled={busy || !identifier.trim()}>
          Look up
        </Button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.metadataStatus === 'needs-review' ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('keep the details', () => runtime().library.match(item.id, { action: 'keep-unresolved' }))}>
            None of these: keep my details
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('look the paper up again', () => runtime().library.refresh(item.id))}>
          <RefreshCw /> Search again
        </Button>
      </div>
    </section>
  );
}

function CitationKey({ item }: { item: LibraryItem }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState(item.citationKey ?? '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ message: string } | null>(null);
  useEffect(() => setKey(item.citationKey ?? ''), [item.citationKey]);

  const start = async () => {
    setEditing(true);
    try {
      setSuggestions((await runtime().library.citationKeySuggestions(item.id)).suggestions);
    } catch {
      setSuggestions([]);
    }
  };
  const save = async (confirmed: boolean) => {
    try {
      await runtime().library.setCitationKey(item.id, key.trim(), confirmed);
      setEditing(false);
      setConfirm(null);
      invalidateLibrary();
    } catch (err) {
      if (err instanceof RuntimeApiError && err.status === 409 && (err.details as { reason?: string } | undefined)?.reason === 'KEY_IN_USE') {
        setConfirm({ message: err.message });
      } else {
        toast.error('Could not change the citation key', { description: errorMessage(err) });
      }
    }
  };

  return (
    <div className="mt-4">
      <SectionHeading>Citation key</SectionHeading>
      {editing ? (
        <form
          className="mt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <div className="flex items-center gap-1.5">
            <Input aria-label="Citation key" value={key} onChange={(e) => setKey(e.target.value)} className="h-7 font-mono text-xs" maxLength={200} autoFocus />
            <Button size="sm" type="submit" disabled={!key.trim()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {suggestions.length ? (
            <p className="mt-1.5 flex flex-wrap gap-1 text-2xs text-ink-muted">
              Suggestions:
              {suggestions.map((s) => (
                <button key={s} type="button" className="font-mono text-accent hover:underline" onClick={() => setKey(s)}>
                  {s}
                </button>
              ))}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="mt-1 flex items-center gap-2">
          <code className="font-mono text-xs text-ink">{item.citationKey ?? 'none'}</code>
          <Button size="sm" variant="link" className="h-auto px-0" onClick={() => void start()}>
            Change
          </Button>
        </p>
      )}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent aria-describedby="lib-key-confirm">
          <DialogTitle>Change a key that may be cited?</DialogTitle>
          <DialogDescription id="lib-key-confirm">
            {confirm?.message}. Existing \cite commands and .bib files keep the old key until you update them.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep {item.citationKey}
            </Button>
            <Button variant="primary" onClick={() => void save(true)}>
              Change to {key.trim()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TagsEditor({ item }: { item: LibraryItem }) {
  const [text, setText] = useState('');
  const save = (tags: string[]) => void change('update the tags', () => runtime().library.update(item.id, { tags }));
  return (
    <div className="mt-4">
      <SectionHeading>Tags</SectionHeading>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {item.tags.map((t) => (
          <span key={t} className="inline-flex h-6 items-center gap-1 rounded-[3px] bg-sunken pl-1.5 text-xs text-ink">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} className="grid h-6 w-5 place-items-center text-ink-muted hover:text-ink" onClick={() => save(item.tags.filter((x) => x !== t))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (t && !item.tags.includes(t)) save([...item.tags, t]);
            setText('');
          }}
        >
          <Input aria-label="Add a tag" placeholder="Add tag" value={text} onChange={(e) => setText(e.target.value)} className="h-6 w-28 text-xs" maxLength={80} />
        </form>
      </div>
    </div>
  );
}

function Notes({ item }: { item: LibraryItem }) {
  const [text, setText] = useState(item.notes);
  useEffect(() => setText(item.notes), [item.notes]);
  const dirty = text !== item.notes;
  return (
    <div className="mt-4">
      <label htmlFor={`notes-${item.id}`}>
        <SectionHeading>Notes</SectionHeading>
      </label>
      <textarea
        id={`notes-${item.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => dirty && void change('save the notes', () => runtime().library.update(item.id, { notes: text }))}
        rows={4}
        maxLength={100_000}
        placeholder="Your notes on this paper"
        className="mt-1.5 w-full resize-y rounded-ctl border border-rule bg-raised px-2 py-1.5 text-ui text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {dirty ? <p className="text-2xs text-ink-muted">Saved when you leave the field.</p> : null}
    </div>
  );
}

function Collections({ item }: { item: LibraryItem }) {
  const { data: all } = useCollections();
  const others = (all ?? []).filter((c) => !item.collections.some((x) => x.id === c.id));
  return (
    <div className="mt-4">
      <SectionHeading>Collections</SectionHeading>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {item.collections.map((c) => (
          <span key={c.id} className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-rule pl-1.5 text-xs text-ink">
            <span aria-hidden className="size-2 rounded-full" style={{ background: c.color ?? 'var(--rs-ink-faint)' }} />
            {c.name}
            <button
              type="button"
              aria-label={`Remove from ${c.name}`}
              className="grid h-6 w-5 place-items-center text-ink-muted hover:text-ink"
              onClick={() => void change('remove it from the collection', () => runtime().library.removeFromCollection(c.id, [item.id]))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {others.length ? (
          <Select
            aria-label="Add to a collection"
            className="h-6 w-auto text-xs"
            value=""
            onChange={(e) => e.target.value && void change('add it to the collection', () => runtime().library.addToCollection(e.target.value, [item.id]))}
          >
            <option value="">Add to…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ) : !item.collections.length ? (
          <span className="text-xs text-ink-muted">None. Create collections on the Collections tab.</span>
        ) : null}
      </div>
    </div>
  );
}

function ZoteroLink({ item }: { item: LibraryItem }) {
  const link = item.external.find((l) => l.provider === 'zotero');
  if (!link) return null;
  const keep = (side: 'local' | 'remote') => void change('settle the Zotero conflict', () => runtime().library.zotero.resolveConflict(item.id, side));
  return (
    <div className="mt-4">
      <SectionHeading>Zotero</SectionHeading>
      <p className="mt-1 text-xs text-ink-muted">
        Linked to item <code className="font-mono">{link.externalItemId}</code> ({link.externalLibraryId === 'local' ? 'Zotero on this computer' : 'zotero.org'})
        {link.lastSyncedAt ? `, last synced ${new Date(link.lastSyncedAt).toLocaleString()}` : ''}.
      </p>
      {link.syncStatus === 'conflict' && link.conflict ? (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning-soft/40 p-2.5 text-xs">
          <p className="font-medium text-ink">Changed here and in Zotero</p>
          <table className="mt-1.5 w-full text-left">
            <thead className="text-ink-muted">
              <tr>
                <th className="pr-2 font-normal">Field</th>
                <th className="pr-2 font-normal">Here</th>
                <th className="font-normal">Zotero</th>
              </tr>
            </thead>
            <tbody>
              {link.conflict.fields.map((f) => (
                <tr key={f.field} className="align-top">
                  <td className="pr-2 text-ink-muted">{f.field}</td>
                  <td className="pr-2">{f.local ?? '—'}</td>
                  <td>{f.remote ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" onClick={() => keep('local')}>
              Keep mine
            </Button>
            <Button size="sm" onClick={() => keep('remote')}>
              Use Zotero's
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ItemDetails({
  itemId,
  onBack,
  onDeleted,
  onSearchPaper,
}: {
  itemId: string;
  onBack: (() => void) | null;
  onDeleted: () => void;
  onSearchPaper?: (itemId: string, title: string) => void;
}) {
  const { data: item, error, isLoading } = useLibraryItem(itemId);
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (isLoading) return <Spinner className="m-6 text-ink-muted" />;
  if (error || !item) return <p className="px-6 py-8 text-ui text-danger">{error ? errorMessage(error) : 'Paper not found'}</p>;
  const work = item.work;
  const doi = work.identifiers.doi;
  const arxiv = work.identifiers.arxivId;

  const exportBib = async () => {
    const res = await change('export the entry', () => runtime().library.export({ format: 'bibtex', selection: { itemIds: [item.id] } }));
    if (res) downloadText(res.text, `${item.citationKey ?? 'entry'}.bib`, 'application/x-bibtex;charset=utf-8');
  };

  return (
    <article className="px-5 pb-10 pt-4" aria-labelledby="lib-item-title" data-testid="library-item">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-ink-muted" onClick={onBack}>
          <ArrowLeft /> Back to papers
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <MetadataTag status={item.metadataStatus} />
        <Tag>{ORIGIN_LABEL[item.origin]}</Tag>
        {item.archivedAt ? <Tag>Archived</Tag> : null}
      </div>
      <h2 id="lib-item-title" className="mt-2 font-display text-[21px] leading-[1.25] text-ink">
        {work.title}
      </h2>
      <p className="mt-1.5 text-ui text-ink-muted">{work.authors.length ? work.authors.map((a) => a.name).join(', ') : 'Unknown authors'}</p>
      <p className="mt-1 text-xs text-ink-muted">
        {[work.publicationYear, work.venue, work.bibliographic.volume ? `vol. ${work.bibliographic.volume}` : null, work.bibliographic.pages ? `pp. ${work.bibliographic.pages}` : null].filter(Boolean).join(' · ')}
      </p>
      <p className="mt-1.5 flex flex-wrap gap-3 text-xs">
        {doi ? <ExternalLink href={`https://doi.org/${doi}`}>doi:{doi}</ExternalLink> : null}
        {arxiv ? <ExternalLink href={`https://arxiv.org/abs/${arxiv}`}>arXiv:{arxiv}</ExternalLink> : null}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <ReadingStatusPicker item={item} />
      </div>
      <p className="mt-1 text-2xs text-ink-muted">Only you set the reading status; opening a PDF never changes it.</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" aria-pressed={item.isFavorite} onClick={() => void change('update the paper', () => runtime().library.update(item.id, { isFavorite: !item.isFavorite }))}>
          <Star className={cn(item.isFavorite && 'fill-warning text-warning')} />
          {item.isFavorite ? 'Favourite' : 'Add to favourites'}
        </Button>
        <Button size="sm" onClick={() => setEditing(true)}>
          <Pencil /> Edit details
        </Button>
        <Button size="sm" onClick={() => void exportBib()}>
          <Download /> BibTeX
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void change('update the paper', () => runtime().library.update(item.id, { archived: !item.archivedAt }))}>
          {item.archivedAt ? 'Unarchive' : 'Archive'}
        </Button>
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(true)}>
          <Trash2 /> Delete
        </Button>
      </div>

      <MatchReview item={item} />
      <Attachments item={item} onOpen={(id) => setViewing(id)} />
      <DocumentPanel itemId={item.id} title={work.title} attachments={item.attachments} {...(onSearchPaper ? { onSearchPaper: () => onSearchPaper(item.id, work.title) } : {})} />
      <CitationKey item={item} />
      <TagsEditor item={item} />
      <Collections item={item} />
      <Notes item={item} />
      {item.projects.length ? (
        <div className="mt-4">
          <SectionHeading>Used in projects</SectionHeading>
          <p className="mt-1 text-ui text-ink">{item.projects.map((p) => p.name).join(', ')}</p>
        </div>
      ) : null}
      <ZoteroLink item={item} />
      {work.abstract ? (
        <div className="mt-5">
          <SectionHeading>Abstract</SectionHeading>
          <p className="mt-1.5 text-ui leading-relaxed text-ink">{work.abstract}</p>
        </div>
      ) : null}

      {viewing ? <PdfViewer itemId={item.id} attachmentId={viewing} title={work.title} onClose={() => setViewing(null)} /> : null}
      <EditDetailsDialog item={item} open={editing} onClose={() => setEditing(false)} />
      <DeleteDialog itemIds={[item.id]} open={deleting} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
    </article>
  );
}
