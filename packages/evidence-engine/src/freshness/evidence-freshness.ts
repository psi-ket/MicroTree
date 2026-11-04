/** What is stored about the source of an evidence record. */
export interface StoredSourceRef {
  passageId: string | null;
  attachmentId: string | null;
  stableKey: string | null;
  passageTextHash: string | null;
  sourceSha256: string | null;
  extractionId: string | null;
}

export interface CurrentPassage {
  passageId: string;
  textHash: string;
  extractionId: string;
  active: boolean;
}

/** Lookups into the current library and index (implemented by the runtime). */
export interface SourceLookup {
  passage(passageId: string): CurrentPassage | null;
  /** The passage with this stable key in the attachment's active extraction. */
  byStableKey(attachmentId: string, stableKey: string): CurrentPassage | null;
  attachmentSha(attachmentId: string): string | null;
}

export type SourceFreshness =
  | { state: 'fresh' }
  | { state: 'moved'; passageId: string; reason: string }
  | { state: 'source_changed'; reason: string }
  | { state: 'source_missing'; reason: string };

/**
 * Is the stored source still what is in the library? Compares the PDF
 * checksum, the extraction and the passage hash. A reprocessed PDF whose
 * passage text is unchanged is `moved` (new passage ID, same words); a
 * changed text or PDF is `source_changed`; a removed paper is
 * `source_missing`. Abstract-level sources have no passage to check.
 */
export function checkSourceFreshness(s: StoredSourceRef, lookup: SourceLookup): SourceFreshness {
  if (!s.passageId || !s.attachmentId) return { state: 'fresh' };
  const sha = lookup.attachmentSha(s.attachmentId);
  if (sha === null) return { state: 'source_missing', reason: 'The PDF is no longer in the library.' };
  if (s.sourceSha256 && sha !== s.sourceSha256) return { state: 'source_changed', reason: 'The PDF file was replaced.' };
  const p = lookup.passage(s.passageId);
  if (p && p.active) return p.textHash === s.passageTextHash || !s.passageTextHash ? { state: 'fresh' } : { state: 'source_changed', reason: 'The passage text changed.' };
  if (s.stableKey) {
    const moved = lookup.byStableKey(s.attachmentId, s.stableKey);
    if (moved && (!s.passageTextHash || moved.textHash === s.passageTextHash)) return { state: 'moved', passageId: moved.passageId, reason: 'The PDF was processed again; the passage text is unchanged.' };
    if (moved) return { state: 'source_changed', reason: 'The PDF was processed again and the passage text changed.' };
  }
  return { state: 'source_changed', reason: 'The PDF was processed again and this passage was not found in the new extraction.' };
}
