import { BookOpenText, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { LibraryAttachment } from '@research-studio/shared-types';
import { Button, Spinner } from '@research-studio/ui';
import { runtime } from '../../lib/connection';
import { errorMessage, invalidateDocuments, useDocumentStatus } from '../../lib/queries';
import { SectionHeading, Tag } from '../literature/common';
import { FullTextDialog } from './FullTextDialog';
import { EXTRACTION_LABEL, EXTRACTION_TONE, isActiveDocumentJob, qualitySummary, STALE_LABEL } from './model';

async function act(what: string, fn: () => Promise<unknown>, attachmentId: string) {
  try {
    await fn();
    invalidateDocuments(attachmentId);
  } catch (err) {
    toast.error(`Could not ${what}`, { description: errorMessage(err) });
  }
}

function AttachmentText({ attachment, title, itemId, onSearchPaper }: { attachment: LibraryAttachment; title: string; itemId: string; onSearchPaper?: (() => void) | undefined }) {
  const { data, isLoading, error } = useDocumentStatus(attachment.id);
  const [open, setOpen] = useState(false);
  if (isLoading) return <Spinner className="text-ink-muted" />;
  if (error || !data) return <p className="text-xs text-danger">{error ? errorMessage(error) : 'Status unavailable'}</p>;
  const { extraction: x, job } = data;
  const running = isActiveDocumentJob(job);
  const failed = job?.status === 'failed' && (!x || job.createdAt > (x.processingCompletedAt ?? ''));

  return (
    <div className="rounded-md border border-rule p-3" data-testid={`document-panel-${attachment.id}`}>
      <p className="truncate text-xs text-ink-muted">{attachment.fileName}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {x ? <Tag dot={EXTRACTION_TONE[x.status]}>{EXTRACTION_LABEL[x.status]}</Tag> : <Tag>Not processed</Tag>}
        {x?.stale.length ? <Tag dot="warning" title={x.stale.map((s) => STALE_LABEL[s] ?? s).join(', ')}>Out of date</Tag> : null}
        {data.embeddings.embeddablePassages && x ? (
          <Tag>
            Semantic index {data.embeddings.indexedPassages}/{data.embeddings.embeddablePassages}
          </Tag>
        ) : null}
      </div>
      {running && job ? (
        <div className="mt-2" role="status" aria-live="polite">
          <p className="text-xs text-ink">
            {job.stageLabel}… {Math.round(job.progress * 100)}%
          </p>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {job.error?.message ?? 'Processing failed'}
          {job.error?.retryable ? ' (this may work if you try again later)' : ''}
        </p>
      ) : null}
      {x?.status === 'needs_ocr' ? <p className="mt-2 text-xs text-ink">The pages are images without text. Run OCR on the PDF (for example with OCRmyPDF), then attach the result.</p> : null}
      {x && x.status !== 'needs_ocr' ? <p className="mt-2 text-2xs leading-relaxed text-ink-muted">{qualitySummary(x).join(' · ')}</p> : null}
      {job && !running && job.notes.length ? (
        <details className="mt-1.5 text-2xs text-ink-muted">
          <summary className="cursor-pointer">Processing notes</summary>
          <ul className="mt-1 list-disc pl-4">
            {job.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {x && x.status !== 'needs_ocr' ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <BookOpenText /> Full text
          </Button>
        ) : null}
        {x && x.status !== 'needs_ocr' && onSearchPaper ? (
          <Button size="sm" variant="ghost" onClick={onSearchPaper}>
            Search in this paper
          </Button>
        ) : null}
        {running ? (
          <Button size="sm" variant="ghost" onClick={() => void act('cancel processing', () => runtime().documents.cancel(attachment.id), attachment.id)}>
            <X /> Cancel
          </Button>
        ) : x ? (
          <Button size="sm" variant="ghost" onClick={() => void act('reprocess the PDF', () => runtime().documents.reprocess(attachment.id), attachment.id)}>
            <RefreshCw /> Reprocess
          </Button>
        ) : (
          <Button size="sm" variant={failed ? 'secondary' : 'primary'} onClick={() => void act('process the PDF', () => runtime().documents.process(attachment.id), attachment.id)} disabled={!attachment.available}>
            <BookOpenText /> {failed ? 'Try again' : 'Extract full text'}
          </Button>
        )}
      </div>
      {open && x ? <FullTextDialog attachmentId={attachment.id} itemId={itemId} title={title} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** Full-text status for each PDF of a paper (paper details). */
export function DocumentPanel({ itemId, title, attachments, onSearchPaper }: { itemId: string; title: string; attachments: LibraryAttachment[]; onSearchPaper?: () => void }) {
  const pdfs = attachments.filter((a) => a.attachmentType === 'pdf');
  if (!pdfs.length) return null;
  return (
    <section aria-labelledby="lib-fulltext" className="mt-5">
      <SectionHeading id="lib-fulltext">Full text</SectionHeading>
      <p className="mt-0.5 text-2xs text-ink-muted">Structure, passages and search index, extracted on this computer.</p>
      <div className="mt-2 flex flex-col gap-2">
        {pdfs.map((a) => (
          <AttachmentText key={a.id} attachment={a} itemId={itemId} title={title} onSearchPaper={onSearchPaper} />
        ))}
      </div>
    </section>
  );
}
