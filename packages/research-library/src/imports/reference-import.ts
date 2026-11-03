import { normalizeDoi, parseArxivId } from '@research-studio/literature-engine';
import type { ImportItemResult } from '@research-studio/shared-types';
import { fingerprintOfReference } from '../deduplication/library-deduplicator';
import { LibraryCancelledError } from '../errors/library-errors';
import type { AddOptions, LibraryService } from '../library/library-service';
import type { ImportedReference, ParsedImport } from '../library/library-types';
import { resolveReference } from '../metadata/metadata-resolver';
import type { JobContext } from './import-jobs';
import { importBibtex } from './bibtex-importer';
import { importRis } from './ris-importer';

export type ReferenceFormat = 'bibtex' | 'ris';

/** Largest BibTeX/RIS text accepted in one import. */
export const MAX_REFERENCE_FILE_BYTES = 20 * 1024 * 1024;

export function parseReferences(format: ReferenceFormat, text: string): ParsedImport {
  return format === 'bibtex' ? importBibtex(text) : importRis(text);
}

export interface ReferencePreviewEntry {
  index: number;
  label: string;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  citationKey: string | null;
  /** `new`, `duplicate` (same identifier as a library item), `likely-duplicate` (same title and author/year), `invalid` (no title). */
  state: 'new' | 'duplicate' | 'likely-duplicate' | 'invalid';
  libraryItemId: string | null;
  reason: string | null;
}

export interface ReferencePreview {
  format: ReferenceFormat;
  entries: ReferencePreviewEntry[];
  warnings: string[];
}

function labelOf(ref: ImportedReference, index: number): string {
  return ref.citationKey ?? `Record ${index + 1}`;
}

/** What an import would do, without writing anything. */
export function previewReferences(library: LibraryService, format: ReferenceFormat, text: string): ReferencePreview {
  const { references, warnings } = parseReferences(format, text);
  const entries = references.map((ref, index): ReferencePreviewEntry => {
    const fp = fingerprintOfReference(ref);
    const base = {
      index,
      label: labelOf(ref, index),
      title: ref.title,
      authors: ref.authors.map((a) => a.name ?? [a.givenName, a.familyName].filter(Boolean).join(' ')).slice(0, 5),
      year: ref.publicationYear,
      doi: ref.doi,
      arxivId: ref.arxivId,
      citationKey: ref.citationKey,
    };
    if (!ref.title?.trim()) return { ...base, state: 'invalid', libraryItemId: null, reason: 'The record has no title' };
    const same = library.dedup.identical(fp);
    if (same) return { ...base, state: 'duplicate', libraryItemId: library.repo.getItemByWork(same.workId)?.id ?? null, reason: same.reason };
    const likely = library.dedup.likely(fp)[0];
    if (likely) return { ...base, state: 'likely-duplicate', libraryItemId: library.repo.getItemByWork(likely.workId)?.id ?? null, reason: likely.reason };
    return { ...base, state: 'new', libraryItemId: null, reason: null };
  });
  return { format, entries, warnings: warnings.map((w) => (w.line ? `Line ${w.line}: ${w.message}` : w.message)) };
}

export interface ReferenceImportOptions {
  /** Indices (from the preview) to import; all when omitted. */
  only?: number[];
  /** Look identifiers up through the literature engine (exact matches only are applied). */
  resolveIdentifiers: boolean;
  /** Also search by title for records without identifiers (slower; results wait for review). */
  searchTitles: boolean;
  add?: AddOptions;
}

/** Import parsed references inside a job, one at a time. */
export async function runReferenceImport(library: LibraryService, refs: ImportedReference[], options: ReferenceImportOptions, ctx: JobContext): Promise<void> {
  const chosen = options.only ? options.only.filter((i) => i >= 0 && i < refs.length) : refs.map((_, i) => i);
  ctx.setTotal(chosen.length);
  for (const index of chosen) {
    if (ctx.signal.aborted) throw new LibraryCancelledError();
    const ref = refs[index]!;
    const label = labelOf(ref, index);
    try {
      const wantsLookup = library.hasLookup && ((options.resolveIdentifiers && (ref.doi || ref.arxivId)) || options.searchTitles);
      const outcome = wantsLookup
        ? await resolveReference(ref, library.lookup, { searchTitle: options.searchTitles }, ctx.signal)
        : null;
      const added = await library.addReference(ref, outcome, options.add);
      const result: ImportItemResult = !added.created
        ? { label, outcome: 'duplicate', libraryItemId: added.item.id, confidence: outcome?.confidence ?? null, message: added.duplicateReason }
        : {
            label,
            outcome: added.item.metadataStatus === 'needs-review' ? 'needs-review' : 'added',
            libraryItemId: added.item.id,
            confidence: outcome?.confidence ?? null,
            message: [...added.notices, ...(added.likelyDuplicates.length ? ['Looks like a paper already in the library'] : []), ...(outcome?.problems ?? [])].join('; ') || null,
          };
      ctx.record(result);
    } catch (err) {
      if (ctx.signal.aborted) throw new LibraryCancelledError();
      ctx.record({ label, outcome: 'failed', libraryItemId: null, confidence: null, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Parse a list of DOIs and arXiv IDs (one per line, or separated by spaces, commas or semicolons). */
export function parseIdentifierList(text: string): { kind: 'doi' | 'arxiv'; value: string; raw: string }[] {
  const out: { kind: 'doi' | 'arxiv'; value: string; raw: string }[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const arxiv = /^(arxiv:|https?:\/\/arxiv\.org\/)/i.test(raw) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(raw) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(raw);
    const value = arxiv ? (parseArxivId(raw)?.id ?? null) : normalizeDoi(raw);
    const kind = arxiv ? 'arxiv' : 'doi';
    if (!value) {
      out.push({ kind, value: '', raw });
      continue;
    }
    if (seen.has(`${kind}:${value}`)) continue;
    seen.add(`${kind}:${value}`);
    out.push({ kind, value, raw });
  }
  return out.slice(0, 500);
}

/** Add papers by identifier inside a job. */
export async function runIdentifierImport(library: LibraryService, ids: ReturnType<typeof parseIdentifierList>, add: AddOptions | undefined, ctx: JobContext): Promise<void> {
  ctx.setTotal(ids.length);
  for (const id of ids) {
    if (ctx.signal.aborted) throw new LibraryCancelledError();
    if (!id.value) {
      ctx.record({ label: id.raw, outcome: 'failed', libraryItemId: null, confidence: null, message: 'Not a DOI or arXiv identifier' });
      continue;
    }
    try {
      const r = await library.addByIdentifier(id.kind, id.value, add, ctx.signal);
      ctx.record({
        label: id.raw,
        outcome: r.created ? 'added' : 'duplicate',
        libraryItemId: r.item.id,
        confidence: id.kind === 'doi' ? 'exact-doi' : 'exact-arxiv',
        message: r.created ? null : r.duplicateReason,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw new LibraryCancelledError();
      ctx.record({ label: id.raw, outcome: 'failed', libraryItemId: null, confidence: null, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
