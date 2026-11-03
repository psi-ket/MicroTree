import { ArrowLeft, BookMarked, Check, Copy, Download, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { citationKey, formatCitation, safeExternalUrl, toBibTeX } from '@research-studio/literature-engine/format';
import type { PublicationType, ScholarlyAuthor, ScholarlyWork } from '@research-studio/shared-types';
import { toast } from 'sonner';
import { Button, cn, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateLibrary, useAuthorProfile, useRelatedWorks } from '../../lib/queries';
import { upsertLibraryJob } from '../library/jobs';
import { copyText, ExternalLink, Notches, SectionHeading, Tag } from './common';
import { authorLine, authorProfileId, formatCount, formatDateTime, providerName, providersOf, TYPE_LABEL } from './model';

/** Fields the merger compares (literature-engine metadata-merger). */
const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  authorCount: 'Number of authors',
  publicationYear: 'Year',
  publicationDate: 'Publication date',
  venue: 'Venue',
  publicationType: 'Type',
  isOpenAccess: 'Open access',
};

/** Save the entry as `<citation key>.bib`. */
function downloadBib(work: ScholarlyWork, bibtex: string): void {
  const url = URL.createObjectURL(new Blob([bibtex], { type: 'application/x-bibtex;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${citationKey(work)}.bib`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function conflictValue(field: string, value: string): string {
  if (field === 'isOpenAccess') return value === 'true' ? 'Yes' : 'No';
  if (field === 'publicationType') return TYPE_LABEL[value as PublicationType] ?? value;
  return value;
}

function bibliographicLine(work: ScholarlyWork): string | null {
  const b = work.bibliographic;
  // Page ranges arrive as "R2493-R2496"; typeset them with an en dash.
  const pages = b.pages ? b.pages.replace(/(\w)-+(\w)/, '$1–$2') : null;
  const parts = [b.volume ? `${b.volume}${b.issue ? `(${b.issue})` : ''}` : b.issue ? `no. ${b.issue}` : null, pages].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function Authors({ authors, onAuthor }: { authors: ScholarlyAuthor[]; onAuthor: (id: string) => void }) {
  const [all, setAll] = useState(false);
  if (!authors.length) return <p className="text-ui text-ink-muted">Unknown authors</p>;
  const shown = all ? authors : authors.slice(0, 8);
  return (
    <p className="text-ui leading-relaxed text-ink-muted">
      {shown.map((a, i) => {
        const id = authorProfileId(a);
        return (
          <span key={`${a.name}-${i}`}>
            {id ? (
              <button type="button" className="text-ink underline decoration-rule-strong underline-offset-2 hover:text-accent hover:decoration-accent" onClick={() => onAuthor(id)}>
                {a.name}
              </button>
            ) : (
              <span className="text-ink">{a.name}</span>
            )}
            {a.orcid ? (
              <a href={`https://orcid.org/${a.orcid}`} target="_blank" rel="noopener noreferrer" className="ml-0.5 align-super text-[9px] font-semibold text-success" aria-label={`ORCID of ${a.name} (opens in a new tab)`}>
                iD
              </a>
            ) : null}
            {i < shown.length - 1 ? ', ' : ''}
          </span>
        );
      })}
      {authors.length > shown.length ? (
        <button type="button" className="ml-1 text-accent hover:underline" onClick={() => setAll(true)}>
          +{authors.length - shown.length} more
        </button>
      ) : null}
    </p>
  );
}

function RelatedWorks({ work, onOpen }: { work: ScholarlyWork; onOpen: (w: ScholarlyWork) => void }) {
  const [kind, setKind] = useState<'references' | 'citations' | null>(null);
  const query = useRelatedWorks(kind ?? 'references', work.id, kind !== null);
  return (
    <section aria-labelledby="lit-related" className="mt-6">
      <SectionHeading id="lit-related">Related works</SectionHeading>
      <div className="mt-2 flex gap-1.5" role="group" aria-label="Show related works">
        <Button size="sm" aria-pressed={kind === 'references'} variant={kind === 'references' ? 'primary' : 'secondary'} onClick={() => setKind('references')}>
          References{work.citation.referenceCount !== null ? ` (${formatCount(work.citation.referenceCount)})` : ''}
        </Button>
        <Button size="sm" aria-pressed={kind === 'citations'} variant={kind === 'citations' ? 'primary' : 'secondary'} onClick={() => setKind('citations')}>
          Cited by{work.citation.citedByCount !== null ? ` (${formatCount(work.citation.citedByCount)})` : ''}
        </Button>
      </div>
      {kind === null ? null : query.isLoading ? (
        <Spinner className="mt-3 text-ink-muted" />
      ) : query.error ? (
        <p className="mt-3 text-xs text-danger">{errorMessage(query.error)}</p>
      ) : query.data ? (
        <div className="mt-3">
          <p className="text-2xs text-ink-muted">
            {query.data.provider
              ? `${query.data.works.length}${query.data.total !== null && query.data.total > query.data.works.length ? ` of ${formatCount(query.data.total)}` : ''} from ${providerName(query.data.provider)}`
              : 'No source lists these for this work.'}
          </p>
          {query.data.works.length ? (
            <ul className="mt-1.5 divide-y divide-rule border-y border-rule">
              {query.data.works.map((w) => (
                <li key={w.id}>
                  <button type="button" className="w-full py-2 text-left hover:bg-sunken/60" onClick={() => onOpen(w)}>
                    <span className="block font-display text-[14px] leading-snug text-ink">{w.title}</span>
                    <span className="block truncate text-2xs text-ink-muted">
                      {authorLine(w.authors, 2)}
                      {w.publicationYear ? ` · ${w.publicationYear}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Keeps the paper in the personal library; the record found here is stored as it is, nothing is filled in. */
function AddToLibrary({ work }: { work: ScholarlyWork }) {
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const add = async () => {
    setState('busy');
    try {
      const res = await runtime().library.add({ source: 'work', workId: work.id });
      if (res.job) upsertLibraryJob(res.job);
      invalidateLibrary();
      setState('added');
      toast.success(res.created ? 'Added to your library' : 'Already in your library', {
        description: res.created ? (res.job ? 'Downloading the open-access PDF in the background.' : undefined) : (res.duplicateReason ?? undefined),
      });
    } catch (err) {
      setState('idle');
      toast.error('Could not add the paper', { description: errorMessage(err) });
    }
  };
  return (
    <Button size="sm" onClick={() => void add()} disabled={state !== 'idle'} data-testid="add-to-library">
      {state === 'busy' ? <Spinner /> : state === 'added' ? <Check /> : <BookMarked />}
      {state === 'added' ? 'In your library' : 'Add to library'}
    </Button>
  );
}

export function WorkDetails({
  work,
  onBack,
  backLabel,
  onAuthor,
  onOpenWork,
}: {
  work: ScholarlyWork;
  onBack: (() => void) | null;
  backLabel: string;
  onAuthor: (id: string) => void;
  onOpenWork: (w: ScholarlyWork) => void;
}) {
  const bibtex = useMemo(() => toBibTeX(work), [work]);
  const citation = useMemo(() => formatCitation(work), [work]);
  const ids = work.identifiers;
  const bib = bibliographicLine(work);
  const cites = work.citation;
  const pdf = safeExternalUrl(work.openAccess.pdfUrl ?? work.urls.pdf);
  // Crossref's landing page is often just the DOI resolver, already linked above.
  const landing = work.urls.landingPage && !/^https?:\/\/(dx\.)?doi\.org\//i.test(work.urls.landingPage) ? work.urls.landingPage : null;

  return (
    <article aria-labelledby="lit-work-title" className="px-5 pb-10 pt-4" data-testid="work-details">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={onBack}>
          <ArrowLeft /> {backLabel}
        </Button>
      ) : null}
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {[work.publicationType ? TYPE_LABEL[work.publicationType] : null, work.publicationDate ?? work.publicationYear].filter(Boolean).join(' · ')}
      </p>
      <h2 id="lit-work-title" className="mt-1 font-display text-[22px] leading-[1.25] text-ink">
        {work.title}
      </h2>
      <div className="mt-2">
        <Authors authors={work.authors} onAuthor={onAuthor} />
      </div>
      {work.venue || work.publisher ? (
        <p className="mt-1.5 text-ui text-ink-muted">
          {work.venue ? <i className="font-display text-[14px] text-ink">{work.venue}</i> : null}
          {bib ? ` ${bib}` : ''}
          {work.publisher && work.publisher !== work.venue ? <span className="text-ink-muted"> · {work.publisher}</span> : null}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void copyText(bibtex, 'BibTeX')}>
          <Copy /> Copy BibTeX
        </Button>
        <Button size="sm" onClick={() => void copyText(citation, 'Citation')}>
          <Copy /> Copy citation
        </Button>
        <Button size="sm" onClick={() => downloadBib(work, bibtex)}>
          <Download /> Download .bib
        </Button>
        <AddToLibrary key={work.id} work={work} />
        {pdf ? (
          <a
            href={pdf}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-6 items-center gap-1.5 rounded-ctl border border-rule bg-raised px-2 text-xs font-medium text-ink hover:border-rule-strong [&_svg]:size-[14px]"
          >
            <FileText aria-hidden /> PDF<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
        {ids.doi ? (
          <>
            <dt className="text-ink-muted">DOI</dt>
            <dd className="break-all font-mono">
              <ExternalLink href={`https://doi.org/${ids.doi}`}>{ids.doi}</ExternalLink>
            </dd>
          </>
        ) : null}
        {ids.arxivId ? (
          <>
            <dt className="text-ink-muted">arXiv</dt>
            <dd className="font-mono">
              <ExternalLink href={`https://arxiv.org/abs/${ids.arxivId}`}>{ids.arxivId}</ExternalLink>
            </dd>
          </>
        ) : null}
        {ids.pmid ? (
          <>
            <dt className="text-ink-muted">PubMed</dt>
            <dd className="font-mono">
              <ExternalLink href={`https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`}>{ids.pmid}</ExternalLink>
            </dd>
          </>
        ) : null}
        {landing ? (
          <>
            <dt className="text-ink-muted">Publisher page</dt>
            <dd className="min-w-0 truncate">
              <ExternalLink href={landing}>{landing.replace(/^https?:\/\//, '')}</ExternalLink>
            </dd>
          </>
        ) : null}
        <dt className="text-ink-muted">Citations</dt>
        <dd className="text-ink">
          {cites.citedByCount !== null && cites.citedBySource ? (
            <>
              <span className="tabular-nums">{formatCount(cites.citedByCount)}</span> <span className="text-ink-muted">according to {providerName(cites.citedBySource)}</span>
              {cites.observations.length > 1 ? (
                <span className="block text-2xs text-ink-muted">
                  {cites.observations
                    .filter((o) => o.provider !== cites.citedBySource && o.citedByCount !== null)
                    .map((o) => `${providerName(o.provider)} ${formatCount(o.citedByCount!)}`)
                    .join(' · ')}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-ink-muted">Not reported</span>
          )}
        </dd>
        <dt className="text-ink-muted">Access</dt>
        <dd className="text-ink">
          {work.openAccess.isOpenAccess === true ? (
            <Tag dot="success">Open access{work.openAccess.status ? ` · ${work.openAccess.status}` : ''}</Tag>
          ) : work.openAccess.isOpenAccess === false ? (
            'Not open access'
          ) : (
            <span className="text-ink-muted">Not reported</span>
          )}
          {work.openAccess.license ? (
            <span className="block text-2xs text-ink-muted">
              {safeExternalUrl(work.openAccess.license) ? <ExternalLink href={work.openAccess.license}>Licence</ExternalLink> : `Licence: ${work.openAccess.license}`}
            </span>
          ) : null}
        </dd>
        {work.categories.length ? (
          <>
            <dt className="text-ink-muted">Subjects</dt>
            <dd className="flex flex-wrap gap-1">
              {work.categories.slice(0, 8).map((c) => (
                <Tag key={`${c.scheme}:${c.value}`} title={c.scheme}>
                  {c.value}
                </Tag>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      <section aria-labelledby="lit-abstract" className="mt-6">
        <SectionHeading id="lit-abstract">Abstract</SectionHeading>
        {work.abstract ? (
          <>
            <p className="mt-2 whitespace-pre-line font-display text-[14.5px] leading-[1.6] text-ink">{work.abstract}</p>
            {work.abstractSource ? <p className="mt-1.5 text-2xs text-ink-muted">Abstract from {providerName(work.abstractSource)}.</p> : null}
          </>
        ) : (
          <p className="mt-2 text-ui text-ink-muted">No source supplied an abstract.</p>
        )}
      </section>

      {work.conflicts.length ? (
        <section aria-labelledby="lit-conflicts" className="mt-6">
          <SectionHeading id="lit-conflicts">Where sources disagree</SectionHeading>
          <ul className="mt-2 space-y-2.5">
            {work.conflicts.map((c) => (
              <li key={c.field} className="border-l-2 border-warning pl-3">
                <p className="text-xs font-medium text-ink">{FIELD_LABEL[c.field] ?? c.field}</p>
                <ul className="mt-0.5 space-y-0.5">
                  {c.values.map((v) => (
                    <li key={v.provider} className="flex gap-2 text-xs">
                      <span className="w-28 shrink-0 text-ink-muted">{providerName(v.provider)}</span>
                      <span className={cn('min-w-0 break-words', v.provider === c.chosen ? 'text-ink' : 'text-ink-muted')}>
                        {conflictValue(c.field, v.value)}
                        {v.provider === c.chosen ? <span className="ml-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">shown</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="lit-sources" className="mt-6">
        <SectionHeading id="lit-sources">Sources</SectionHeading>
        <ul className="mt-2 divide-y divide-rule border-y border-rule">
          {work.sourceRecords.map((r) => (
            <li key={`${r.provider}:${r.providerId}`} className="flex items-start gap-2.5 py-2 text-xs" data-source={r.provider}>
              <Notches providers={[r.provider]} label={null} className="mt-[3px] scale-75" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-ink">{providerName(r.provider)}</span>
                  <span className="truncate font-mono text-2xs text-ink-muted">{r.providerId}</span>
                </p>
                <p className="text-2xs text-ink-muted">
                  Retrieved {formatDateTime(r.retrievedAt)}
                  {r.citedByCount !== null ? ` · ${formatCount(r.citedByCount)} citations` : ''}
                  {r.rawType ? ` · type “${r.rawType}”` : ''}
                </p>
              </div>
              <ExternalLink href={r.recordUrl} className="shrink-0 text-2xs">
                View record
              </ExternalLink>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-2xs text-ink-muted">
          <Notches providers={providersOf(work)} label={null} className="mr-1.5 inline-flex scale-75 align-middle" />
          Values come from the sources above; a missing value means no source reported it.
        </p>
      </section>

      <RelatedWorks key={work.id} work={work} onOpen={onOpenWork} />

      <details className="mt-6 group">
        <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted hover:text-ink">BibTeX</summary>
        <pre className="mt-2 overflow-x-auto rounded-ctl border border-rule bg-sunken p-3 font-mono text-2xs leading-relaxed text-ink" data-testid="bibtex">
          {bibtex}
        </pre>
      </details>
    </article>
  );
}

export function AuthorProfile({ authorId, onBack, backLabel, onOpenWork }: { authorId: string; onBack: () => void; backLabel: string; onOpenWork: (w: ScholarlyWork) => void }) {
  const { data: author, isLoading, error } = useAuthorProfile(authorId);
  return (
    <article aria-label="Author" className="px-5 pb-10 pt-4" data-testid="author-profile">
      <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={onBack}>
        <ArrowLeft /> {backLabel}
      </Button>
      {isLoading ? (
        <Spinner className="text-ink-muted" />
      ) : error ? (
        <p role="alert" className="text-ui text-danger">
          {errorMessage(error)}
        </p>
      ) : author ? (
        <>
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Author · {providerName(author.provider)}</p>
          <h2 className="mt-1 font-display text-[22px] leading-tight text-ink">{author.name}</h2>
          {author.affiliations.length ? <p className="mt-1 text-ui text-ink-muted">{author.affiliations.slice(0, 3).join('; ')}</p> : null}
          <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-muted">Works</dt>
            <dd className="tabular-nums text-ink">{author.worksCount !== null ? formatCount(author.worksCount) : '—'}</dd>
            <dt className="text-ink-muted">Citations</dt>
            <dd className="tabular-nums text-ink">{author.citedByCount !== null ? formatCount(author.citedByCount) : '—'}</dd>
            <dt className="text-ink-muted">h-index</dt>
            <dd className="tabular-nums text-ink">{author.hIndex ?? '—'}</dd>
            {author.orcid ? (
              <>
                <dt className="text-ink-muted">ORCID</dt>
                <dd className="font-mono">
                  <ExternalLink href={`https://orcid.org/${author.orcid}`}>{author.orcid}</ExternalLink>
                </dd>
              </>
            ) : null}
          </dl>
          <p className="mt-1.5 text-2xs text-ink-muted">
            Counts as reported by {providerName(author.provider)} on {formatDateTime(author.retrievedAt)}. <ExternalLink href={author.recordUrl}>View profile</ExternalLink>
          </p>
          <section aria-labelledby="lit-author-works" className="mt-6">
            <SectionHeading id="lit-author-works">Recent works</SectionHeading>
            <ul className="mt-2 divide-y divide-rule border-y border-rule">
              {author.works.map((w) => (
                <li key={w.id}>
                  <button type="button" className="w-full py-2 text-left hover:bg-sunken/60" onClick={() => onOpenWork(w)}>
                    <span className="block font-display text-[14px] leading-snug text-ink">{w.title}</span>
                    <span className="block truncate text-2xs text-ink-muted">
                      {[w.publicationYear, w.venue].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </article>
  );
}
