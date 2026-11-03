import type { DocumentJobStatus, NormalizedDocument, PassageDraft } from '@research-studio/document-intelligence';
import { ExtractionCancelledError, ExtractionError } from '../errors/extraction-errors';
import type { GrobidClient } from '../extractors/grobid/grobid-client';
import { normalizeTei } from '../extractors/grobid/tei-normalizer';
import { parseTei } from '../extractors/grobid/tei-parser';
import type { PyMuPdfClient, PyMuPdfOutput } from '../extractors/pymupdf/pymupdf-client';
import { normalizeLayout, pageGeometry, pageTexts, textLayerKind } from '../extractors/pymupdf/pymupdf-normalizer';
import { extractionStatus, finalizeDocument, hasUsableBody } from '../normalization/document-normalizer';
import { checkPageCount, checkPdfBytes } from '../security/pdf-validation';
import type { ProcessingLimits } from '../security/processing-limits';
import type { AttachmentInfo, DocumentStore, JobRow } from '../storage/document-store';

export interface EmbedOutcome {
  status: 'done' | 'skipped' | 'failed';
  message?: string;
}

export interface IngestionDeps {
  store: DocumentStore;
  limits: ProcessingLimits;
  /** Reads the attachment's bytes from the library's content-addressed store. */
  readPdf(attachment: AttachmentInfo, signal: AbortSignal): Promise<Uint8Array>;
  grobid: GrobidClient | null;
  pymupdf: PyMuPdfClient | null;
  /** Passage segmentation (research-retrieval). */
  segment(doc: NormalizedDocument, sourceSha256: string): PassageDraft[];
  /** Write the extraction's passages to the keyword index. */
  indexKeywords(extractionId: string): void;
  /** Embeddings and vectors for the extraction's passages (optional). */
  embed?(extractionId: string, signal: AbortSignal, progress: (stage: 'generating_embeddings' | 'indexing_vectors', fraction: number) => void): Promise<EmbedOutcome>;
  /** The configuration of this run, recorded with the extraction. */
  configuration(): { config: Record<string, unknown>; configHash: string };
  onUpdate?(job: JobRow): void;
}

export interface IngestionResult {
  status: Extract<DocumentJobStatus, 'completed' | 'partial' | 'needs_ocr'>;
  extractionId: string | null;
  notes: string[];
  embeddingError: string | null;
}

/**
 * Runs one document through the stages. GROBID gives the structure; PyMuPDF
 * gives page geometry and checks; PyMuPDF text is the fallback. A new
 * extraction is written inactive and becomes active only after it has been
 * indexed; until then (and if anything fails) the previous one stays.
 */
export class IngestionService {
  constructor(private readonly deps: IngestionDeps) {}

  private stage(job: JobRow, status: DocumentJobStatus, progress: number | null = null): JobRow {
    const next = this.deps.store.updateJob(job.id, { status, progress });
    this.deps.onUpdate?.(next);
    this.runUpdate?.(next);
    return next;
  }

  private runUpdate: ((job: JobRow) => void) | undefined;

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new ExtractionCancelledError();
  }

  async run(initial: JobRow, signal: AbortSignal, onUpdate?: (job: JobRow) => void): Promise<IngestionResult> {
    // One service may run several jobs at once; each run publishes through its own callback.
    const service = Object.create(this) as IngestionService;
    service.runUpdate = onUpdate;
    return service.execute(initial, signal);
  }

  private async execute(initial: JobRow, signal: AbortSignal): Promise<IngestionResult> {
    const { store, limits } = this.deps;
    const notes: string[] = [];
    let job = this.stage(initial, 'validating');
    const attachment = store.attachmentInfo(job.attachmentId);
    if (!attachment) throw new ExtractionError('missing-file', 'The attachment no longer exists', 'library');
    if (attachment.attachmentType !== 'pdf') throw new ExtractionError('unsupported', 'Only PDF attachments are processed', 'library');
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.readPdf(attachment, signal);
    } catch (err) {
      this.check(signal);
      throw new ExtractionError('missing-file', `The PDF could not be read from the library store${err instanceof Error ? ` (${err.message})` : ''}`, 'library', false);
    }
    checkPdfBytes(bytes, limits);
    this.check(signal);

    let py: PyMuPdfOutput | null = null;
    const pyStatus = this.deps.pymupdf ? await this.deps.pymupdf.status() : null;
    if (this.deps.pymupdf && pyStatus?.status === 'available') {
      try {
        py = await this.deps.pymupdf.extract(bytes, signal);
        checkPageCount(py.pageCount ?? py.pages.length, limits);
      } catch (err) {
        this.check(signal);
        if (err instanceof ExtractionError && (err.code === 'malformed' || err.code === 'unsupported' || err.code === 'too-many-pages')) throw err;
        notes.push(`PyMuPDF: ${err instanceof Error ? err.message : String(err)}`);
        py = null;
      }
    } else if (pyStatus) {
      notes.push(`PyMuPDF: ${pyStatus.message ?? 'not available'}`);
    }
    const layer = py ? textLayerKind(py) : null;

    job = this.stage(job, 'extracting');
    let tei: string | null = null;
    let grobidVersion: string | null = null;
    let grobidError: ExtractionError | null = null;
    if (this.deps.grobid) {
      try {
        const r = await this.deps.grobid.processFulltext(bytes, signal);
        tei = r.tei;
        grobidVersion = r.version;
        if (r.attempts > 1) notes.push(`GROBID needed ${r.attempts} attempts.`);
      } catch (err) {
        this.check(signal);
        grobidError = err instanceof ExtractionError ? err : new ExtractionError('extractor-error', String(err), 'grobid');
        notes.push(`GROBID: ${grobidError.message}`);
      }
    }
    this.check(signal);

    job = this.stage(job, 'normalizing');
    let doc: NormalizedDocument | null = null;
    let raw: { format: 'tei-xml' | 'pymupdf-json'; content: string } | null = null;
    if (tei) {
      try {
        const parsed = parseTei(tei, { maxBytes: limits.maxOutputBytes, maxDepth: limits.maxXmlDepth, maxNodes: limits.maxXmlNodes });
        doc = normalizeTei(parsed, { pages: py ? pageGeometry(py) : [], extractorVersion: grobidVersion, limits });
        raw = { format: 'tei-xml', content: tei };
      } catch (err) {
        grobidError = err instanceof ExtractionError ? err : new ExtractionError('invalid-output', String(err), 'grobid');
        notes.push(`GROBID output: ${grobidError.message}`);
      }
    }
    if (doc && !hasUsableBody(doc) && py && layer === 'text') {
      notes.push('GROBID found no usable body text; the page layout (PyMuPDF) was used instead.');
      doc = null;
    }
    if (!doc) {
      if (py && layer === 'image-only') return this.needsOcr(attachment, py, notes, grobidError);
      if (py && layer === 'empty') throw new ExtractionError('empty', 'The PDF has no text layer and no images: there is nothing to extract', 'pymupdf');
      if (py) {
        doc = normalizeLayout(py, limits);
        raw = { format: 'pymupdf-json', content: JSON.stringify(py) };
        if (grobidError) notes.push('Fell back to PyMuPDF text extraction.');
      } else if (grobidError) {
        throw grobidError;
      } else {
        throw new ExtractionError('unavailable', 'No extractor is available: start a local GROBID service or install PyMuPDF for the configured Python', null, false);
      }
    }
    doc = finalizeDocument(doc, py ? pageTexts(py) : null);
    if (!doc.blocks.some((b) => b.plainText.trim())) throw new ExtractionError('empty', 'No text could be extracted from this PDF', doc.extractor);
    const status = extractionStatus(doc);
    this.check(signal);

    job = this.stage(job, 'segmenting');
    const passages = this.deps.segment(doc, attachment.sha256);
    const { config, configHash } = this.deps.configuration();
    const extractionId = store.saveExtraction({ attachment, document: doc, passages, status, config, configHash, raw, startedAt: job.startedAt ?? new Date().toISOString() });
    store.updateJob(job.id, { extractionId });
    try {
      this.check(signal);
      job = this.stage(job, 'indexing_keywords');
      this.deps.indexKeywords(extractionId);
      this.check(signal);
      store.activate(extractionId);
    } catch (err) {
      store.deleteExtraction(extractionId);
      throw err;
    }

    let embeddingError: string | null = null;
    if (this.deps.embed) {
      job = this.stage(job, 'generating_embeddings');
      const outcome = await this.deps.embed(extractionId, signal, (stage, fraction) => {
        job = this.stage(job, stage, fraction);
      });
      if (outcome.status === 'failed') {
        embeddingError = outcome.message ?? 'Embeddings could not be computed';
        notes.push(`Embeddings: ${embeddingError}. Keyword search works; run a reindex to retry semantic search.`);
      } else if (outcome.status === 'skipped' && outcome.message) {
        notes.push(outcome.message);
      }
    }
    return { status: embeddingError ? 'partial' : status, extractionId, notes, embeddingError };
  }

  /**
   * A scan without a text layer. The attempt is recorded as an extraction with
   * status `needs_ocr` (no passages) unless a usable extraction already exists,
   * which is kept.
   */
  private needsOcr(attachment: AttachmentInfo, py: PyMuPdfOutput, notes: string[], grobidError: ExtractionError | null): IngestionResult {
    notes.push('The pages are images without a text layer. Run OCR on the PDF (for example with OCRmyPDF) and attach the result to process it.');
    if (grobidError) notes.push(`GROBID: ${grobidError.message}`);
    const existing = this.deps.store.activeExtraction(attachment.attachmentId);
    if (existing && existing.status !== 'needs_ocr') return { status: 'needs_ocr', extractionId: existing.id, notes, embeddingError: null };
    const doc = finalizeDocument(
      {
        extractor: 'pymupdf',
        extractorVersion: py.version,
        metadata: { title: null, authors: [], abstract: null, publicationDate: null, doi: null, arxivId: null, keywords: [], venue: null, language: null },
        pages: pageGeometry(py),
        sections: [],
        blocks: [],
        elements: [],
        references: [],
        quality: { textCoverage: null, hasTitle: false, hasAbstract: false, sectionCount: 0, paragraphCount: 0, referenceCount: 0, coordinateCoverage: 0, emptyPages: [], structure: 'layout' },
        warnings: ['Image-only PDF: OCR is needed before its text can be extracted.'],
      },
      pageTexts(py),
    );
    const { config, configHash } = this.deps.configuration();
    const extractionId = this.deps.store.saveExtraction({ attachment, document: doc, passages: [], status: 'needs_ocr', config, configHash, raw: null, startedAt: new Date().toISOString() });
    this.deps.store.activate(extractionId);
    return { status: 'needs_ocr', extractionId, notes, embeddingError: null };
  }
}
