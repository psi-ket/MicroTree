/**
 * Versions that make an extraction reproducible. A stored extraction is
 * still valid only when the PDF hash, the extractor and its version, the
 * parser version and the configuration all match; any change means the
 * document should be reprocessed (the old extraction stays active until the
 * new one has been checked and activated).
 */

/** Version of the TEI/PyMuPDF normalisers in this repository. Bump on any change to their output. */
export const PARSER_VERSION = '1.0.0';
/** Version of passage segmentation. Bump when passages would change. */
export const SEGMENTER_VERSION = '1.0.0';

export interface ExtractionFingerprint {
  sourceSha256: string;
  extractor: string;
  extractorVersion: string | null;
  parserVersion: string;
  configHash: string;
}

export type StaleReason = 'source-changed' | 'extractor-changed' | 'extractor-version-changed' | 'parser-changed' | 'config-changed';

/** Why an existing extraction no longer matches what a new run would produce (empty: still valid). */
export function staleReasons(existing: ExtractionFingerprint, wanted: Partial<ExtractionFingerprint>): StaleReason[] {
  const out: StaleReason[] = [];
  if (wanted.sourceSha256 !== undefined && wanted.sourceSha256 !== existing.sourceSha256) out.push('source-changed');
  if (wanted.extractor !== undefined && wanted.extractor !== existing.extractor) out.push('extractor-changed');
  if (wanted.extractorVersion !== undefined && wanted.extractorVersion !== null && wanted.extractorVersion !== existing.extractorVersion) {
    out.push('extractor-version-changed');
  }
  if (wanted.parserVersion !== undefined && wanted.parserVersion !== existing.parserVersion) out.push('parser-changed');
  if (wanted.configHash !== undefined && wanted.configHash !== existing.configHash) out.push('config-changed');
  return out;
}

/** JSON with sorted keys, so equal configurations hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
