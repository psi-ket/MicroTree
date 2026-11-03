import { diceSimilarity, familyKey, normalizeDoi, parseArxivId, titleKey } from '@research-studio/literature-engine';
import type { ScholarlyWork } from '@research-studio/shared-types';
import type { ImportedReference } from '../library/library-types';
import type { LibraryRepository, WorkRow } from '../library/library-repository';

/**
 * How an incoming work relates to one already in the library.
 * - `identical`: same DOI, arXiv ID or provider ID: the same work; never added twice.
 * - `likely`: same title and the same first author or year, but no shared
 *   identifier. Reported to the user; never merged on its own.
 */
export interface DuplicateHit {
  workId: string;
  kind: 'identical' | 'likely';
  reason: string;
}

export interface Fingerprint {
  canonicalId: string | null;
  doi: string | null;
  arxivId: string | null;
  title: string;
  firstAuthorKey: string | null;
  year: number | null;
}

export function fingerprintOfWork(work: ScholarlyWork, canonical: boolean): Fingerprint {
  const first = work.authors[0];
  return {
    canonicalId: canonical ? work.id : null,
    doi: work.identifiers.doi,
    arxivId: work.identifiers.arxivId,
    title: work.title,
    firstAuthorKey: first ? familyKey(first) : null,
    year: work.publicationYear,
  };
}

export function fingerprintOfReference(ref: ImportedReference): Fingerprint {
  const first = ref.authors[0];
  return {
    canonicalId: null,
    doi: ref.doi ? normalizeDoi(ref.doi) : null,
    arxivId: ref.arxivId ? (parseArxivId(ref.arxivId)?.id ?? null) : null,
    title: ref.title ?? '',
    firstAuthorKey: first ? familyKey({ name: first.name ?? '', familyName: first.familyName }) : null,
    year: ref.publicationYear,
  };
}

function likely(row: WorkRow, fp: Fingerprint, key: string): DuplicateHit | null {
  const sameTitle = row.titleKey === key || (key.length >= 20 && diceSimilarity(row.titleKey, key) >= 0.93);
  if (!sameTitle) return null;
  // Different identifiers on both sides mean different works (e.g. a preprint and its erratum).
  if (fp.doi && row.doi && fp.doi !== row.doi) return null;
  const author = !!fp.firstAuthorKey && fp.firstAuthorKey === row.firstAuthorKey;
  const year = fp.year !== null && row.year !== null && Math.abs(fp.year - row.year) <= 1;
  if (!author && !year) return null;
  const why = [author ? 'first author' : null, year ? 'year' : null].filter(Boolean).join(' and ');
  return { workId: row.id, kind: 'likely', reason: `Same title and ${why}` };
}

export class LibraryDeduplicator {
  constructor(private readonly repo: LibraryRepository) {}

  /** The library work that is certainly the same, if any. */
  identical(fp: Fingerprint): DuplicateHit | null {
    const byCanonical = fp.canonicalId ? this.repo.findWorkByCanonical(fp.canonicalId) : null;
    if (byCanonical) return { workId: byCanonical.id, kind: 'identical', reason: 'Already in the library' };
    const byDoi = fp.doi ? this.repo.findWorkByDoi(fp.doi) : null;
    if (byDoi) return { workId: byDoi.id, kind: 'identical', reason: `Same DOI (${fp.doi})` };
    const byArxiv = fp.arxivId ? this.repo.findWorkByArxiv(fp.arxivId) : null;
    if (byArxiv) return { workId: byArxiv.id, kind: 'identical', reason: `Same arXiv ID (${fp.arxivId})` };
    return null;
  }

  /** Likely duplicates by title, first author and year (excluding `exceptWorkId`). */
  likely(fp: Fingerprint, exceptWorkId?: string): DuplicateHit[] {
    const key = titleKey(fp.title);
    if (key.length < 8) return [];
    const rows = new Map<string, WorkRow>();
    for (const r of this.repo.findWorksByTitleKey(key)) rows.set(r.id, r);
    for (const r of this.repo.findWorksByTitlePrefix(key.split(' ').slice(0, 3).join(' '))) rows.set(r.id, r);
    const hits: DuplicateHit[] = [];
    for (const row of rows.values()) {
      if (row.id === exceptWorkId) continue;
      const hit = likely(row, fp, key);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  /** Every group of works in the library that look like the same paper. */
  scan(): { workIds: string[]; reason: string }[] {
    const groups: { workIds: string[]; reason: string }[] = [];
    const seen = new Set<string>();
    for (const w of this.repo.workKeys()) {
      if (seen.has(w.id)) continue;
      const hits = this.likely({ canonicalId: null, doi: w.doi, arxivId: w.arxivId, title: w.titleKey, firstAuthorKey: w.firstAuthorKey, year: w.year }, w.id).filter(
        (h) => !seen.has(h.workId),
      );
      if (!hits.length) continue;
      const ids = [w.id, ...hits.map((h) => h.workId)];
      ids.forEach((id) => seen.add(id));
      groups.push({ workIds: ids, reason: hits[0]!.reason });
    }
    return groups;
  }
}
