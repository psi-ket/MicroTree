import { ExtractionError } from '../../errors/extraction-errors';

/** Structures GROBID can report coordinates for (GROBID docs, "Coordinates in PDF"). */
export const GROBID_COORDINATE_ELEMENTS = ['head', 'p', 's', 'figure', 'formula', 'ref', 'biblStruct', 'note', 'title', 'persName'] as const;

export interface GrobidConfiguration {
  /** e.g. `http://127.0.0.1:8070`. Comes from the operator's environment, never from the browser. */
  baseUrl: string;
  /** A non-loopback host is refused unless this is set: PDFs would leave the machine. */
  allowRemote: boolean;
  timeoutMs: number;
  /** Concurrent requests to GROBID. */
  concurrency: number;
  /** Retries for 503 (busy), connection failures and timeouts. Permanent errors are never retried. */
  maxRetries: number;
  /** Wait before re-sending after a 503 (GROBID suggests 5 to 10 s for full text). */
  busyRetryDelayMs: number;
  /**
   * Consolidation calls external services (Crossref, biblio-glutton) from the
   * GROBID server. Off (`0`) by default; GROBID's own default for the header
   * is `1`, so it is always sent explicitly.
   */
  consolidateHeader: 0 | 1 | 2 | 3;
  consolidateCitations: 0 | 1 | 2;
  consolidateFunders: 0 | 1 | 2;
  includeRawCitations: boolean;
  segmentSentences: boolean;
  teiCoordinates: readonly string[];
}

export const DEFAULT_GROBID_CONFIGURATION: GrobidConfiguration = {
  baseUrl: 'http://127.0.0.1:8070',
  allowRemote: false,
  timeoutMs: 180_000,
  concurrency: 2,
  maxRetries: 3,
  busyRetryDelayMs: 6_000,
  consolidateHeader: 0,
  consolidateCitations: 0,
  consolidateFunders: 0,
  includeRawCitations: true,
  segmentSentences: true,
  teiCoordinates: GROBID_COORDINATE_ELEMENTS,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True for `http(s)` URLs on this computer (127.0.0.0/8, localhost, ::1). */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return LOOPBACK.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Validate a service URL: http(s), no credentials, loopback unless remote use was allowed. */
export function checkServiceUrl(value: string, allowRemote: boolean, service: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtractionError('unavailable', `${service}: the configured URL is not valid`, service, false);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ExtractionError('unavailable', `${service}: only http and https URLs are allowed`, service, false);
  if (url.username || url.password) throw new ExtractionError('unavailable', `${service}: URLs with credentials are not allowed`, service, false);
  if (!allowRemote && !isLoopbackUrl(value)) {
    throw new ExtractionError('unavailable', `${service} is configured on another computer (${url.host}); allow remote processing explicitly to send PDFs there`, service, false);
  }
  return value.replace(/\/+$/, '');
}

/** The settings that change GROBID's output, for the extraction's configuration hash. */
export function grobidOutputSettings(c: GrobidConfiguration) {
  return {
    consolidateHeader: c.consolidateHeader,
    consolidateCitations: c.consolidateCitations,
    consolidateFunders: c.consolidateFunders,
    includeRawCitations: c.includeRawCitations,
    segmentSentences: c.segmentSentences,
    teiCoordinates: [...c.teiCoordinates].sort(),
  };
}

/** Multipart fields for `/api/processFulltextDocument` (besides `input`). */
export function grobidFormFields(c: GrobidConfiguration): [string, string][] {
  const fields: [string, string][] = [
    ['consolidateHeader', String(c.consolidateHeader)],
    ['consolidateCitations', String(c.consolidateCitations)],
    ['consolidateFunders', String(c.consolidateFunders)],
    ['includeRawCitations', c.includeRawCitations ? '1' : '0'],
  ];
  if (c.segmentSentences) fields.push(['segmentSentences', '1']);
  for (const el of c.teiCoordinates) fields.push(['teiCoordinates', el]);
  return fields;
}
