import type { ScholarlyWork } from '@research-studio/shared-types';
import { emptyReference } from '../../src/library/library-types';
import { workFromReference } from '../../src/metadata/metadata-merger';

export const NOW = '2026-11-03T10:00:00.000Z';

/** A provider-style work for tests (the ID looks canonical; there are no source records). */
export function fakeWork(p: {
  id?: string;
  title: string;
  authors?: [given: string, family: string][];
  year?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  venue?: string | null;
  pdfUrl?: string | null;
  publicationType?: ScholarlyWork['publicationType'];
}): ScholarlyWork {
  const ref = {
    ...emptyReference('manual'),
    title: p.title,
    authors: (p.authors ?? []).map(([givenName, familyName]) => ({ givenName, familyName, name: null })),
    publicationYear: p.year ?? null,
    doi: p.doi ?? null,
    arxivId: p.arxivId ?? null,
    venue: p.venue ?? null,
    publicationType: p.publicationType ?? null,
  };
  const w = workFromReference(ref, 'x', NOW);
  const id = p.id ?? (p.doi ? `doi:${p.doi}` : p.arxivId ? `arxiv:${p.arxivId}` : `openalex:W${Math.abs(hash(p.title))}`);
  return { ...w, id, openAccess: { ...w.openAccess, pdfUrl: p.pdfUrl ?? null } };
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
