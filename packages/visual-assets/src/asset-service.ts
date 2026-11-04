import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';
import { AttachmentStorage } from '@research-studio/research-library';
import { PREPROCESS_VERSION, type PreprocessOperation, type VisualAssetKind, type VisualProvenance } from '@research-studio/shared-types';
import {
  applyOperations,
  DEFAULT_IMAGE_LIMITS,
  inspectImage,
  rasterizeSvg,
  sanitizeSvg,
  toProviderImage,
  VisualError,
  type ImageLimits,
} from '@research-studio/visual-engine';

export type AssetRow = typeof schema.visualAssets.$inferSelect;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' };

export const newAssetId = () => `vas_${randomUUID().replace(/-/g, '')}`;

/** A label safe to show: no path, no control characters, bounded. */
export function assetLabel(name: string | null | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return clean || fallback;
}

/**
 * Visual images: originals as received, variants made by preprocessing and
 * renders of compiled artifacts. Bytes live in a content-addressed store
 * (the M3.2 `AttachmentStorage` with its own root); rows record provenance,
 * the parent and the exact operations. Originals are never modified. An SVG
 * original is kept as received but never served or sent anywhere: a
 * sanitised, rasterised variant is created at once and used instead.
 */
export class VisualAssetService {
  readonly storage: AttachmentStorage;

  constructor(
    private readonly db: StudioDb,
    root: string,
    private readonly limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.storage = new AttachmentStorage(root);
  }

  init(): Promise<void> {
    return this.storage.init();
  }

  private async store(bytes: Uint8Array, mimeType: string): Promise<{ storageKey: string; sha256: string; size: number }> {
    const ext = EXT[mimeType];
    if (!ext) throw new VisualError('unsupported-type', `Cannot store ${mimeType}`);
    const temp = await this.storage.writeTemp(bytes, this.limits.maxBytes * 4);
    try {
      const { storageKey } = await this.storage.commit(temp, ext);
      return { storageKey, sha256: temp.sha256, size: temp.size };
    } finally {
      await this.storage.discard(temp).catch(() => {});
    }
  }

  private insert(row: Omit<typeof schema.visualAssets.$inferInsert, 'id' | 'createdAt'> & { id?: string }): AssetRow {
    const id = row.id ?? newAssetId();
    this.db.insert(schema.visualAssets).values({ ...row, id, createdAt: this.now() }).run();
    return this.get(id)!;
  }

  /** Validate and keep an image as received. Returns the original and, for SVG, its safe raster variant. */
  async addOriginal(bytes: Uint8Array, input: { declaredType: string | null; label: string; provenance: VisualProvenance; projectId?: string | null }): Promise<{ original: AssetRow; working: AssetRow; removed: string[] }> {
    const info = await inspectImage(bytes, input.declaredType, this.limits);
    const id = newAssetId();
    if (info.mimeType === 'image/svg+xml') {
      const { svg, removed } = sanitizeSvg(Buffer.from(bytes).toString('utf8'), this.limits.maxBytes);
      const raster = await rasterizeSvg(svg, this.limits);
      const stored = await this.store(bytes, 'image/svg+xml');
      const original = this.insert({ id, kind: 'original', originalAssetId: id, ...stored, fileSize: stored.size, mimeType: info.mimeType, width: info.width, height: info.height, provenance: input.provenance, label: input.label, projectId: input.projectId ?? null });
      const r = await this.store(raster.data, 'image/png');
      const working = this.insert({
        kind: 'variant',
        parentAssetId: id,
        originalAssetId: id,
        ...r,
        fileSize: r.size,
        mimeType: 'image/png',
        width: raster.width,
        height: raster.height,
        operations: [],
        preprocessVersion: `${PREPROCESS_VERSION}+svg-sanitize`,
        provenance: { source: 'generated', fromAssetId: id, description: `Sanitised SVG rendered as PNG${removed.length ? ` (removed: ${removed.join(', ')})` : ''}` },
        label: `${input.label} (rendered)`,
        projectId: input.projectId ?? null,
      });
      return { original, working, removed };
    }
    const stored = await this.store(bytes, info.mimeType);
    const original = this.insert({ id, kind: 'original', originalAssetId: id, ...stored, fileSize: stored.size, mimeType: info.mimeType, width: info.width, height: info.height, provenance: input.provenance, label: input.label, projectId: input.projectId ?? null });
    return { original, working: original, removed: [] };
  }

  /** A new variant of an asset; the parent stays as it is. */
  async createVariant(parentId: string, operations: readonly PreprocessOperation[], label?: string): Promise<AssetRow> {
    const parent = this.require(parentId);
    if (parent.mimeType === 'image/svg+xml') throw new VisualError('invalid-operation', 'Process the rendered SVG, not the SVG source');
    if (parent.kind === 'render') throw new VisualError('invalid-operation', 'Renders of artifacts are not preprocessed');
    const out = await applyOperations(await this.read(parentId), operations, this.limits);
    const stored = await this.store(out.data, out.mimeType);
    return this.insert({
      kind: 'variant',
      parentAssetId: parent.id,
      originalAssetId: parent.originalAssetId,
      ...stored,
      fileSize: stored.size,
      mimeType: out.mimeType,
      width: out.width,
      height: out.height,
      operations: [...operations],
      preprocessVersion: PREPROCESS_VERSION,
      provenance: parent.provenance,
      label: label ?? `${parent.label} (${operations.map((o) => o.op).join(', ') || 'copy'})`,
      projectId: parent.projectId,
    });
  }

  /** A compiled PDF (or other render) of an artifact version. */
  async addRender(bytes: Uint8Array, mimeType: 'application/pdf' | 'image/png', label: string, fromAssetId: string | null): Promise<AssetRow> {
    const stored = await this.store(bytes, mimeType);
    return this.insert({ kind: 'render', originalAssetId: '', ...stored, fileSize: stored.size, mimeType, provenance: { source: 'generated', fromAssetId, description: 'Compiled preview' }, label, projectId: null, operations: [] });
  }

  get(id: string): AssetRow | null {
    return this.db.select().from(schema.visualAssets).where(eq(schema.visualAssets.id, id)).get() ?? null;
  }

  require(id: string): AssetRow {
    const row = this.get(id);
    if (!row) throw new VisualError('invalid-image', `Image ${id} not found`);
    return row;
  }

  /** Every variant made from an original, oldest first (the provenance chain). */
  lineage(originalId: string): AssetRow[] {
    return this.db.select().from(schema.visualAssets).where(eq(schema.visualAssets.originalAssetId, originalId)).orderBy(schema.visualAssets.createdAt).all();
  }

  listOriginals(opts: { projectId?: string; limit?: number } = {}): AssetRow[] {
    const conds = [eq(schema.visualAssets.kind, 'original' as VisualAssetKind)];
    if (opts.projectId) conds.push(eq(schema.visualAssets.projectId, opts.projectId));
    return this.db.select().from(schema.visualAssets).where(and(...conds)).orderBy(desc(schema.visualAssets.createdAt)).limit(opts.limit ?? 100).all();
  }

  byIds(ids: readonly string[]): AssetRow[] {
    return ids.length ? this.db.select().from(schema.visualAssets).where(inArray(schema.visualAssets.id, [...ids])).all() : [];
  }

  async read(id: string): Promise<Buffer> {
    return this.storage.readBytes(this.require(id).storageKey);
  }

  /** Bytes safe to show in the browser: never an SVG source (its raster variant instead). */
  async readDisplayable(id: string): Promise<{ row: AssetRow; bytes: Buffer }> {
    let row = this.require(id);
    if (row.mimeType === 'image/svg+xml') {
      const raster = this.lineage(row.id).find((a) => a.parentAssetId === row.id && a.mimeType === 'image/png');
      if (!raster) throw new VisualError('unsafe-svg', 'This SVG has no safe rendering');
      row = raster;
    }
    return { row, bytes: await this.storage.readBytes(row.storageKey) };
  }

  /** The image as sent to a vision model (downscaled, PNG or JPEG, within provider limits). */
  async providerImage(id: string) {
    const { bytes } = await this.readDisplayable(id);
    return toProviderImage(bytes, this.limits);
  }
}
