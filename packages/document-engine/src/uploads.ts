import { StudioError } from '@research-studio/shared-types';
import { extname } from './paths';

/** Upload policy: images (and PDF/EPS figures) only. Validated by extension and content. */
export const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'eps'] as const;
export type UploadExtension = (typeof UPLOAD_EXTENSIONS)[number];

type Detected = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'pdf' | 'eps';

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** Identify a file format from its leading bytes. */
export function sniffFormat(bytes: Uint8Array): Detected | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x25, 0x21, 0x50, 0x53])) return 'eps'; // %!PS
  if (startsWith(bytes, [0xc5, 0xd0, 0xd3, 0xc6])) return 'eps'; // DOS EPS binary header
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'svg';
  }
  return null;
}

const EXPECTED: Record<UploadExtension, Detected> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  svg: 'svg',
  pdf: 'pdf',
  eps: 'eps',
};

/** Make an uploaded file name safe while keeping it recognisable. */
export function sanitizeUploadName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const ext = extname(base);
  const stem = base.slice(0, ext ? -(ext.length + 1) : undefined);
  const safeStem =
    stem
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'image';
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/**
 * Validate an upload. Returns the sanitised file name. Throws
 * `UNSUPPORTED_MEDIA_TYPE` when the extension is not allowed or the content
 * does not match it, and `PAYLOAD_TOO_LARGE` when over `maxBytes`.
 */
export function validateUpload(fileName: string, bytes: Uint8Array, maxBytes: number): string {
  const safeName = sanitizeUploadName(fileName);
  const ext = extname(safeName) as UploadExtension;
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new StudioError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Only ${UPLOAD_EXTENSIONS.join(', ')} files can be uploaded`,
      { fileName },
    );
  }
  if (bytes.byteLength === 0) {
    throw new StudioError('BAD_REQUEST', 'Uploaded file is empty', { fileName });
  }
  if (bytes.byteLength > maxBytes) {
    throw new StudioError('PAYLOAD_TOO_LARGE', `File exceeds ${maxBytes} bytes`, { fileName });
  }
  const detected = sniffFormat(bytes);
  if (detected !== EXPECTED[ext]) {
    throw new StudioError(
      'UNSUPPORTED_MEDIA_TYPE',
      `File content does not match the .${ext} extension`,
      { fileName, detected },
    );
  }
  return safeName;
}
