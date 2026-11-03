import sharp from 'sharp';
import type { PreprocessOperation } from '@research-studio/shared-types';
import { VisualError } from '../errors/visual-errors';
import { DEFAULT_IMAGE_LIMITS, type ImageLimits } from './image-validator';

/**
 * Preprocessing: crop, rotation (EXIF or any angle, which also straightens a
 * skewed photo), resizing, contrast, normalisation, sharpening, upscaling and
 * grayscale. Operations run in order on the parent image and the result is
 * PNG (lossless), so colour, which can carry scientific information in plots
 * and diagrams, is kept unless the user asks for grayscale.
 */

export interface ProcessedImage {
  data: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
}

function check(op: PreprocessOperation): void {
  const finite = (...v: number[]) => v.every((x) => Number.isFinite(x));
  switch (op.op) {
    case 'rotate':
      if (!finite(op.degrees) || Math.abs(op.degrees) > 360) throw new VisualError('invalid-operation', 'Rotation must be between -360 and 360 degrees');
      return;
    case 'crop':
      if (!finite(op.left, op.top, op.width, op.height) || op.left < 0 || op.top < 0 || op.width < 1 || op.height < 1) throw new VisualError('invalid-operation', 'Invalid crop rectangle');
      return;
    case 'resize':
      if (!finite(op.maxWidth, op.maxHeight) || op.maxWidth < 8 || op.maxHeight < 8 || op.maxWidth > 12_000 || op.maxHeight > 12_000) throw new VisualError('invalid-operation', 'Invalid size');
      return;
    case 'contrast':
      if (!finite(op.factor) || op.factor < 0.2 || op.factor > 5) throw new VisualError('invalid-operation', 'Contrast must be between 0.2 and 5');
      return;
    case 'upscale':
      if (!finite(op.factor) || op.factor < 1 || op.factor > 4) throw new VisualError('invalid-operation', 'Upscaling must be between 1× and 4×');
      return;
    default:
      return;
  }
}

/** Apply operations in order; each step decodes with the pixel limit, so no step can expand beyond it. */
export async function applyOperations(input: Uint8Array, operations: readonly PreprocessOperation[], limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<ProcessedImage> {
  if (operations.length > 20) throw new VisualError('invalid-operation', 'At most 20 preprocessing steps');
  let buf: Buffer = Buffer.from(input);
  for (const op of operations) {
    check(op);
    let img = sharp(buf, { limitInputPixels: limits.maxPixels, failOn: 'error' });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    switch (op.op) {
      case 'auto-orient':
        img = img.rotate();
        break;
      case 'rotate':
        img = img.rotate(op.degrees, { background: { r: 255, g: 255, b: 255, alpha: 1 } });
        break;
      case 'crop': {
        const left = Math.round(op.left);
        const top = Math.round(op.top);
        const width = Math.min(Math.round(op.width), w - left);
        const height = Math.min(Math.round(op.height), h - top);
        if (width < 1 || height < 1) throw new VisualError('invalid-operation', 'The crop is outside the image');
        img = img.extract({ left, top, width, height });
        break;
      }
      case 'resize':
        img = img.resize(Math.round(op.maxWidth), Math.round(op.maxHeight), { fit: 'inside', withoutEnlargement: true });
        break;
      case 'grayscale':
        img = img.grayscale();
        break;
      case 'contrast':
        img = img.linear(op.factor, 128 * (1 - op.factor));
        break;
      case 'normalize':
        img = img.normalise();
        break;
      case 'sharpen':
        img = img.sharpen();
        break;
      case 'upscale': {
        const nw = Math.round(w * op.factor);
        const nh = Math.round(h * op.factor);
        if (nw * nh > limits.maxPixels || nw > limits.maxDimension || nh > limits.maxDimension) throw new VisualError('too-many-pixels', 'Upscaling would exceed the pixel limit');
        img = img.resize(nw, nh, { kernel: 'lanczos3' });
        break;
      }
    }
    buf = await img.png().toBuffer();
  }
  if (!operations.length) buf = await sharp(buf, { limitInputPixels: limits.maxPixels }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  return { data: buf, mimeType: 'image/png', width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Largest side sent to a vision model; providers downscale larger images anyway. */
export const PROVIDER_MAX_SIDE = 2048;

/**
 * The image as a model receives it: PNG, JPEG or WebP, at most 2048 px per
 * side and within the 5 MB per-image limit of `ai-core`.
 */
export async function toProviderImage(input: Uint8Array, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<{ mimeType: 'image/png' | 'image/jpeg'; data: Uint8Array; width: number; height: number }> {
  const base = sharp(input, { limitInputPixels: limits.maxPixels }).resize(PROVIDER_MAX_SIDE, PROVIDER_MAX_SIDE, { fit: 'inside', withoutEnlargement: true });
  let data = await base.clone().png({ compressionLevel: 9 }).toBuffer();
  let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
  if (data.byteLength > 4.5 * 1024 * 1024) {
    data = await base.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    mimeType = 'image/jpeg';
  }
  const meta = await sharp(data).metadata();
  return { mimeType, data: new Uint8Array(data), width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Rasterise an SVG that has already been sanitised. */
export async function rasterizeSvg(sanitized: string, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): Promise<ProcessedImage> {
  try {
    const data = await sharp(Buffer.from(sanitized, 'utf8'), { limitInputPixels: limits.maxPixels, density: 144 }).png().toBuffer();
    const meta = await sharp(data).metadata();
    return { data, mimeType: 'image/png', width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch (err) {
    throw new VisualError('invalid-image', `The SVG could not be rendered (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
  }
}

/**
 * A rough count of image input tokens for display only (Anthropic's
 * published rule of thumb, width × height / 750 after downscaling). Real
 * usage is what the provider reports.
 */
export function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.ceil((width * scale * height * scale) / 750);
}
