import sharp from 'sharp';
import { sniffFormat } from '@research-studio/document-engine';
import type { VisualImageType } from '@research-studio/shared-types';
import { VisualError } from '../errors/visual-errors';

/** Limits for decoding untrusted images (decompression bombs, huge files). */
export interface ImageLimits {
  maxBytes: number;
  /** Total pixels a decoder may produce. */
  maxPixels: number;
  maxDimension: number;
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxBytes: 20 * 1024 * 1024, maxPixels: 40_000_000, maxDimension: 12_000 };

const RASTER: Record<string, VisualImageType> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

export interface ImageInfo {
  mimeType: VisualImageType;
  width: number;
  height: number;
  hasAlpha: boolean;
  /** EXIF orientation (1 = upright), when present. */
  orientation: number | null;
}

/**
 * Identify and decode an image without trusting its name or declared type.
 * The signature must be PNG, JPEG, WebP or SVG and agree with the declared
 * type (when one is given); decoding runs with a pixel limit, so a small file
 * that would expand to gigabytes is refused before it is decompressed. SVG is
 * checked here only for its signature: callers sanitise it first.
 */
export async function inspectImage(bytes: Uint8Array, declaredType: string | null, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<ImageInfo> {
  if (bytes.byteLength === 0) throw new VisualError('invalid-image', 'The image is empty');
  if (bytes.byteLength > limits.maxBytes) throw new VisualError('too-large', `The image is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
  const format = sniffFormat(bytes);
  const mimeType = format ? RASTER[format] : undefined;
  if (!mimeType) throw new VisualError('unsupported-type', 'Only PNG, JPEG, WebP and SVG images are accepted');
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== mimeType && !(declaredType === 'image/jpg' && mimeType === 'image/jpeg')) {
    throw new VisualError('unsupported-type', `The file's content (${mimeType}) does not match its declared type (${declaredType.slice(0, 40)})`);
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error' }).metadata();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/pixel limit/i.test(msg)) throw new VisualError('too-many-pixels', `The image has more than ${Math.round(limits.maxPixels / 1e6)} million pixels`);
    throw new VisualError('invalid-image', `The image could not be read (${msg.slice(0, 120) || 'decode error'})`);
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new VisualError('invalid-image', 'The image has no size');
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw new VisualError('too-many-pixels', `The image is ${width} × ${height} pixels; the limit is ${limits.maxDimension} per side and ${Math.round(limits.maxPixels / 1e6)} million pixels`);
  }
  // Decode fully once (with the pixel limit) so truncated or corrupt data is refused now, not later.
  try {
    await sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error' }).resize(8, 8, { fit: 'inside' }).raw().toBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/pixel limit/i.test(msg)) throw new VisualError('too-many-pixels', 'The image has more pixels than the limit');
    throw new VisualError('invalid-image', `The image data is damaged or incomplete (${msg.slice(0, 120)})`);
  }
  return { mimeType, width, height, hasAlpha: !!meta.hasAlpha, orientation: meta.orientation ?? null };
}
