import { createHash } from 'node:crypto';
import { createDatabase, type DatabaseHandle } from '@research-studio/database';
import { normalizeSearchText, type PassageKind, type SectionType } from '@research-studio/document-intelligence';
import type { EmbeddingModelInfo, EmbeddingProvider, EmbeddingResult } from '../../src';

const ts = '2026-11-03T10:00:00.000Z';
let seq = 0;

export interface TestPassage {
  text: string;
  section?: string;
  sectionType?: SectionType;
  kind?: PassageKind;
}

/** A database with one library item and attachment per call to `addPaper`. */
export function testDb(): DatabaseHandle & { addPaper(passages: TestPassage[], opts?: { active?: boolean; attachmentId?: string }): { extractionId: string; passageIds: string[] } } {
  const handle = createDatabase(':memory:');
  const s = handle.sqlite;
  return Object.assign(handle, {
    addPaper(passages: TestPassage[], opts: { active?: boolean; attachmentId?: string } = {}) {
      seq++;
      const att = opts.attachmentId ?? `att${seq}`;
      if (!opts.attachmentId) {
        s.prepare(`INSERT INTO scholarly_works (id, origin, work, title_key, created_at, updated_at) VALUES (?, 'manual', '{}', ?, ?, ?)`).run(`w${seq}`, `w${seq}`, ts, ts);
        s.prepare(`INSERT INTO library_items (id, scholarly_work_id, metadata_status, added_at, updated_at) VALUES (?, ?, 'manual', ?, ?)`).run(`li${seq}`, `w${seq}`, ts, ts);
        s.prepare(
          `INSERT INTO library_attachments (id, library_item_id, file_name, original_file_name, storage_key, mime_type, file_size, sha256, attachment_type, source, created_at, updated_at)
           VALUES (?, ?, 'p.pdf', 'p.pdf', ?, 'application/pdf', 1, ?, 'pdf', 'upload', ?, ?)`,
        ).run(att, `li${seq}`, `objects/aa/aa/${'a'.repeat(64)}.pdf`, `${seq}`.padStart(64, '0'), ts, ts);
      }
      const item = (s.prepare('SELECT library_item_id AS id FROM library_attachments WHERE id = ?').get(att) as { id: string }).id;
      const x = `dex${seq}`;
      s.prepare(
        `INSERT INTO document_extractions (id, attachment_id, library_item_id, scholarly_work_id, source_sha256, extractor, parser_version, segmenter_version, config, config_hash, status, is_active, metadata, quality, processing_started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'w', 'sha', 'grobid', '1', '1', '{}', 'c', 'completed', ?, '{}', '{}', ?, ?, ?)`,
      ).run(x, att, item, opts.active === false ? 0 : 1, ts, ts, ts);
      const ids = passages.map((p, i) => {
        const id = `${x}_p${i}`;
        s.prepare(
          `INSERT INTO document_passages (id, extraction_id, passage_order, kind, section_path, section_type, text, normalized_text, text_hash, stable_key, token_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?)`,
        ).run(id, x, i, p.kind ?? 'body', p.section ?? 'Introduction', p.sectionType ?? 'introduction', p.text, normalizeSearchText(p.text), createHash('sha256').update(p.text).digest('hex'), `${x}-${i}`, ts);
        return id;
      });
      return { extractionId: x, passageIds: ids };
    },
  });
}

/**
 * A deterministic stand-in for an embedding model in tests: hashed word and
 * character-trigram counts. It is lexical, not semantic, and is never used
 * outside tests.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'test-hash';
  readonly local = true;
  readonly maxBatchSize = 16;
  calls: string[][] = [];

  constructor(
    readonly dimensions = 64,
    readonly model = 'hash-64',
  ) {}

  async getModelInfo(): Promise<EmbeddingModelInfo> {
    return { provider: this.id, model: this.model, dimensions: this.dimensions, version: '1' };
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      const norm = normalizeSearchText(t);
      const feats = [...(norm.match(/\p{L}+/gu) ?? []), ...[...norm.replace(/\s+/g, ' ')].map((_, i, a) => a.slice(i, i + 3).join(''))];
      for (const f of feats) {
        const h = createHash('md5').update(f).digest();
        v[h.readUInt16LE(0) % this.dimensions]! += h[2]! & 1 ? 1 : -1;
      }
      if (v.every((x) => x === 0)) v[0] = 1;
      return { vector: v, dimensions: this.dimensions };
    });
  }
}
