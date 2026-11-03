import { FileUp, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { MAX_REFERENCE_TEXT } from '@research-studio/api-contracts';
import type { ImportJob } from '@research-studio/shared-types';
import { Button, cn, Label, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, useCollections, useLibraryJobs } from '../../lib/queries';
import { SectionHeading, Tag } from '../literature/common';
import { upsertLibraryJob } from './jobs';
import { isActiveJob, JOB_KIND_LABEL, jobSummary, OUTCOME_DOT, OUTCOME_LABEL } from './model';
import { ZoteroSection } from './ZoteroSection';

type Preview = Awaited<ReturnType<ReturnType<typeof runtime>['library']['previewReferences']>>;

const STATE_LABEL: Record<Preview['entries'][number]['state'], string> = {
  new: 'New',
  duplicate: 'Already in library',
  'likely-duplicate': 'Possibly already in library',
  invalid: 'Cannot be imported',
};

async function start(what: string, fn: () => Promise<{ job: ImportJob }>): Promise<boolean> {
  try {
    const { job } = await fn();
    upsertLibraryJob(job);
    toast.info(`${JOB_KIND_LABEL[job.kind]} started`, { description: 'It runs in the background; you can keep working.' });
    return true;
  } catch (err) {
    toast.error(`Could not ${what}`, { description: errorMessage(err) });
    return false;
  }
}

function PdfDrop() {
  const input = useRef<HTMLInputElement>(null);
  const { data: collections } = useCollections();
  const [collectionId, setCollectionId] = useState('');
  const [over, setOver] = useState(false);

  const send = (files: File[]) => {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length < files.length) toast.warning('Only PDF files are imported here');
    for (let i = 0; i < pdfs.length; i += 50) {
      const batch = pdfs.slice(i, i + 50).map((f) => ({ file: f, name: f.name }));
      void start('upload the PDFs', () => runtime().library.uploadPdfs(batch, collectionId || undefined));
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    send([...e.dataTransfer.files]);
  };

  return (
    <section aria-labelledby="imp-pdf">
      <SectionHeading id="imp-pdf" level={2}>PDF files</SectionHeading>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn('mt-2 flex flex-col items-center gap-2 rounded-md border border-dashed border-rule-strong bg-panel px-4 py-7 text-center', over && 'border-accent bg-accent-soft/40')}
      >
        <FileUp aria-hidden className="size-6 text-ink-muted" />
        <p className="text-ui text-ink">Drop PDFs here</p>
        <p className="max-w-md text-xs text-ink-muted">
          Each file is checked, stored once, and looked up by the DOI or arXiv ID it states. Matches that are not certain wait for you to confirm them.
        </p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            send([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button size="sm" onClick={() => input.current?.click()}>
          Choose PDF files
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <Label htmlFor="imp-pdf-coll" className="mb-0">
          Put them in
        </Label>
        <Select id="imp-pdf-coll" className="h-6 w-auto text-xs" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
          <option value="">No collection</option>
          {collections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
    </section>
  );
}

function ReferenceImport() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<'bibtex' | 'ris'>('bibtex');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [lookUp, setLookUp] = useState(true);
  const [searchTitles, setSearchTitles] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadFile = async (file: File) => {
    if (file.size > MAX_REFERENCE_TEXT) {
      toast.error('This file is too large to import at once');
      return;
    }
    setFormat(/\.ris$/i.test(file.name) ? 'ris' : 'bibtex');
    setText(await file.text());
    setPreview(null);
  };
  const runPreview = async () => {
    setBusy(true);
    try {
      const p = await runtime().library.previewReferences({ format, text });
      setPreview(p);
      setChosen(new Set(p.entries.filter((e) => e.state === 'new').map((e) => e.index)));
    } catch (err) {
      toast.error('Could not read the references', { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const runImport = async () => {
    const ok = await start('import the references', () =>
      runtime().library.importReferences({ format, text, only: [...chosen].sort((a, b) => a - b), resolveIdentifiers: lookUp, searchTitles }),
    );
    if (ok) {
      setPreview(null);
      setText('');
    }
  };

  return (
    <section aria-labelledby="imp-ref">
      <SectionHeading id="imp-ref" level={2}>BibTeX and RIS</SectionHeading>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select aria-label="Format" className="h-7 w-auto text-xs" value={format} onChange={(e) => setFormat(e.target.value as 'bibtex' | 'ris')}>
          <option value="bibtex">BibTeX / BibLaTeX</option>
          <option value="ris">RIS</option>
        </Select>
        <input
          ref={fileInput}
          type="file"
          accept=".bib,.ris,.txt,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void loadFile(f);
          }}
        />
        <Button size="sm" onClick={() => fileInput.current?.click()}>
          Choose a .bib or .ris file
        </Button>
        <span className="text-xs text-ink-muted">or paste below</span>
      </div>
      <textarea
        aria-label="References to import"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        rows={6}
        spellCheck={false}
        placeholder={format === 'bibtex' ? '@article{key, title={…}, author={…}, year={…}}' : 'TY  - JOUR\nTI  - …\nER  - '}
        className="mt-2 w-full resize-y rounded-ctl border border-rule bg-raised px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <Button size="sm" className="mt-1" disabled={!text.trim() || busy} onClick={() => void runPreview()}>
        {busy ? <Spinner /> : null}
        Preview
      </Button>

      {preview ? (
        <div className="mt-3">
          {preview.warnings.length ? (
            <ul className="mb-2 list-inside list-disc text-xs text-warning">
              {preview.warnings.slice(0, 5).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {preview.warnings.length > 5 ? <li>and {preview.warnings.length - 5} more</li> : null}
            </ul>
          ) : null}
          <div className="max-h-80 overflow-y-auto rounded-md border border-rule">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-raised text-ink-muted">
                <tr>
                  <th className="w-8 px-2 py-1.5 font-normal">
                    <span className="sr-only">Import</span>
                  </th>
                  <th className="px-2 py-1.5 font-normal">Entry</th>
                  <th className="px-2 py-1.5 font-normal">State</th>
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((e) => (
                  <tr key={e.index} className="border-t border-rule align-top">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Import ${e.title ?? e.label}`}
                        disabled={e.state === 'invalid' || e.state === 'duplicate'}
                        checked={chosen.has(e.index)}
                        onChange={(ev) =>
                          setChosen((s) => {
                            const n = new Set(s);
                            if (ev.target.checked) n.add(e.index);
                            else n.delete(e.index);
                            return n;
                          })
                        }
                        className="accent-[var(--rs-accent)]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="block text-ink">{e.title ?? <i>No title</i>}</span>
                      <span className="text-ink-muted">
                        {e.citationKey ? <code className="font-mono">{e.citationKey}</code> : null}
                        {e.authors.length ? ` · ${e.authors.slice(0, 2).join(', ')}${e.authors.length > 2 ? ' et al.' : ''}` : ''}
                        {e.year ? ` · ${e.year}` : ''}
                        {e.doi ? ` · ${e.doi}` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <Tag dot={e.state === 'new' ? 'success' : e.state === 'invalid' ? 'danger' : 'warning'} title={e.reason ?? undefined}>
                        {STATE_LABEL[e.state]}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <fieldset className="mt-2 space-y-1 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={lookUp} onChange={(e) => setLookUp(e.target.checked)} className="accent-[var(--rs-accent)]" />
              Look up DOIs and arXiv IDs (only exact matches are applied)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={searchTitles} onChange={(e) => setSearchTitles(e.target.checked)} className="accent-[var(--rs-accent)]" />
              Also search by title for entries without identifiers (slower; matches wait for review)
            </label>
          </fieldset>
          <Button variant="primary" className="mt-2" disabled={!chosen.size} onClick={() => void runImport()}>
            Import {chosen.size} entr{chosen.size === 1 ? 'y' : 'ies'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function IdentifierImport() {
  const [text, setText] = useState('');
  return (
    <section aria-labelledby="imp-ids">
      <SectionHeading id="imp-ids" level={2}>DOIs and arXiv IDs</SectionHeading>
      <textarea
        aria-label="DOIs and arXiv IDs, one per line"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={'10.1103/PhysRevA.52.R2493\narXiv:1706.03762'}
        className="mt-2 w-full resize-y rounded-ctl border border-rule bg-raised px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <Button size="sm" className="mt-1" disabled={!text.trim()} onClick={() => void start('look up the identifiers', () => runtime().library.importIdentifiers({ text })).then((ok) => ok && setText(''))}>
        Add papers
      </Button>
    </section>
  );
}

function JobRow({ job }: { job: ImportJob }) {
  const [open, setOpen] = useState(false);
  const active = isActiveJob(job);
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : null;
  return (
    <li className="border-b border-rule py-2.5" data-testid="library-job">
      <div className="flex items-center gap-2 text-ui">
        <span className="font-medium text-ink">{JOB_KIND_LABEL[job.kind]}</span>
        <span className="text-2xs text-ink-muted">{new Date(job.createdAt).toLocaleString()}</span>
        <span className="ml-auto text-xs tabular-nums text-ink-muted">
          {job.processed}
          {job.total ? ` / ${job.total}` : ''}
        </span>
        {active ? (
          <Button size="sm" variant="ghost" onClick={() => void runtime().library.cancelJob(job.id).then((r) => upsertLibraryJob(r.job))}>
            <X /> Cancel
          </Button>
        ) : null}
      </div>
      {active ? (
        <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${JOB_KIND_LABEL[job.kind]} progress`} aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          {pct !== null ? <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} /> : <div className="rs-progress absolute inset-0" />}
        </div>
      ) : null}
      <p className={cn('mt-1 text-xs', job.status === 'failed' ? 'text-danger' : 'text-ink-muted')}>{jobSummary(job)}</p>
      {job.items.length ? (
        <>
          <Button size="sm" variant="link" className="h-auto px-0" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Show details'}
          </Button>
          {open ? (
            <ul className="mt-1 space-y-1 text-xs">
              {job.items.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Tag dot={OUTCOME_DOT[item.outcome]} className="shrink-0">
                    {OUTCOME_LABEL[item.outcome]}
                  </Tag>
                  <span className="min-w-0">
                    <span className="text-ink">{item.label}</span>
                    {item.message ? <span className="block text-ink-muted">{item.message}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {job.warnings.length ? <p className="mt-1 text-2xs text-warning">{job.warnings.length} warning{job.warnings.length === 1 ? '' : 's'} while reading the file.</p> : null}
    </li>
  );
}

export function ImportView() {
  const { data: jobs } = useLibraryJobs();
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 overflow-y-auto px-6 py-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-8">
        <PdfDrop />
        <ReferenceImport />
        <IdentifierImport />
        <ZoteroSection />
      </div>
      <section aria-labelledby="imp-jobs">
        <SectionHeading id="imp-jobs" level={2}>Imports</SectionHeading>
        {jobs?.length ? (
          <ul className="mt-2 border-t border-rule" aria-live="polite">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-ui text-ink-muted">Imports you start appear here with their progress. They keep running while you use the rest of the app.</p>
        )}
      </section>
    </div>
  );
}
