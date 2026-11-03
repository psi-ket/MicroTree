import { BookMarked, FileDiff, Plus, Settings2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CITE_COMMANDS, type CiteCommand, type ProjectCitation } from '@research-studio/shared-types';
import { Button, cn, Input, Label, PanelHeading, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary, useLibraryItems, useProjectReferences } from '../../lib/queries';
import { openLibrary } from '../../lib/routes';
import { useEditor } from '../../stores/editor';
import { StatusSpine } from '../library/common';
import { authorsShort, CITE_LABEL } from '../library/model';
import { Tag } from '../literature/common';
import { openFile, saveAll } from '../workspace/actions';
import { BibReviewDialog } from './BibReviewDialog';

const CITATION_LABEL: Record<ProjectCitation['status'], string> = {
  'library-and-bib': 'In .bib',
  'bib-only': 'In .bib, not in library',
  'library-only': 'Not in .bib yet',
  unresolved: 'Not found',
};
const CITATION_DOT = { 'library-and-bib': 'success', 'bib-only': 'neutral', 'library-only': 'warning', unresolved: 'danger' } as const;

function insertCite(command: CiteCommand, keys: string[]): void {
  const active = useEditor.getState().active;
  if (!active || !/\.(tex|ltx)$/i.test(active)) {
    toast.info('Open a .tex file and place the cursor where the citation goes');
    return;
  }
  useEditor.getState().insertAtCursor(`\\${command}{${keys.join(',')}}`);
}

function AddFromLibrary({ projectId, linked }: { projectId: string; linked: Set<string> }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const { data, isFetching } = useLibraryItems({ ...(debounced ? { q: debounced } : {}), archived: 'active', sort: 'added-desc', limit: 8, offset: 0 });
  const link = (id: string) =>
    void runtime()
      .references.link(projectId, [id])
      .then(invalidateLibrary, (err: unknown) => toast.error('Could not add the paper', { description: errorMessage(err) }));
  const candidates = (data?.items ?? []).filter((i) => !linked.has(i.id));
  return (
    <div className="border-t border-rule px-3 py-2.5">
      <Label htmlFor="refs-add" className="flex items-center gap-1.5">
        Add papers from your library {isFetching ? <Spinner className="size-3" /> : null}
      </Label>
      <Input id="refs-add" type="search" placeholder="Title, author or key" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 text-xs" maxLength={300} />
      <ul className="mt-1.5 space-y-0.5">
        {candidates.map((i) => (
          <li key={i.id} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-sunken/60">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-ink">{i.title}</span>
              <span className="block truncate text-2xs text-ink-muted">
                {authorsShort(i.authors, i.authorCount)}
                {i.year ? ` · ${i.year}` : ''}
              </span>
            </span>
            <Button size="icon-sm" variant="ghost" aria-label={`Add ${i.title} to this project`} onClick={() => link(i.id)}>
              <Plus />
            </Button>
          </li>
        ))}
        {data && !candidates.length ? <li className="px-1 text-2xs text-ink-muted">{debounced ? 'No other papers match.' : 'All recent papers are already here.'}</li> : null}
      </ul>
    </div>
  );
}

function Settings({ projectId, bibFile, citeCommand, bibFiles }: { projectId: string; bibFile: string; citeCommand: CiteCommand; bibFiles: string[] }) {
  const [file, setFile] = useState(bibFile);
  useEffect(() => setFile(bibFile), [bibFile]);
  const save = (patch: { bibFile?: string; citeCommand?: CiteCommand }) =>
    void runtime()
      .references.updateSettings(projectId, patch)
      .then(invalidateLibrary, (err: unknown) => toast.error('Could not save the setting', { description: errorMessage(err) }));
  return (
    <div className="space-y-2 border-b border-rule bg-sunken/40 px-3 py-2.5 text-xs">
      <div>
        <Label htmlFor="refs-cite">Citation command</Label>
        <Select id="refs-cite" className="h-7 text-xs" value={citeCommand} onChange={(e) => save({ citeCommand: e.target.value as CiteCommand })}>
          {CITE_COMMANDS.map((c) => (
            <option key={c} value={c}>
              {CITE_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (file.trim() && file.trim() !== bibFile) save({ bibFile: file.trim() });
        }}
      >
        <Label htmlFor="refs-bib">Bibliography file</Label>
        <div className="flex gap-1">
          <Input id="refs-bib" list="refs-bib-files" className="h-7 font-mono text-xs" value={file} onChange={(e) => setFile(e.target.value)} maxLength={500} />
          <datalist id="refs-bib-files">
            {bibFiles.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <Button size="sm" type="submit" disabled={!file.trim() || file.trim() === bibFile}>
            Use
          </Button>
        </div>
      </form>
    </div>
  );
}

/** The project's papers: cite them in the manuscript and keep the .bib file in step, always through a reviewed diff. */
export function ReferencesPanel({ projectId }: { projectId: string }) {
  const { data, error, isLoading } = useProjectReferences(projectId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const command = data?.settings.citeCommand ?? 'cite';
  const byKey = new Map((data?.citations ?? []).map((c) => [c.key, c]));
  const linked = new Set((data?.items ?? []).map((i) => i.id));
  const checkedKeys = (data?.items ?? []).filter((i) => checked.has(i.id) && i.citationKey).map((i) => i.citationKey!);
  const unresolved = (data?.citations ?? []).filter((c) => c.status === 'unresolved');
  const pending = (data?.items ?? []).filter((i) => i.citationKey && byKey.get(i.citationKey)?.status !== 'library-and-bib' && byKey.get(i.citationKey)?.status !== 'bib-only').length;

  const unlink = (id: string) =>
    void runtime()
      .references.unlink(projectId, [id])
      .then(invalidateLibrary, (err: unknown) => toast.error('Could not remove the paper', { description: errorMessage(err) }));
  const review = () => void saveAll().finally(() => setReviewing(true));

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper" aria-label="References" data-testid="references-panel">
      <PanelHeading className="gap-0.5 pr-1.5">
        <span>References</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Open your library" onClick={() => void saveAll().finally(() => openLibrary(projectId))}>
          <BookMarked />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Reference settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
          <Settings2 />
        </Button>
      </PanelHeading>
      {isLoading ? (
        <Spinner className="m-3 text-ink-muted" />
      ) : error || !data ? (
        <p className="p-3 text-ui text-danger">{error ? errorMessage(error) : ''}</p>
      ) : (
        <>
          {settingsOpen ? <Settings projectId={projectId} bibFile={data.settings.bibFile} citeCommand={command} bibFiles={data.bibFiles} /> : null}
          <div className="flex items-center gap-1.5 border-b border-rule px-3 py-2">
            <Button size="sm" variant={pending ? 'primary' : 'secondary'} onClick={review} disabled={!data.items.length} data-testid="bib-review-open">
              <FileDiff /> Update {data.settings.bibFile}
            </Button>
            {pending ? <span className="text-2xs text-ink-muted">{pending} not in the file yet</span> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {checkedKeys.length > 1 ? (
              <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-rule bg-raised px-3 py-1.5 text-xs">
                <span className="text-ink-muted">{checkedKeys.length} selected</span>
                <Button size="sm" variant="primary" className="ml-auto" onClick={() => insertCite(command, checkedKeys)}>
                  Insert \{command}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                  Clear
                </Button>
              </div>
            ) : null}
            {data.items.length ? (
              <ul aria-label="Papers in this project">
                {data.items.map((i) => {
                  const citation = i.citationKey ? byKey.get(i.citationKey) : undefined;
                  return (
                    <li key={i.id} className="group flex items-start gap-2 border-b border-rule px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked.has(i.id)}
                        aria-label={`Select ${i.title}`}
                        disabled={!i.citationKey}
                        onChange={(e) =>
                          setChecked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(i.id);
                            else n.delete(i.id);
                            return n;
                          })
                        }
                        className="mt-1 accent-[var(--rs-accent)]"
                      />
                      <StatusSpine status={i.readingStatus} className="mt-0.5 h-8 w-[5px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs leading-snug text-ink">{i.title}</span>
                        <span className="block truncate text-2xs text-ink-muted">
                          {authorsShort(i.authors, i.authorCount)}
                          {i.year ? ` · ${i.year}` : ''}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <code className="font-mono text-2xs text-ink">{i.citationKey ?? 'no key'}</code>
                          {citation ? (
                            <Tag dot={CITATION_DOT[citation.status]}>
                              {citation.occurrences.length ? `Cited ${citation.occurrences.length}×` : 'Not cited'} · {CITATION_LABEL[citation.status]}
                            </Tag>
                          ) : (
                            <Tag dot="warning">Not cited · not in .bib yet</Tag>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <Button size="sm" variant="ghost" className="font-mono text-2xs" disabled={!i.citationKey} onClick={() => insertCite(command, [i.citationKey!])} aria-label={`Insert \\${command}{${i.citationKey ?? ''}}`}>
                          \{command}
                        </Button>
                        <Button size="icon-sm" variant="ghost" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Remove ${i.title} from this project`} onClick={() => unlink(i.id)}>
                          <X />
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-3 py-4 text-xs text-ink-muted">No papers attached yet. Add them below or from the library. The .bib file is only changed after you review the diff.</p>
            )}
            {unresolved.length ? (
              <section aria-labelledby="refs-unresolved" className="border-b border-rule px-3 py-2.5">
                <h3 id="refs-unresolved" className="text-2xs font-semibold uppercase tracking-[0.08em] text-danger">
                  Cited but not found
                </h3>
                <ul className="mt-1 space-y-1 text-xs">
                  {unresolved.map((c) => (
                    <li key={c.key}>
                      <code className="font-mono text-ink">{c.key}</code>{' '}
                      {c.occurrences.slice(0, 3).map((o) => (
                        <button key={`${o.file}:${o.line}`} type="button" className={cn('ml-1 text-2xs text-accent hover:underline')} onClick={() => void openFile(o.file, { line: o.line })}>
                          {o.file}:{o.line}
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <AddFromLibrary projectId={projectId} linked={linked} />
          </div>
        </>
      )}
      {reviewing ? <BibReviewDialog projectId={projectId} open onClose={() => setReviewing(false)} /> : null}
    </aside>
  );
}
