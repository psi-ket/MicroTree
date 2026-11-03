import type { ModelCapabilities } from '@research-studio/shared-types';
import { ProviderError } from './errors';
import type { ChatTurn, ImageMimeType, MessageContent, ModelRequest } from './types';

/**
 * Multimodal message content: the contract between callers and model adapters.
 * Each adapter serialises the parts in its provider's own format; this module
 * only normalises and validates, so adapters stay independent of each other.
 */

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const satisfies readonly ImageMimeType[];

export const IMAGE_LIMITS = {
  /** Per image (the strictest provider limit, Anthropic's 5 MB). */
  maxBytes: 5 * 1024 * 1024,
  /** Per request. */
  maxImages: 20,
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** A turn's content as parts (a plain string is one text part). */
export function contentParts(content: ChatTurn['content']): MessageContent[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** The text of a turn, without its images. */
export function textOf(content: ChatTurn['content']): string {
  return typeof content === 'string' ? content : content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
}

export function hasImages(request: Pick<ModelRequest, 'messages'>): boolean {
  return request.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'));
}

/** The image type its leading bytes identify, if it is one we accept. */
export function sniffImageType(data: Uint8Array): ImageMimeType | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  return null;
}

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * Check a request's content before it is serialised. Throws
 * `unsupported-modality` when the provider cannot take images at all, and
 * `invalid-request` for malformed parts (wrong or spoofed type, too large,
 * too many, images in assistant turns, empty content).
 */
export function validateRequestContent(request: Pick<ModelRequest, 'messages'>, capabilities: Pick<ModelCapabilities, 'vision'>): void {
  let images = 0;
  let total = 0;
  for (const [i, turn] of request.messages.entries()) {
    if (typeof turn.content === 'string') continue;
    if (!Array.isArray(turn.content) || turn.content.length === 0) throw new ProviderError('invalid-request', `Message ${i + 1} has no content.`);
    for (const part of turn.content) {
      if (part.type === 'text') {
        if (typeof part.text !== 'string') throw new ProviderError('invalid-request', `Message ${i + 1} has a text part without text.`);
        continue;
      }
      if (part.type !== 'image') throw new ProviderError('invalid-request', `Message ${i + 1} has a part of unknown type.`);
      if (!capabilities.vision) throw new ProviderError('unsupported-modality', 'This provider does not accept images. Choose a provider with image support or remove the image.');
      if (turn.role !== 'user') throw new ProviderError('invalid-request', 'Images can only be sent in user messages.');
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(part.mimeType)) {
        throw new ProviderError('invalid-request', `Images must be PNG, JPEG or WebP (got ${String(part.mimeType).slice(0, 40)}).`);
      }
      if (!(part.data instanceof Uint8Array) || part.data.byteLength === 0) throw new ProviderError('invalid-request', 'An image is empty.');
      if (sniffImageType(part.data) !== part.mimeType) throw new ProviderError('invalid-request', `An image's content does not match its type ${part.mimeType}.`);
      if (part.data.byteLength > IMAGE_LIMITS.maxBytes) throw new ProviderError('invalid-request', `An image is larger than ${MB(IMAGE_LIMITS.maxBytes)}.`);
      images++;
      total += part.data.byteLength;
    }
  }
  if (images > IMAGE_LIMITS.maxImages) throw new ProviderError('invalid-request', `At most ${IMAGE_LIMITS.maxImages} images can be sent at once.`);
  if (total > IMAGE_LIMITS.maxTotalBytes) throw new ProviderError('invalid-request', `The images together are larger than ${MB(IMAGE_LIMITS.maxTotalBytes)}.`);
}
