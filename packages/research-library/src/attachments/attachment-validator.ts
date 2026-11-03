import type { AttachmentType } from '@research-studio/shared-types';
import { LibraryError } from '../errors/library-errors';

/** MIME types a browser or server may declare for a PDF. Anything else is refused before reading the content. */
const PDF_DECLARED_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream', 'binary/octet-stream', '']);

/** Supplementary files accepted besides PDFs (checked by content, like uploads). */
const OTHER_TYPES: Record<string, { mime: string; magic: (head: Buffer) => boolean }> = {
  zip: { mime: 'application/zip', magic: (h) => h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  png: { mime: 'image/png', magic: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', magic: (h) => h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  csv: { mime: 'text/csv', magic: (h) => isText(h) },
  txt: { mime: 'text/plain', magic: (h) => isText(h) },
};

function isText(head: Buffer): boolean {
  if (head.includes(0)) return false;
  return !new TextDecoder('utf-8', { fatal: false }).decode(head).includes('�');
}

/**
 * Structural PDF checks on the first and last bytes: a `%PDF-1.x`/`%PDF-2.x`
 * header within the first KiB (as readers accept) and an `%%EOF` marker near
 * the end. The full parse happens afterwards in a worker.
 */
export function checkPdfStructure(head: Buffer, tail: Buffer): void {
  const at = head.indexOf('%PDF-');
  if (at === -1 || at > 1024) throw new LibraryError('UNSUPPORTED_MEDIA_TYPE', 'The file is not a PDF (no "%PDF-" header)');
  if (!/^%PDF-[12]\.\d/.test(head.subarray(at, at + 8).toString('latin1'))) {
    throw new LibraryError('UNSUPPORTED_MEDIA_TYPE', 'The file has an unknown PDF version header');
  }
  if (tail.lastIndexOf('%%EOF') === -1) {
    throw new LibraryError('UNSUPPORTED_MEDIA_TYPE', 'The PDF is incomplete or damaged (no end-of-file marker); it may have been cut off while downloading');
  }
}

export function checkDeclaredPdfType(declared: string | null | undefined): void {
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (!PDF_DECLARED_TYPES.has(type)) {
    throw new LibraryError('UNSUPPORTED_MEDIA_TYPE', `Expected a PDF, but the file was sent as "${type}"`);
  }
}

/** Identify an attachment's MIME type from its content; refuses types the library does not keep. */
export function detectAttachmentType(head: Buffer, tail: Buffer, wanted: AttachmentType, fileName: string): { mime: string; extension: string } {
  if (head.indexOf('%PDF-') !== -1 && head.indexOf('%PDF-') <= 1024) {
    checkPdfStructure(head, tail);
    return { mime: 'application/pdf', extension: 'pdf' };
  }
  if (wanted === 'pdf') checkPdfStructure(head, tail); // throws with the reason
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const known = OTHER_TYPES[ext === 'jpeg' ? 'jpg' : ext];
  if (known?.magic(head)) return { mime: known.mime, extension: ext === 'jpeg' ? 'jpg' : ext };
  throw new LibraryError(
    'UNSUPPORTED_MEDIA_TYPE',
    'Attachments can be PDFs, or supplementary ZIP, PNG, JPEG, CSV or text files whose content matches their extension',
  );
}

/** A display name derived from the original: no directories, no control or reserved characters, bounded length. */
export function safeFileName(original: string, extension: string): string {
  const base = original.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return `${stem || 'attachment'}.${extension}`;
}
