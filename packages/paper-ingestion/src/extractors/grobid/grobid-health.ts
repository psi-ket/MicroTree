/** What the runtime knows about the GROBID service right now. */
export interface GrobidHealth {
  status: 'available' | 'initialising' | 'unavailable' | 'disabled' | 'refused';
  version: string | null;
  /** Shown to the user; never contains paths or credentials. */
  message: string | null;
  /** Host of the service; `remote` when it is not this computer. */
  host: string | null;
  remote: boolean;
  checkedAt: string;
}

/**
 * `/api/version` answers plain text (`0.8.2`) in older releases and JSON
 * (`{"version":"0.9.0","revision":"…"}`) in newer ones; both are read.
 */
export function parseGrobidVersion(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { version?: unknown; revision?: unknown };
      const v = typeof parsed.version === 'string' ? parsed.version : null;
      const r = typeof parsed.revision === 'string' && parsed.revision !== v ? parsed.revision : null;
      return v ? (r ? `${v} (${r})` : v) : null;
    } catch {
      return null;
    }
  }
  return /^[\w.+-]{1,64}$/.test(text) ? text : null;
}
