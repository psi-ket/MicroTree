import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PassageKind, SectionType } from '@research-studio/document-intelligence';
import { EmbeddingError, spaceKey, type EmbeddingModelInfo } from '../embeddings/embedding-provider';
import type { PassageFilter, RankedHit } from '../keyword-search/keyword-index';

export interface EmbeddingSpace extends EmbeddingModelInfo {
  id: string;
  key: string;
  createdAt: string;
}

/** Provider-independent vector storage. */
export interface VectorStore {
  ensureSpace(info: EmbeddingModelInfo): EmbeddingSpace;
  space(id: string): EmbeddingSpace | null;
  spaces(): EmbeddingSpace[];
  cached(spaceId: string, textHashes: readonly string[]): Map<string, Float32Array>;
  putVectors(spaceId: string, items: readonly { textHash: string; vector: Float32Array }[]): void;
  link(spaceId: string, links: readonly { passageId: string; extractionId: string; textHash: string }[]): void;
  indexedPassages(spaceId: string, extractionId?: string): number;
  search(spaceId: string, query: Float32Array, filter: PassageFilter, limit: number): RankedHit[];
  unlinkExtraction(extractionId: string): void;
  deleteSpace(spaceId: string): void;
  sweep(): number;
}

interface CachedVector {
  passageId: string;
  extractionId: string;
  kind: PassageKind;
  sectionType: SectionType;
  vector: Float32Array;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/**
 * Vectors in SQLite (`embedding_vectors`, float32 BLOBs, unit length) with an
 * exact cosine scan in Node. Vectors of one space are loaded once and kept in
 * memory until that space changes. Spaces never mix: every call names one,
 * and dimensions are checked on write and on query.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly memory = new Map<string, CachedVector[]>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  ensureSpace(info: EmbeddingModelInfo): EmbeddingSpace {
    if (!Number.isInteger(info.dimensions) || info.dimensions < 1 || info.dimensions > 16_384) throw new EmbeddingError('invalid-response', `Unsupported embedding size ${info.dimensions}`);
    const version = info.version ?? '';
    const existing = this.sqlite
      .prepare('SELECT id FROM embedding_spaces WHERE provider = ? AND model = ? AND dimensions = ? AND model_version = ?')
      .get(info.provider, info.model, info.dimensions, version) as { id: string } | undefined;
    if (existing) return this.space(existing.id)!;
    const id = `esp_${randomUUID().replace(/-/g, '')}`;
    this.sqlite.prepare('INSERT INTO embedding_spaces (id, provider, model, dimensions, model_version, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, info.provider, info.model, info.dimensions, version, this.now());
    return this.space(id)!;
  }

  space(id: string): EmbeddingSpace | null {
    const r = this.sqlite.prepare('SELECT id, provider, model, dimensions, model_version, created_at FROM embedding_spaces WHERE id = ?').get(id) as
      | { id: string; provider: string; model: string; dimensions: number; model_version: string; created_at: string }
      | undefined;
    if (!r) return null;
    const info: EmbeddingModelInfo = { provider: r.provider, model: r.model, dimensions: r.dimensions, ...(r.model_version ? { version: r.model_version } : {}) };
    return { ...info, id: r.id, key: spaceKey(info), createdAt: r.created_at };
  }

  spaces(): EmbeddingSpace[] {
    return (this.sqlite.prepare('SELECT id FROM embedding_spaces ORDER BY created_at').all() as { id: string }[]).map((r) => this.space(r.id)!);
  }

  private dims(spaceId: string): number {
    const s = this.space(spaceId);
    if (!s) throw new EmbeddingError('invalid-response', 'Unknown embedding space');
    return s.dimensions;
  }

  cached(spaceId: string, textHashes: readonly string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const stmt = this.sqlite.prepare('SELECT text_hash, vector FROM embedding_vectors WHERE space_id = ? AND text_hash IN (SELECT value FROM json_each(?))');
    for (let i = 0; i < textHashes.length; i += 500) {
      for (const r of stmt.all(spaceId, JSON.stringify(textHashes.slice(i, i + 500))) as { text_hash: string; vector: Buffer }[]) out.set(r.text_hash, fromBlob(r.vector));
    }
    return out;
  }

  putVectors(spaceId: string, items: readonly { textHash: string; vector: Float32Array }[]): void {
    const d = this.dims(spaceId);
    const stmt = this.sqlite.prepare('INSERT OR REPLACE INTO embedding_vectors (space_id, text_hash, vector, created_at) VALUES (?, ?, ?, ?)');
    const ts = this.now();
    this.sqlite.transaction(() => {
      for (const it of items) {
        if (it.vector.length !== d) throw new EmbeddingError('dimension-mismatch', `Vector has ${it.vector.length} dimensions; the space uses ${d}`);
        stmt.run(spaceId, it.textHash, toBlob(it.vector), ts);
      }
    })();
  }

  link(spaceId: string, links: readonly { passageId: string; extractionId: string; textHash: string }[]): void {
    const stmt = this.sqlite.prepare('INSERT OR REPLACE INTO passage_embeddings (space_id, passage_id, extraction_id, text_hash, embedded_at) VALUES (?, ?, ?, ?, ?)');
    const ts = this.now();
    this.sqlite.transaction(() => {
      for (const l of links) stmt.run(spaceId, l.passageId, l.extractionId, l.textHash, ts);
    })();
    this.memory.delete(spaceId);
  }

  indexedPassages(spaceId: string, extractionId?: string): number {
    const r = extractionId
      ? this.sqlite.prepare('SELECT COUNT(*) AS n FROM passage_embeddings WHERE space_id = ? AND extraction_id = ?').get(spaceId, extractionId)
      : this.sqlite.prepare('SELECT COUNT(*) AS n FROM passage_embeddings pe JOIN document_extractions x ON x.id = pe.extraction_id WHERE pe.space_id = ? AND x.is_active = 1').get(spaceId);
    return (r as { n: number }).n;
  }

  private load(spaceId: string): CachedVector[] {
    const hit = this.memory.get(spaceId);
    if (hit) return hit;
    const rows = this.sqlite
      .prepare(
        `SELECT pe.passage_id, pe.extraction_id, p.kind, p.section_type, v.vector
         FROM passage_embeddings pe
         JOIN embedding_vectors v ON v.space_id = pe.space_id AND v.text_hash = pe.text_hash
         JOIN document_passages p ON p.id = pe.passage_id
         JOIN document_extractions x ON x.id = pe.extraction_id AND x.is_active = 1
         WHERE pe.space_id = ?`,
      )
      .iterate(spaceId) as Iterable<{ passage_id: string; extraction_id: string; kind: PassageKind; section_type: SectionType; vector: Buffer }>;
    const list: CachedVector[] = [];
    for (const r of rows) list.push({ passageId: r.passage_id, extractionId: r.extraction_id, kind: r.kind, sectionType: r.section_type, vector: fromBlob(r.vector) });
    list.sort((a, b) => (a.passageId < b.passageId ? -1 : 1));
    this.memory.set(spaceId, list);
    return list;
  }

  /** Forget cached vectors (after extractions were replaced or deleted). */
  invalidate(spaceId?: string): void {
    if (spaceId) this.memory.delete(spaceId);
    else this.memory.clear();
  }

  search(spaceId: string, query: Float32Array, filter: PassageFilter, limit: number): RankedHit[] {
    const d = this.dims(spaceId);
    if (query.length !== d) throw new EmbeddingError('dimension-mismatch', `The query embedding has ${query.length} dimensions; this index uses ${d}`);
    const ids = filter.extractionIds ? new Set(filter.extractionIds) : null;
    const kinds = filter.kinds.length ? new Set(filter.kinds) : null;
    const sections = filter.sectionTypes.length ? new Set(filter.sectionTypes) : null;
    // Keep the best `limit` in a small sorted array (exact search).
    const top: { c: CachedVector; s: number }[] = [];
    for (const c of this.load(spaceId)) {
      if (ids && !ids.has(c.extractionId)) continue;
      if (kinds && !kinds.has(c.kind)) continue;
      if (sections && !sections.has(c.sectionType)) continue;
      const v = c.vector;
      let s = 0;
      for (let i = 0; i < d; i++) s += v[i]! * query[i]!;
      if (top.length < limit || s > top[top.length - 1]!.s) {
        let at = top.length;
        while (at > 0 && top[at - 1]!.s < s) at--;
        top.splice(at, 0, { c, s });
        if (top.length > limit) top.pop();
      }
    }
    return top.map((t, i) => ({ passageId: t.c.passageId, extractionId: t.c.extractionId, rank: i + 1, score: t.s }));
  }

  unlinkExtraction(extractionId: string): void {
    this.sqlite.prepare('DELETE FROM passage_embeddings WHERE extraction_id = ?').run(extractionId);
    this.memory.clear();
  }

  deleteSpace(spaceId: string): void {
    this.sqlite.prepare('DELETE FROM embedding_spaces WHERE id = ?').run(spaceId);
    this.memory.delete(spaceId);
  }

  /** Delete cached vectors no passage uses any more. */
  sweep(): number {
    const changes = this.sqlite
      .prepare('DELETE FROM embedding_vectors WHERE NOT EXISTS (SELECT 1 FROM passage_embeddings pe WHERE pe.space_id = embedding_vectors.space_id AND pe.text_hash = embedding_vectors.text_hash)')
      .run().changes;
    return changes;
  }
}
