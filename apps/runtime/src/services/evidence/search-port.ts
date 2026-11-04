import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type { EvidenceScopeSchema } from '@research-studio/api-contracts';
import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import { candidateFromHit, type CurrentPassage, type EvidenceSearchPort, type PassageCandidate, type SourceLookup } from '@research-studio/evidence-engine';
import type { ScholarlyWork } from '@research-studio/shared-types';
import type { DocumentRuntime } from '../document-runtime';
import type { LiteratureService } from '../literature-service';

type Scope = z.infer<typeof EvidenceScopeSchema>;

interface PassageRow {
  id: string;
  text_hash: string;
  stable_key: string;
  coordinates: string;
  scholarly_work_id: string | null;
}

/**
 * The evidence engine's view of the library: M3.3 hybrid search (with the
 * request's scope), passage identity and coordinates from the index, stored
 * abstracts of library papers without full text, and optional M3.1
 * literature search. Read-only; nothing here is generated.
 */
export class LibrarySearchPort implements EvidenceSearchPort {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly documents: DocumentRuntime,
    private readonly literature: LiteratureService | null,
    private readonly scope: Scope,
  ) {}

  private details(passageIds: string[]): Map<string, PassageRow> {
    if (!passageIds.length) return new Map();
    const rows = this.sqlite
      .prepare(
        `SELECT p.id, p.text_hash, p.stable_key, p.coordinates, i.scholarly_work_id
         FROM document_passages p JOIN document_extractions e ON e.id = p.extraction_id
         LEFT JOIN library_items i ON i.id = e.library_item_id
         WHERE p.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(passageIds)) as PassageRow[];
    return new Map(rows.map((r) => [r.id, r]));
  }

  async search(q: { query: string; mode: 'keyword' | 'semantic' | 'hybrid'; limit: number }, signal?: AbortSignal) {
    const r = await this.documents.search({ query: q.query, mode: q.mode, scope: this.scope, filters: {}, limit: Math.min(50, q.limit), offset: 0 }, signal ?? new AbortController().signal);
    const d = this.details(r.results.map((x) => x.passageId));
    const candidates = r.results.map((hit) => {
      const row = d.get(hit.passageId);
      return candidateFromHit(hit, { scholarlyWorkId: row?.scholarly_work_id ?? null, textHash: row?.text_hash ?? null, stableKey: row?.stable_key ?? null, coordinates: row ? (JSON.parse(row.coordinates) as DocumentCoordinate[]) : [] });
    });
    return { candidates, semanticUsed: r.semantic.used, warnings: r.warnings };
  }

  async abstracts(terms: readonly string[], limit: number): Promise<PassageCandidate[]> {
    const words = [...new Set(terms.flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}-]+/u)).filter((w) => w.length > 3))];
    if (!words.length) return [];
    const scopeSql =
      this.scope.kind === 'papers'
        ? `AND i.id IN (SELECT value FROM json_each(@ids))`
        : this.scope.kind === 'collections'
          ? `AND i.id IN (SELECT library_item_id FROM library_collection_items WHERE collection_id IN (SELECT value FROM json_each(@ids)))`
          : '';
    const rows = this.sqlite
      .prepare(
        `SELECT i.id AS item_id, w.id AS work_id, w.work AS work FROM library_items i JOIN scholarly_works w ON w.id = i.scholarly_work_id
         WHERE i.archived_at IS NULL AND json_extract(w.work, '$.abstract') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM document_extractions e WHERE e.library_item_id = i.id AND e.is_active = 1) ${scopeSql}
         LIMIT 5000`,
      )
      .all({ ids: JSON.stringify(this.scope.kind === 'papers' ? this.scope.libraryItemIds : this.scope.kind === 'collections' ? this.scope.collectionIds : []) }) as { item_id: string; work_id: string; work: string }[];
    const scored = rows
      .map((r) => {
        const work = JSON.parse(r.work) as ScholarlyWork;
        const hay = `${work.title} ${work.abstract ?? ''}`.toLowerCase();
        return { r, work, n: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.n >= Math.min(2, words.length))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
    return scored.map(({ r, work }, i) => abstractCandidate(work, { level: 'abstract', libraryItemId: r.item_id, scholarlyWorkId: r.work_id, rank: i + 1 }));
  }

  async external(query: string, limit: number, signal?: AbortSignal): Promise<PassageCandidate[]> {
    if (!this.literature) return [];
    const r = await this.literature.search({ query, limit: Math.min(limit, 20) }, signal ?? new AbortController().signal, { saveHistory: false });
    return r.results.filter((x) => x.work.abstract).map((x, i) => abstractCandidate(x.work, { level: 'external_abstract', libraryItemId: null, scholarlyWorkId: null, rank: i + 1 }));
  }

  async neighbours(passageId: string) {
    try {
      const d = this.documents.passageDetail(passageId);
      return { before: d.before.map((p) => p.text), after: d.after.map((p) => p.text) };
    } catch {
      return { before: [], after: [] };
    }
  }

  indexVersion(): string {
    return this.documents.retrievalIndexVersion();
  }
}

function abstractCandidate(work: ScholarlyWork, o: { level: 'abstract' | 'external_abstract'; libraryItemId: string | null; scholarlyWorkId: string | null; rank: number }): PassageCandidate {
  const doi = work.identifiers.doi ?? null;
  const arxiv = work.identifiers.arxivId ?? null;
  return {
    level: o.level,
    passageId: null,
    extractionId: null,
    attachmentId: null,
    libraryItemId: o.libraryItemId,
    scholarlyWorkId: o.scholarlyWorkId,
    externalId: o.level === 'external_abstract' ? work.id : null,
    text: work.abstract ?? '',
    textHash: null,
    stableKey: null,
    sectionPath: null,
    sectionType: 'abstract',
    pageStart: null,
    pageEnd: null,
    coordinates: [],
    sourceSha256: null,
    extractorVersion: null,
    paper: {
      title: work.title,
      authors: work.authors.map((a) => a.name),
      year: work.publicationYear,
      venue: work.venue,
      doi,
      arxivId: arxiv,
      publicationType: work.publicationType,
      url: doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : (work.urls.landingPage ?? null),
    },
    method: o.level === 'abstract' ? 'abstract-match' : 'external-search',
    keywordRank: o.rank,
    semanticRank: null,
    score: null,
  };
}

/** Lookups for freshness checks against the current index and library. */
export function sourceLookup(sqlite: Database.Database): SourceLookup {
  return {
    passage: (id) => {
      const r = sqlite.prepare('SELECT p.id, p.text_hash, p.extraction_id, e.is_active FROM document_passages p JOIN document_extractions e ON e.id = p.extraction_id WHERE p.id = ?').get(id) as { id: string; text_hash: string; extraction_id: string; is_active: number } | undefined;
      return r ? ({ passageId: r.id, textHash: r.text_hash, extractionId: r.extraction_id, active: r.is_active === 1 } satisfies CurrentPassage) : null;
    },
    byStableKey: (attachmentId, stableKey) => {
      const r = sqlite.prepare('SELECT p.id, p.text_hash, p.extraction_id FROM document_passages p JOIN document_extractions e ON e.id = p.extraction_id WHERE e.attachment_id = ? AND e.is_active = 1 AND p.stable_key = ? LIMIT 1').get(attachmentId, stableKey) as { id: string; text_hash: string; extraction_id: string } | undefined;
      return r ? { passageId: r.id, textHash: r.text_hash, extractionId: r.extraction_id, active: true } : null;
    },
    attachmentSha: (attachmentId) => (sqlite.prepare('SELECT sha256 FROM library_attachments WHERE id = ?').get(attachmentId) as { sha256: string } | undefined)?.sha256 ?? null,
  };
}
