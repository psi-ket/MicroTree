import { FileSearch, Search, X } from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ResearchSearch, SearchResult } from '@research-studio/api-contracts';
import { SECTION_TYPES, type SectionType } from '@research-studio/document-intelligence';
import { Button, cn, Input, Label, Select, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, useCollections, useIndexStatus } from '../../lib/queries';
import { Tag } from '../literature/common';
import { markTerms, MATCH_LABEL, MODE_LABEL, SECTION_LABEL } from './model';
import { SourceViewer } from './SourceViewer';

type Mode = 'hybrid' | 'keyword' | 'semantic';

/** The passage text with query terms marked; React text only, never HTML. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  const parts = text.split(re);
  const out: ReactNode[] = parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-accent-soft px-0.5 text-ink">
        {part}
      </mark>
    ) : (
      part
    ),
  );
  return <>{out}</>;
}

function ResultCard({ r, terms, onOpen }: { r: SearchResult; terms: string[]; onOpen: () => void }) {
  return (
    <li className="rounded-md border border-rule bg-panel p-3" data-testid="search-result">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-2xs tabular-nums text-ink-muted">{r.position}.</span>
        <h3 className="min-w-0 font-display text-[15px] leading-snug text-ink">{r.paper.title}</h3>
      </div>
      <p className="mt-0.5 text-xs text-ink-muted">
        {[r.paper.authors.slice(0, 4).join(', ') + (r.paper.authors.length > 4 ? ' et al.' : ''), r.paper.year, r.paper.venue].filter(Boolean).join(' · ') || 'Unknown authors'}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
        <span className="text-ink">{r.sectionPath || 'No section heading'}</span>
        <span>· {r.pageStart ? `p. ${r.pageStart}${r.pageEnd && r.pageEnd !== r.pageStart ? `–${r.pageEnd}` : ''}` : 'page unknown'}</span>
        {r.kind !== 'body' ? <Tag>{r.kind}</Tag> : null}
        <Tag dot={r.matchedBy === 'hybrid' ? 'success' : 'neutral'} title={`Keyword rank ${r.keywordRank ?? 'none'}, semantic rank ${r.semanticRank ?? 'none'}`}>
          {MATCH_LABEL[r.matchedBy]}
          {r.keywordRank ? ` · kw #${r.keywordRank}` : ''}
          {r.semanticRank ? ` · sem #${r.semanticRank}` : ''}
        </Tag>
      </p>
      <p className="mt-2 whitespace-pre-line text-ui leading-relaxed text-ink">
        <Marked text={r.text} terms={terms} />
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onOpen}>
          <FileSearch /> Open in PDF
        </Button>
        <span className="text-2xs text-ink-muted">
          {r.provenance.extractor === 'grobid' ? 'GROBID' : 'PyMuPDF'} {r.provenance.extractorVersion ?? ''} · PDF {r.provenance.sourceSha256.slice(0, 10)}…
        </span>
      </div>
    </li>
  );
}

/**
 * Search across the passages of all processed papers, without any AI
 * model: keyword (BM25), semantic (local embeddings, when an index exists)
 * or both fused by rank. Results are exact source passages.
 */
export function SearchView({ paperScope, onClearPaperScope }: { paperScope: { id: string; title: string } | null; onClearPaperScope: () => void }) {
  const { data: collections } = useCollections();
  const { data: index } = useIndexStatus();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [collectionId, setCollectionId] = useState('');
  const [author, setAuthor] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [section, setSection] = useState<SectionType | ''>('');
  const [includeReferences, setIncludeReferences] = useState(false);
  const [result, setResult] = useState<ResearchSearch | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SearchResult | null>(null);
  const controller = useRef<AbortController | null>(null);

  const run = async (offset: number) => {
    if (!query.trim()) return;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setLoading(true);
    setError(null);
    const year = (v: string) => (/^\d{4}$/.test(v) ? Number(v) : undefined);
    try {
      const res = await runtime().research.search(
        {
          query,
          mode,
          scope: paperScope ? { kind: 'papers', libraryItemIds: [paperScope.id] } : collectionId ? { kind: 'collections', collectionIds: [collectionId] } : { kind: 'library' },
          filters: {
            ...(author.trim() ? { author: author.trim() } : {}),
            ...(year(yearFrom) ? { yearFrom: year(yearFrom) } : {}),
            ...(year(yearTo) ? { yearTo: year(yearTo) } : {}),
            ...(section ? { sectionTypes: [section] } : {}),
            ...(includeReferences ? { includeReferences } : {}),
          },
          limit: 20,
          offset,
        },
        ac.signal,
      );
      setResult(res);
      setResults((prev) => (offset ? [...prev, ...res.results] : res.results));
    } catch (err) {
      if (!ac.signal.aborted) setError(errorMessage(err));
    } finally {
      if (controller.current === ac) setLoading(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(0);
  };
  const terms = result ? markTerms(result.query) : [];
  const noIndex = index && index.documents.processed === 0;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto" data-testid="research-search">
      <div className="mx-auto max-w-4xl px-4 py-5">
        <h2 className="font-display text-[19px] text-ink">Search across your papers</h2>
        <p className="mt-0.5 text-xs text-ink-muted">Finds exact passages in the full text of processed PDFs. Nothing is generated; results come from the local index.</p>
        <form role="search" aria-label="Full-text search" className="mt-3" onSubmit={submit}>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
              <Input
                aria-label="Search the full text"
                placeholder='e.g. Lindblad master equation, "bosonic codes", section:methods, 10.1103/…'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={1000}
                className="pl-8"
                data-testid="research-query"
              />
            </div>
            <Button type="submit" variant="primary" disabled={!query.trim() || loading}>
              {loading ? <Spinner /> : null} Search
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <fieldset>
              <legend className="mb-1 text-2xs text-ink-muted">Method</legend>
              <div className="flex gap-0.5" role="radiogroup" aria-label="Search method">
                {(['hybrid', 'keyword', 'semantic'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn('h-7 rounded-ctl border px-2 text-xs', mode === m ? 'border-accent bg-accent-soft text-ink' : 'border-rule text-ink-muted hover:text-ink')}
                  >
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </fieldset>
            {paperScope ? (
              <div className="flex items-center gap-1 text-xs text-ink">
                <span>In: {paperScope.title.length > 50 ? `${paperScope.title.slice(0, 50)}…` : paperScope.title}</span>
                <Button size="icon-sm" variant="ghost" aria-label="Search the whole library instead" onClick={onClearPaperScope}>
                  <X />
                </Button>
              </div>
            ) : (
              <div>
                <Label htmlFor="rs-scope" className="text-2xs text-ink-muted">
                  Scope
                </Label>
                <Select id="rs-scope" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className="h-7 text-xs">
                  <option value="">Entire library</option>
                  {collections?.map((c) => (
                    <option key={c.id} value={c.id}>
                      Collection: {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="rs-section" className="text-2xs text-ink-muted">
                Section
              </Label>
              <Select id="rs-section" value={section} onChange={(e) => setSection(e.target.value as SectionType | '')} className="h-7 text-xs">
                <option value="">Any section</option>
                {SECTION_TYPES.filter((s) => s !== 'references').map((s) => (
                  <option key={s} value={s}>
                    {SECTION_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="rs-author" className="text-2xs text-ink-muted">
                Author
              </Label>
              <Input id="rs-author" value={author} onChange={(e) => setAuthor(e.target.value)} className="h-7 w-32 text-xs" maxLength={200} />
            </div>
            <div className="flex items-end gap-1">
              <div>
                <Label htmlFor="rs-from" className="text-2xs text-ink-muted">
                  From year
                </Label>
                <Input id="rs-from" inputMode="numeric" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} className="h-7 w-16 text-xs" maxLength={4} />
              </div>
              <div>
                <Label htmlFor="rs-to" className="text-2xs text-ink-muted">
                  To year
                </Label>
                <Input id="rs-to" inputMode="numeric" value={yearTo} onChange={(e) => setYearTo(e.target.value)} className="h-7 w-16 text-xs" maxLength={4} />
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input type="checkbox" checked={includeReferences} onChange={(e) => setIncludeReferences(e.target.checked)} />
              Include bibliography entries
            </label>
          </div>
        </form>

        {noIndex ? <p className="mt-4 rounded-md border border-rule p-3 text-xs text-ink">No PDF has been processed yet. Open the Full text tab to extract your papers.</p> : null}
        {error ? (
          <p role="alert" className="mt-4 text-ui text-danger">
            {error}
          </p>
        ) : null}
        {result ? (
          <div className="mt-4" aria-live="polite">
            <p className="text-xs text-ink-muted">
              {result.total} passage{result.total === 1 ? '' : 's'} in {result.papersSearched} paper{result.papersSearched === 1 ? '' : 's'} · {MODE_LABEL[result.mode]}
              {result.semantic.used && result.semantic.model ? ` (embeddings: ${result.semantic.model})` : ''}
              {result.understood.notes.length ? ` · understood: ${result.understood.notes.join(', ')}` : ''}
            </p>
            {result.relaxed ? <p className="mt-1 text-xs text-ink">No passage contains all the words; showing passages with any of them.</p> : null}
            {result.warnings.map((w, i) => (
              <p key={i} className="mt-1 text-xs text-ink">
                {w}
              </p>
            ))}
            <p className="mt-1 text-2xs text-ink-muted">Order comes from rank fusion of the methods used. It reflects how well a passage matches the query, not whether it is correct.</p>
            {results.length ? (
              <ol className="mt-3 flex flex-col gap-2.5">
                {results.map((r) => (
                  <ResultCard key={r.passageId} r={r} terms={terms} onOpen={() => setOpen(r)} />
                ))}
              </ol>
            ) : (
              <p className="mt-4 font-display text-[16px] italic text-ink-muted">No passages found.</p>
            )}
            {results.length < result.total ? (
              <Button className="mt-3" onClick={() => void run(results.length)} disabled={loading}>
                More results
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {open ? <SourceViewer result={open} onBack={() => setOpen(null)} /> : null}
    </div>
  );
}
