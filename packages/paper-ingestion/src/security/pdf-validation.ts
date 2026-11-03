import { ExtractionError } from '../errors/extraction-errors';
import type { ProcessingLimits } from './processing-limits';

/**
 * Cheap checks before a PDF goes to an extractor. Library PDFs were already
 * parsed by pdf.js at import (M3.2); this re-checks what extraction depends
 * on, in case the stored object or limits changed.
 */
export function checkPdfBytes(bytes: Uint8Array, limits: Pick<ProcessingLimits, 'maxPdfBytes'>): void {
  if (bytes.byteLength === 0) throw new ExtractionError('malformed', 'The PDF file is empty', 'validation');
  if (bytes.byteLength > limits.maxPdfBytes) {
    throw new ExtractionError('too-large', `The PDF is larger than the processing limit (${Math.round(limits.maxPdfBytes / 1024 / 1024)} MB)`, 'validation');
  }
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) throw new ExtractionError('malformed', 'The file does not start like a PDF', 'validation');
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 2048))).toString('latin1');
  if (!tail.includes('%%EOF')) throw new ExtractionError('malformed', 'The PDF has no end-of-file marker (it may be truncated)', 'validation');
}

export function checkPageCount(pageCount: number, limits: Pick<ProcessingLimits, 'maxPages'>): void {
  if (pageCount > limits.maxPages) {
    throw new ExtractionError('too-many-pages', `The PDF has ${pageCount} pages; the processing limit is ${limits.maxPages}`, 'validation');
  }
}
