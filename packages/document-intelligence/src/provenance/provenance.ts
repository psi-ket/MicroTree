import type { DocumentCoordinate } from '../coordinates/coordinates';
import type { ExtractorId, PassageKind, SectionType } from '../documents/model';

/**
 * Where a piece of retrieved text comes from: which PDF (by hash), which
 * extraction run (extractor, version, configuration), and where in the
 * document. Retrieved text is source data, never an instruction.
 */
export interface PassageProvenance {
  attachmentId: string;
  sourceSha256: string;
  extractionId: string;
  extractor: ExtractorId;
  extractorVersion: string | null;
  parserVersion: string;
  configHash: string;
  extractedAt: string;
  sectionPath: string;
  sectionType: SectionType;
  kind: PassageKind;
  pageStart: number | null;
  pageEnd: number | null;
  coordinates: DocumentCoordinate[];
  /** Original attachment source (`upload`, `open-access`, `zotero`) and its URL when known. */
  attachmentSource: string;
  attachmentSourceUrl: string | null;
  attachmentAddedAt: string;
}

/** Plain identifiers found in reference strings. Matching against works uses exact identifiers only. */
export function findDoi(text: string): string | null {
  const m = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text);
  if (!m) return null;
  return m[1]!.replace(/[.,;:)\]]+$/, '').toLowerCase();
}

export function findArxivId(text: string): string | null {
  const modern = /\barxiv[:\s/]*(\d{4}\.\d{4,5})(v\d+)?\b/i.exec(text) ?? /\barxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(text);
  if (modern) return modern[1]!;
  const old = /\barxiv[:\s/]*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})\b/i.exec(text);
  return old ? old[1]!.toLowerCase() : null;
}
