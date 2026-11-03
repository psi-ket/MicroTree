import { describe, expect, it } from 'vitest';
import { sanitizeUploadName, sniffFormat, validateUpload } from '../src';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('uploads', () => {
  it('sniffs formats', () => {
    expect(sniffFormat(PNG)).toBe('png');
    expect(sniffFormat(JPEG)).toBe('jpeg');
    expect(sniffFormat(PDF)).toBe('pdf');
    expect(sniffFormat(SVG)).toBe('svg');
    expect(sniffFormat(new TextEncoder().encode('hello'))).toBeNull();
  });

  it('sanitizes names', () => {
    expect(sanitizeUploadName('../../evil/My Plot (final).PNG')).toBe('My-Plot-final.png');
    expect(sanitizeUploadName('C:\\Users\\x\\fig.jpg')).toBe('fig.jpg');
    expect(sanitizeUploadName('...')).toBe('image');
  });

  it('accepts matching content', () => {
    expect(validateUpload('plot.png', PNG, 1024)).toBe('plot.png');
    expect(validateUpload('photo.JPG', JPEG, 1024)).toBe('photo.jpg');
  });

  it('rejects mismatches, disallowed types and oversize files', () => {
    expect(() => validateUpload('plot.png', JPEG, 1024)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    );
    expect(() => validateUpload('run.exe', PNG, 1024)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    );
    expect(() => validateUpload('plot.png', PNG, 4)).toThrowError(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    expect(() => validateUpload('plot.png', new Uint8Array(), 4)).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );
  });
});
