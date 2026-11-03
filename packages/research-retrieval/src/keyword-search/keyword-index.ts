import type Database from 'better-sqlite3';
import { normalizeSearchText, type PassageKind, type SectionType } from '@research-studio/document-intelligence';
import { toFtsExpression, type ParsedQuery } from '../query/query-parser';

export interface PassageFilter {
  /** Extractions to search; null = all active extractions. */
  extractionIds: readonly string[] | null;
  kinds: readonly PassageKind[];
  sectionTypes: readonly SectionType[];
}

export interface RankedHit {
  passageId: string;
  extractionId: string;
  rank: number;
  score: number;
}

/**
 * Keyword retrieval over `passage_fts` (FTS5, BM25). The index holds the
 * normalised search text and the normalised section path; the original text
 * stays in `document_passages`. Only active extractions are searched.
 */
export class KeywordIndex {
  constructor(private readonly sqlite: Database.Database) {}

  /** Index all passages of an extraction (idempotent). */
  indexExtraction(extractionId: string): number {
    const rows = this.sqlite
      .prepare('SELECT id, normalized_text, section_path, kind, section_type FROM document_passages WHERE extraction_id = ? ORDER BY passage_order')
      .all(extractionId) as { id: string; normalized_text: string; section_path: string; kind: string; section_type: string }[];
    const del = this.sqlite.prepare('DELETE FROM passage_fts WHERE extraction_id = ?');
    const ins = this.sqlite.prepare('INSERT INTO passage_fts (body, heading, passage_id, extraction_id, kind, section_type) VALUES (?, ?, ?, ?, ?, ?)');
    this.sqlite.transaction(() => {
      del.run(extractionId);
      for (const r of rows) ins.run(r.normalized_text, normalizeSearchText(r.section_path), r.id, extractionId, r.kind, r.section_type);
    })();
    return rows.length;
  }

  removeExtraction(extractionId: string): void {
    this.sqlite.prepare('DELETE FROM passage_fts WHERE extraction_id = ?').run(extractionId);
  }

  count(): number {
    return (this.sqlite.prepare('SELECT COUNT(*) AS n FROM passage_fts').get() as { n: number }).n;
  }

  search(q: ParsedQuery, filter: PassageFilter, limit: number, any = false): RankedHit[] {
    const expr = toFtsExpression(q, any);
    if (!expr) return [];
    const where: string[] = ['passage_fts MATCH @expr', 'x.is_active = 1'];
    const params: Record<string, unknown> = { expr, limit };
    if (filter.extractionIds) {
      where.push('f.extraction_id IN (SELECT value FROM json_each(@ids))');
      params.ids = JSON.stringify(filter.extractionIds);
    }
    if (filter.kinds.length) {
      where.push('f.kind IN (SELECT value FROM json_each(@kinds))');
      params.kinds = JSON.stringify(filter.kinds);
    }
    if (filter.sectionTypes.length) {
      where.push('f.section_type IN (SELECT value FROM json_each(@sections))');
      params.sections = JSON.stringify(filter.sectionTypes);
    }
    // bm25 weights: body 1.0, heading 0.4. Lower bm25 is better; ties broken by passage ID for reproducibility.
    const rows = this.sqlite
      .prepare(
        `SELECT f.passage_id AS passageId, f.extraction_id AS extractionId, bm25(passage_fts, 1.0, 0.4) AS score
         FROM passage_fts f JOIN document_extractions x ON x.id = f.extraction_id
         WHERE ${where.join(' AND ')}
         ORDER BY score ASC, f.passage_id ASC LIMIT @limit`,
      )
      .all(params) as { passageId: string; extractionId: string; score: number }[];
    return rows.map((r, i) => ({ ...r, rank: i + 1, score: -r.score }));
  }
}
