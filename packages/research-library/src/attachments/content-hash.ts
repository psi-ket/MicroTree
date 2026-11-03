import { createHash } from 'node:crypto';

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash and measure a byte stream as it passes, keeping its first and last
 * bytes for structural checks without holding the whole file.
 */
export class StreamDigest {
  private readonly hash = createHash('sha256');
  size = 0;
  head = Buffer.alloc(0);
  private tailChunks: Buffer[] = [];
  private tailSize = 0;

  constructor(
    private readonly headBytes = 1024,
    private readonly tailBytes = 16 * 1024,
  ) {}

  update(chunk: Uint8Array): void {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.hash.update(buf);
    this.size += buf.length;
    if (this.head.length < this.headBytes) this.head = Buffer.concat([this.head, buf.subarray(0, this.headBytes - this.head.length)]);
    this.tailChunks.push(Buffer.from(buf));
    this.tailSize += buf.length;
    while (this.tailChunks.length > 1 && this.tailSize - this.tailChunks[0]!.length >= this.tailBytes) {
      this.tailSize -= this.tailChunks.shift()!.length;
    }
  }

  get tail(): Buffer {
    const all = Buffer.concat(this.tailChunks);
    return all.subarray(Math.max(0, all.length - this.tailBytes));
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}
