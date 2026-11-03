import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@research-studio/database';
import { applyOperations, inspectImage, sanitizeSvg, toProviderImage, VisualError } from '@research-studio/visual-engine';
import { assetLabel, VisualAssetService } from '../src';

let dir: string;
let handle: DatabaseHandle;
let assets: VisualAssetService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rs-visual-'));
  handle = createDatabase(':memory:');
  assets = new VisualAssetService(handle.db, path.join(dir, 'visual'));
  await assets.init();
});
afterEach(async () => {
  handle.close();
  await rm(dir, { recursive: true, force: true });
});

const solid = (w: number, h: number, color = '#3366cc') => sharp({ create: { width: w, height: h, channels: 3, background: color } });
const png = (w = 64, h = 32) => solid(w, h).png().toBuffer();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A PNG whose header claims a huge size with almost no data: a decompression bomb. */
function bombPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(1024))), chunk('IEND', Buffer.alloc(0))]);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof VisualError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('image validation', () => {
  it('accepts PNG, JPEG and WebP by their content and reports their size', async () => {
    for (const [fmt, mime] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
    ] as const) {
      const bytes = await solid(40, 20).toFormat(fmt).toBuffer();
      expect(await inspectImage(bytes, mime)).toMatchObject({ mimeType: mime, width: 40, height: 20 });
    }
  });

  it('refuses other formats, mismatched types, damaged and empty files', async () => {
    expect(await code(inspectImage(Buffer.from('GIF89a......'), null))).toBe('unsupported-type');
    expect(await code(inspectImage(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'))).toBe('unsupported-type');
    expect(await code(inspectImage(await png(), 'image/jpeg'))).toBe('unsupported-type');
    const full = await png(200, 200);
    expect(await code(inspectImage(full.subarray(0, 60), 'image/png'))).toBe('invalid-image');
    expect(await code(inspectImage(new Uint8Array(0), 'image/png'))).toBe('invalid-image');
  });

  it('refuses decompression bombs and oversized files before decoding them', async () => {
    const bomb = bombPng(60_000, 60_000);
    expect(bomb.byteLength).toBeLessThan(2000);
    expect(await code(inspectImage(bomb, 'image/png'))).toBe('too-many-pixels');
    expect(await code(inspectImage(await png(), 'image/png', { maxBytes: 100, maxPixels: 1e6, maxDimension: 1000 }))).toBe('too-large');
    expect(await code(inspectImage(await png(300, 300), 'image/png', { maxBytes: 1e6, maxPixels: 50_000, maxDimension: 1000 }))).toBe('too-many-pixels');
  });
});

describe('SVG sanitising', () => {
  it('removes scripts, handlers, foreign content, external references and CSS URLs', () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" onload="alert(1)">
      <script>alert(1)</script><style>@import url(http://evil.test/x.css);</style>
      <foreignObject><iframe src="http://evil.test"/></foreignObject>
      <image xlink:href="file:///etc/passwd"/><use xlink:href="http://evil.test/s.svg#x"/><use href="#ok"/>
      <a href="javascript:alert(1)"><rect width="5" height="5"/></a>
      <rect id="ok" width="10" height="10" fill="url(http://evil.test/p)" stroke="url(#grad)" style="fill:url(http://evil.test)"/>
      <text x="1" y="5">a &lt; b</text></svg>`;
    const { svg, removed } = sanitizeSvg(hostile);
    expect(svg).not.toMatch(/script|onload|foreignObject|iframe|evil\.test|passwd|javascript|style/i);
    expect(svg).toContain('<use href="#ok"></use>');
    expect(svg).toContain('stroke="url(#grad)"');
    expect(svg).toContain('a &lt; b');
    expect(removed).toEqual(expect.arrayContaining(['element script', 'element foreignObject', 'external reference', 'external url()', 'attribute onload', 'element a']));
  });

  it('refuses DTDs and entity expansion, and non-SVG XML', () => {
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>')).toThrow(VisualError);
    expect(() => sanitizeSvg('<html/>')).toThrow(/not an SVG/);
  });
});

describe('preprocessing', () => {
  it('rotates, crops, resizes, upscales and keeps colour unless asked', async () => {
    const input = await png(80, 40);
    expect(await applyOperations(input, [{ op: 'rotate', degrees: 90 }])).toMatchObject({ width: 40, height: 80, mimeType: 'image/png' });
    expect(await applyOperations(input, [{ op: 'crop', left: 10, top: 5, width: 30, height: 20 }])).toMatchObject({ width: 30, height: 20 });
    expect(await applyOperations(input, [{ op: 'resize', maxWidth: 40, maxHeight: 40 }])).toMatchObject({ width: 40, height: 20 });
    expect(await applyOperations(input, [{ op: 'upscale', factor: 2 }])).toMatchObject({ width: 160, height: 80 });
    const color = await applyOperations(input, [{ op: 'contrast', factor: 1.5 }]);
    expect((await sharp(color.data).metadata()).channels).toBe(3);
    const gray = await applyOperations(input, [{ op: 'grayscale' }]);
    const stats = await sharp(gray.data).stats();
    expect(stats.channels.every((c) => Math.abs(c.mean - stats.channels[0]!.mean) < 1)).toBe(true);
    const skew = await applyOperations(input, [{ op: 'rotate', degrees: 3.5 }]);
    expect(skew.width).toBeGreaterThan(80);
  });

  it('refuses invalid operations and crops outside the image', async () => {
    const input = await png(80, 40);
    expect(await code(applyOperations(input, [{ op: 'crop', left: 100, top: 0, width: 10, height: 10 }]))).toBe('invalid-operation');
    expect(await code(applyOperations(input, [{ op: 'contrast', factor: 50 }]))).toBe('invalid-operation');
    expect(await code(applyOperations(input, [{ op: 'upscale', factor: 4 }], { maxBytes: 1e8, maxPixels: 10_000, maxDimension: 10_000 }))).toBe('too-many-pixels');
  });

  it('prepares images for providers within their limits', async () => {
    const big = await solid(4000, 1000).png().toBuffer();
    const out = await toProviderImage(big);
    expect(Math.max(out.width, out.height)).toBe(2048);
    expect(out.data.byteLength).toBeLessThan(5 * 1024 * 1024);
  });
});

describe('asset service', () => {
  it('keeps the original unchanged and records variants with parent, operations and provenance', async () => {
    const bytes = await png(100, 50);
    const { original, working } = await assets.addOriginal(bytes, { declaredType: 'image/png', label: 'notes.png', provenance: { source: 'upload', fileName: 'notes.png' } });
    expect(working.id).toBe(original.id);
    expect(original).toMatchObject({ kind: 'original', mimeType: 'image/png', width: 100, height: 50, sha256: sha(bytes), originalAssetId: original.id });
    const v1 = await assets.createVariant(original.id, [{ op: 'crop', left: 0, top: 0, width: 50, height: 50 }]);
    const v2 = await assets.createVariant(v1.id, [{ op: 'grayscale' }, { op: 'upscale', factor: 2 }]);
    expect(v2).toMatchObject({ kind: 'variant', parentAssetId: v1.id, originalAssetId: original.id, width: 100, height: 100, preprocessVersion: '1' });
    expect(v2.operations).toEqual([{ op: 'grayscale' }, { op: 'upscale', factor: 2 }]);
    expect(v2.provenance).toEqual({ source: 'upload', fileName: 'notes.png' });
    expect(sha(await assets.read(original.id))).toBe(sha(bytes));
    expect(assets.lineage(original.id).map((a) => a.id)).toEqual([original.id, v1.id, v2.id]);
    // Rebuilding a variant from its parent and operations gives the same image.
    const again = await applyOperations(await assets.read(v1.id), v2.operations);
    expect(sha(again.data)).toBe(v2.sha256);
  });

  it('keeps PDF-region provenance', async () => {
    const provenance = { source: 'pdf-region' as const, attachmentId: 'att_1', libraryItemId: 'li_1', pdfSha256: 'a'.repeat(64), pageNumber: 3, region: { x: 72, y: 100, width: 200, height: 80, pageWidth: 612, pageHeight: 792 }, renderScale: 3 };
    const { original } = await assets.addOriginal(await png(), { declaredType: 'image/png', label: 'Figure crop', provenance });
    expect(assets.get(original.id)!.provenance).toEqual(provenance);
  });

  it('stores an SVG as received but only ever serves its sanitised raster', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>alert(1)</script><rect width="20" height="10" fill="red"/></svg>');
    const { original, working, removed } = await assets.addOriginal(svg, { declaredType: 'image/svg+xml', label: 'fig.svg', provenance: { source: 'upload', fileName: 'fig.svg' } });
    expect(original.mimeType).toBe('image/svg+xml');
    expect(working).toMatchObject({ mimeType: 'image/png', parentAssetId: original.id });
    expect(removed).toContain('element script');
    const shown = await assets.readDisplayable(original.id);
    expect(shown.row.id).toBe(working.id);
    expect(shown.bytes.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    await expect(assets.createVariant(original.id, [{ op: 'grayscale' }])).rejects.toMatchObject({ code: 'invalid-operation' });
  });

  it('cleans labels of paths and control characters', () => {
    expect(assetLabel('../../etc/passwd', 'x')).toBe('passwd');
    expect(assetLabel('C:\\Users\\me\\eq\u0000.png', 'x')).toBe('eq.png');
    expect(assetLabel('', 'Pasted image')).toBe('Pasted image');
  });
});
