import { FileText, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { DocumentBlock, DocumentElement, DocumentSection, DocumentStructure } from '@research-studio/api-contracts';
import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateDocuments, useDocumentStructure } from '../../lib/queries';
import { SectionHeading, Tag } from '../literature/common';
import { PdfViewer } from '../library/PdfViewer';
import { EXTRACTION_LABEL, EXTRACTION_TONE, qualitySummary, shortHash, STALE_LABEL } from './model';

type Jump = { page: number; highlights: DocumentCoordinate[] };

function PageButton({ page, coords, onJump, label }: { page: number | null; coords: DocumentCoordinate[]; onJump: (j: Jump) => void; label?: string }) {
  if (!page) return <span className="text-2xs text-ink-muted">page unknown</span>;
  // The visible text starts the accessible name; the rest says what happens.
  return (
    <button type="button" className="text-2xs text-accent underline-offset-2 hover:underline" onClick={() => onJump({ page, highlights: coords })}>
      p. {page}
      <span className="sr-only">{label ? `, open ${label} in the PDF` : ', open the PDF at this page'}</span>
    </button>
  );
}

function BlockText({ block }: { block: DocumentBlock }) {
  return (
    <>
      {block.spans.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === 'formula' ? (
          <code key={i} className="rounded bg-sunken px-1 font-mono text-[0.92em]">
            {s.text}
          </code>
        ) : (
          <span key={i} className={cn('text-accent', s.refType === 'bibr' && 'whitespace-nowrap')} title={s.refType === 'bibr' ? 'Citation marker' : `Reference to a ${s.refType}`}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}

function ElementView({ element, onJump }: { element: DocumentElement; onJump: (j: Jump) => void }) {
  const rows = element.type === 'table' && element.content ? element.content.split('\n').map((r) => r.split('\t')) : null;
  return (
    <figure className="my-3 rounded-md border border-rule bg-panel p-3" id={`el-${element.id}`}>
      <figcaption className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-semibold text-ink">
          {element.type === 'equation' ? 'Equation' : element.type === 'table' ? 'Table' : 'Figure'} {element.label ?? ''}
        </span>
        <PageButton page={element.pageStart} coords={element.coordinates} onJump={onJump} />
      </figcaption>
      {element.caption ? <p className="mt-1 text-ui text-ink">{element.caption}</p> : null}
      {element.type === 'equation' ? (
        <>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-sunken p-2 font-mono text-xs text-ink">{element.content || '(no text extracted)'}</pre>
          <p className="mt-1 text-2xs text-ink-muted">Characters as extracted from the PDF. This is not a faithful rendering of the equation; check the PDF.</p>
        </>
      ) : rows ? (
        <div className="mt-1.5 overflow-x-auto">
          <table className="text-xs">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  {r.map((c, j) => (
                    <td key={j} className="px-2 py-0.5 text-ink">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-2xs text-ink-muted">Cell text as extracted; layout and merged cells are not reproduced.</p>
        </div>
      ) : null}
    </figure>
  );
}

function Contents({ structure, onJump }: { structure: DocumentStructure; onJump: (j: Jump) => void }) {
  const elements = new Map(structure.elements.map((e) => [e.id, e]));
  const bySection = useMemo(() => {
    const m = new Map<string | null, DocumentBlock[]>();
    for (const b of structure.blocks) m.set(b.sectionId, [...(m.get(b.sectionId) ?? []), b]);
    return m;
  }, [structure.blocks]);
  const renderBlock = (b: DocumentBlock) => {
    if (b.type === 'heading' || b.type === 'title' || b.type === 'reference') return null;
    if (b.type === 'display_formula' || b.type === 'figure_caption' || b.type === 'table_caption') {
      const el = b.elementId ? elements.get(b.elementId) : null;
      return el ? <ElementView key={b.id} element={el} onJump={onJump} /> : null;
    }
    return (
      <div key={b.id} className={cn('group my-2', b.type === 'footnote' && 'border-l-2 border-rule pl-2 text-xs')}>
        <p className={cn('leading-relaxed text-ink', b.type === 'list' && 'whitespace-pre-line')}>
          <BlockText block={b} />
        </p>
        <div className="mt-0.5 flex gap-2">
          <PageButton page={b.pageStart} coords={b.coordinates} onJump={onJump} label="this paragraph" />
          {b.type === 'footnote' ? <span className="text-2xs text-ink-muted">footnote</span> : null}
        </div>
      </div>
    );
  };
  const references = structure.references;
  const sectionView = (s: DocumentSection) => (
    <section key={s.id} id={`sec-${s.id}`} aria-labelledby={`h-${s.id}`} className="mt-5 scroll-mt-4">
      <div className="flex items-baseline gap-2">
        <h3 id={`h-${s.id}`} className={cn('font-display text-ink', s.level === 1 ? 'text-[18px]' : 'text-[16px]')}>
          {s.headingNumber ? `${s.headingNumber} ` : ''}
          {s.heading}
        </h3>
        <PageButton page={s.pageStart} coords={s.coordinates} onJump={onJump} label={`"${s.heading}"`} />
      </div>
      {s.type === 'references' ? (
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-xs text-ink">
          {references.map((r) => (
            <li key={r.id}>
              {r.raw ?? [r.parsed.authors.join(', '), r.parsed.title, r.parsed.venue, r.parsed.year].filter(Boolean).join('. ')}
              <span className="ml-2 inline-flex gap-2">
                {r.doi ? <span className="font-mono text-2xs text-ink-muted">doi:{r.doi}</span> : null}
                {r.arxivId ? <span className="font-mono text-2xs text-ink-muted">arXiv:{r.arxivId}</span> : null}
                {r.linkedLibraryItemId ? <Tag dot="success">In your library (same identifier)</Tag> : null}
                <PageButton page={r.pageStart} coords={r.coordinates} onJump={onJump} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        (bySection.get(s.id) ?? []).map(renderBlock)
      )}
    </section>
  );
  const unsectioned = (bySection.get(null) ?? []).filter((b) => b.type !== 'title');
  return (
    <div className="max-w-[72ch] text-ui">
      {structure.sections.map(sectionView)}
      {unsectioned.length ? (
        <section className="mt-5" aria-label="Text outside any section">
          <h3 className="font-display text-[16px] text-ink-muted">Outside any section</h3>
          {unsectioned.map(renderBlock)}
        </section>
      ) : null}
    </div>
  );
}

/** The extracted full text of one PDF: structure, quality and source pages. */
export function FullTextDialog({ attachmentId, itemId, title, onClose }: { attachmentId: string; itemId: string; title: string; onClose: () => void }) {
  const { data, error, isLoading } = useDocumentStructure(attachmentId);
  const [jump, setJump] = useState<Jump | null>(null);
  const reprocess = async () => {
    try {
      await runtime().documents.reprocess(attachmentId);
      invalidateDocuments(attachmentId);
      toast.info('Reprocessing; the current text stays until the new extraction is ready.');
    } catch (err) {
      toast.error('Could not reprocess', { description: errorMessage(err) });
    }
  };
  const x = data?.extraction;
  const counts = data ? { figures: data.elements.filter((e) => e.type === 'figure').length, tables: data.elements.filter((e) => e.type === 'table').length, equations: data.elements.filter((e) => e.type === 'equation').length } : null;
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="top-[3vh] flex h-[94vh] w-[min(1200px,calc(100vw-24px))] flex-col p-0" aria-describedby="fulltext-desc" data-testid="full-text">
          <div className="border-b border-rule px-5 py-3 pr-12">
            <DialogTitle className="truncate text-[17px]">{x?.metadata.title ?? title}</DialogTitle>
            <DialogDescription id="fulltext-desc" className="mt-0.5 text-xs text-ink-muted">
              Text and structure extracted from the PDF on this computer. Extraction can miss or misread parts; the PDF is the source.
            </DialogDescription>
            {x ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Tag dot={EXTRACTION_TONE[x.status]}>{EXTRACTION_LABEL[x.status]}</Tag>
                {x.stale.length ? <Tag dot="warning">Out of date: {x.stale.map((s) => STALE_LABEL[s] ?? s).join(', ')}</Tag> : null}
                <span className="text-2xs text-ink-muted">{qualitySummary(x).join(' · ')}</span>
                <span className="text-2xs text-ink-muted" title={x.sourceSha256}>
                  PDF {shortHash(x.sourceSha256)}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void reprocess()}>
                  <RefreshCw /> Reprocess
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setJump({ page: 1, highlights: [] })}>
                  <FileText /> Open PDF
                </Button>
              </div>
            ) : null}
            {x?.warnings.length ? (
              <ul className="mt-1.5 list-disc pl-4 text-2xs text-ink marker:text-warning" aria-label="Extraction warnings">
                {x.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex min-h-0 flex-1">
            {isLoading ? (
              <Spinner className="m-6 text-ink-muted" />
            ) : error || !data ? (
              <p role="alert" className="p-6 text-ui text-danger">
                {error ? errorMessage(error) : 'No extraction'}
              </p>
            ) : (
              <>
                <nav aria-label="Table of contents" className="hidden w-[260px] shrink-0 overflow-y-auto border-r border-rule p-3 md:block">
                  <SectionHeading>Contents</SectionHeading>
                  <ul className="mt-1.5 flex flex-col gap-0.5 text-xs">
                    {data.sections.map((s) => (
                      <li key={s.id} style={{ paddingLeft: (s.level - 1) * 12 }}>
                        <a href={`#sec-${s.id}`} className="block truncate rounded px-1 py-0.5 text-ink hover:bg-sunken" onClick={(e) => {
                          e.preventDefault();
                          document.getElementById(`sec-${s.id}`)?.scrollIntoView({ block: 'start' });
                        }}>
                          {s.headingNumber ? `${s.headingNumber} ` : ''}
                          {s.heading}
                        </a>
                      </li>
                    ))}
                  </ul>
                  {counts ? (
                    <p className="mt-3 text-2xs text-ink-muted">
                      {counts.figures} figures · {counts.tables} tables · {counts.equations} equations · {data.references.length} references
                    </p>
                  ) : null}
                </nav>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
                  {!data.sections.length ? <p className="mt-6 text-ui text-ink-muted">No sections were recognised in this PDF.</p> : null}
                  <Contents structure={data} onJump={setJump} />
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {jump ? (
        <PdfViewer
          itemId={itemId}
          attachmentId={attachmentId}
          title={title}
          initialPage={jump.page}
          highlights={jump.highlights}
          onClose={() => setJump(null)}
          headerActions={
            <Button size="sm" variant="ghost" onClick={() => setJump(null)}>
              Back to the text
            </Button>
          }
        />
      ) : null}
    </>
  );
}
