/**
 * Dates are kept at the precision the provider gave: `YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD`. Nothing is padded with invented months or days.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function valid(year: number, month?: number, day?: number): boolean {
  if (!Number.isInteger(year) || year < 1000 || year > 2999) return false;
  if (month === undefined) return true;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (day === undefined) return true;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Crossref `{ "date-parts": [[2019, 3, 5]] }` (parts may be missing or null). */
export function fromDateParts(parts: unknown): string | null {
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
  const [y, m, d] = (parts[0] as unknown[]).map((p) => (typeof p === 'number' ? p : typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : null));
  if (y === null || y === undefined || !valid(y)) return null;
  if (m === null || m === undefined || !valid(y, m)) return String(y);
  if (d === null || d === undefined || !valid(y, m, d)) return `${y}-${pad(m)}`;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** `2019`, `2019-03`, `2019-03-05`, or an ISO timestamp (date part kept). */
export function normalizeDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : undefined;
  const d = m[3] ? Number(m[3]) : undefined;
  if (!valid(y, mo, d)) return valid(y) ? String(y) : null;
  return d !== undefined ? `${y}-${pad(mo!)}-${pad(d)}` : mo !== undefined ? `${y}-${pad(mo)}` : String(y);
}

export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return valid(y) ? y : null;
}

export function normalizeYear(input: unknown): number | null {
  const y = typeof input === 'number' ? input : typeof input === 'string' && /^\d{4}$/.test(input.trim()) ? Number(input) : NaN;
  return valid(y) ? y : null;
}

/** Compare partial dates; a less precise date sorts before a more precise one with the same prefix. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
