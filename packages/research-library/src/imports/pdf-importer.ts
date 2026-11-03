import type { ImportItemResult, LibraryAttachment, MatchConfidence } from '@research-studio/shared-types';
import type { ValidatedFile } from '../attachments/attachment-service';
import { LibraryCancelledError } from '../errors/library-errors';
import { emptyReference, type ImportedReference } from '../library/library-types';
import type { AddOptions, LibraryService } from '../library/library-service';
import { identifiersFromPdf } from '../metadata/identifier-extractor';
import { resolvePdf, type ResolveOutcome } from '../metadata/metadata-resolver';
import type { PdfMetadata } from '../metadata/pdf-metadata';

export interface PdfImportOptions {
  /** Attach to this item instead of identifying the paper. */
  targetItemId?: string | null;
  /** Look the paper up through the literature engine (default true when available). */
  resolve?: boolean;
  add?: AddOptions;
  source?: 'upload' | 'open-access';
  sourceUrl?: string | null;
  signal?: AbortSignal;
}

export interface PdfImportResult extends ImportItemResult {
  attachment: LibraryAttachment | null;
}

/** The record kept for a PDF that no provider identified: only what the file states. */
export function referenceFromPdf(meta: PdfMetadata, fileName: string): ImportedReference {
  const ids = identifiersFromPdf(meta);
  const stem = fileName.replace(/\.pdf$/i, '').trim();
  return {
    ...emptyReference('pdf'),
    title: ids.metadataTitle ?? (stem || 'Untitled PDF'),
    // Only authors the file's metadata names; nothing is guessed from the page text.
    authors: ids.authors.map((name) => ({ givenName: null, familyName: null, name })),
    doi: ids.dois.find((d) => d.source === 'pdf-metadata')?.value ?? null,
    arxivId: ids.arxivIds.find((a) => a.source === 'pdf-metadata')?.value ?? null,
    localSource: {
      format: 'pdf',
      fileName,
      titleSource: ids.metadataTitle ? 'pdf-metadata' : 'file-name',
      pageCount: meta.pageCount,
      info: meta.info,
      xmp: meta.xmp,
      identifiersInText: { dois: ids.dois.filter((d) => d.source === 'pdf-text').map((d) => d.value), arxivIds: ids.arxivIds.filter((a) => a.source === 'pdf-text').map((a) => a.value) },
    },
  };
}

/**
 * Import one validated PDF: attach it to a chosen item, or identify the paper
 * (identifiers, then title search) and add it. Only an exact identifier match
 * is applied without asking; anything weaker is kept as an item that needs
 * review, with the candidates, so the user decides. The temporary file is
 * always consumed (stored or discarded).
 */
export async function importPdf(library: LibraryService, file: ValidatedFile, options: PdfImportOptions = {}): Promise<PdfImportResult> {
  const label = file.originalFileName;
  const attachTo = async (itemId: string) =>
    (await library.attachments.attach(itemId, file, { attachmentType: 'pdf', source: options.source ?? 'upload', sourceUrl: options.sourceUrl ?? null })).attachment;
  try {
    if (options.signal?.aborted) throw new LibraryCancelledError();
    if (options.targetItemId) {
      await library.getItem(options.targetItemId);
      const attachment = await attachTo(options.targetItemId);
      return { label, outcome: 'attached', libraryItemId: options.targetItemId, confidence: null, message: null, attachment };
    }

    // The same file is already in the library.
    const same = library.repo.attachmentsByHash(file.temp.sha256)[0];
    if (same) {
      await library.attachments.discard(file);
      return { label, outcome: 'duplicate', libraryItemId: same.libraryItemId, confidence: null, message: 'This PDF is already in the library', attachment: null };
    }

    const meta = file.pdf;
    if (!meta) throw new Error('Not a PDF');
    let outcome: ResolveOutcome | null = null;
    let problems: string[] = [];
    if ((options.resolve ?? true) && library.hasLookup) {
      outcome = await resolvePdf(meta, file.originalFileName, library.lookup, options.signal);
      problems = outcome.problems;
    }
    const ref = referenceFromPdf(meta, file.originalFileName);
    const added = await library.addReference(ref, outcome, options.add);
    let attachment: LibraryAttachment;
    try {
      attachment = await attachTo(added.item.id);
    } catch (err) {
      // An item created for this PDF is not left behind without it.
      if (added.created) await library.deleteItems([added.item.id]);
      throw err;
    }
    const confidence: MatchConfidence | null = outcome?.confidence ?? null;
    if (!added.created) {
      return { label, outcome: 'attached', libraryItemId: added.item.id, confidence, message: `Matched a paper already in the library (${added.duplicateReason})`, attachment };
    }
    const status = added.item.metadataStatus;
    const note = problems.length ? ` Some sources did not answer: ${problems.join('; ')}` : '';
    if (status === 'resolved') return { label, outcome: 'added', libraryItemId: added.item.id, confidence, message: null, attachment };
    if (status === 'needs-review') {
      return { label, outcome: 'needs-review', libraryItemId: added.item.id, confidence, message: `Possible matches found; choose the right one.${note}`, attachment };
    }
    return {
      label,
      outcome: 'unresolved',
      libraryItemId: added.item.id,
      confidence,
      message: `${library.hasLookup ? 'No matching record was found' : 'Scholarly search is not available'}; the paper was added with the details in the file.${note}`,
      attachment,
    };
  } catch (err) {
    await library.attachments.discard(file);
    throw err;
  }
}
