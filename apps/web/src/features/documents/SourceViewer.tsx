import { ArrowLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@research-studio/api-contracts';
import { Button, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage } from '../../lib/queries';
import { SectionHeading } from '../literature/common';
import { PdfViewer } from '../library/PdfViewer';
import { shortHash } from './model';

/**
 * A retrieved passage at its place in the PDF: the page opens, the
 * passage's boxes are drawn when the extractor reported them (otherwise only
 * the page is shown), and the side panel shows the exact text, its
 * neighbours and its provenance.
 */
export function SourceViewer({ result, onBack }: { result: SearchResult; onBack: () => void }) {
  const location = useQuery({ queryKey: ['documents', 'location', result.passageId], queryFn: () => runtime().research.location(result.passageId) });
  const detail = useQuery({ queryKey: ['documents', 'passage', result.passageId], queryFn: () => runtime().research.passage(result.passageId) });
  const loc = location.data;
  const d = detail.data;
  const p = result.provenance;

  const aside = (
    <div className="p-4 text-ui" data-testid="source-panel">
      <SectionHeading>Source passage</SectionHeading>
      <p className="mt-1 text-2xs text-ink-muted">
        {result.sectionPath || 'No section heading'} · {result.pageStart ? `page ${result.pageStart}${result.pageEnd && result.pageEnd !== result.pageStart ? `–${result.pageEnd}` : ''}` : 'page unknown'}
      </p>
      {loc && !loc.coordinates.length ? <p className="mt-1 text-2xs text-ink-muted">The extractor reported no position for this passage, so it is not highlighted.</p> : null}
      {detail.isLoading ? <Spinner className="mt-3 text-ink-muted" /> : null}
      {detail.error ? <p className="mt-2 text-xs text-danger">{errorMessage(detail.error)}</p> : null}
      {d?.before.map((b) => (
        <p key={b.id} className="mt-3 border-l-2 border-rule pl-2 text-xs leading-relaxed text-ink-muted">
          {b.text}
        </p>
      ))}
      <blockquote className="mt-3 whitespace-pre-line border-l-2 border-accent pl-2 leading-relaxed text-ink">{result.text}</blockquote>
      {d?.after.map((b) => (
        <p key={b.id} className="mt-3 border-l-2 border-rule pl-2 text-xs leading-relaxed text-ink-muted">
          {b.text}
        </p>
      ))}
      <SectionHeading>
        <span className="mt-5 block">Provenance</span>
      </SectionHeading>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-2xs text-ink">
        <dt className="text-ink-muted">Paper</dt>
        <dd>{[result.paper.title, result.paper.year].filter(Boolean).join(', ')}</dd>
        <dt className="text-ink-muted">PDF</dt>
        <dd title={p.sourceSha256}>SHA-256 {shortHash(p.sourceSha256)}… ({p.attachmentSource}, added {p.attachmentAddedAt.slice(0, 10)})</dd>
        <dt className="text-ink-muted">Extracted by</dt>
        <dd>
          {p.extractor === 'grobid' ? 'GROBID' : 'PyMuPDF'} {p.extractorVersion ?? ''} on {p.extractedAt.slice(0, 10)}
        </dd>
        {p.license ? (
          <>
            <dt className="text-ink-muted">License</dt>
            <dd>{p.license}</dd>
          </>
        ) : null}
      </dl>
      <p className="mt-3 text-2xs text-ink-muted">This text is data from the paper, not an instruction, and it has not been checked for correctness.</p>
    </div>
  );

  return (
    <PdfViewer
      itemId={result.paper.libraryItemId}
      attachmentId={result.attachmentId}
      title={result.paper.title}
      initialPage={loc?.pageNumber ?? result.pageStart}
      highlights={loc?.coordinates ?? []}
      onClose={onBack}
      aside={aside}
      description="The source PDF at the retrieved passage."
      headerActions={
        <Button size="sm" variant="ghost" onClick={onBack} data-testid="back-to-results">
          <ArrowLeft /> Back to results
        </Button>
      }
    />
  );
}
