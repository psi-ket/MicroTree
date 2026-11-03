/**
 * Identifier normalisation. Every function returns `null` for input that is
 * not a valid identifier of its kind; nothing is guessed.
 */

const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/;
const DOI_PREFIXES = [/^doi:\s*/i, /^info:doi\//i, /^https?:\/\/(?:dx\.)?doi\.org\//i, /^(?:dx\.)?doi\.org\//i];
const TRAILING_PUNCTUATION = /[.,;:'"!?]+$/;

/** Strip `)`/`]`/`}` at the end only when they are unbalanced (DOIs may contain parentheses). */
function trimUnbalancedClosers(value: string): string {
  let v = value;
  for (;;) {
    const last = v.at(-1);
    const open = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null;
    if (!open || !last) return v;
    const opens = v.split(open).length - 1;
    const closes = v.split(last).length - 1;
    if (closes <= opens) return v;
    v = v.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
}

/**
 * Normalise a DOI: drop `doi:`, `info:doi/` and `https://doi.org/` prefixes,
 * surrounding whitespace, angle brackets and trailing punctuation, decode
 * percent-escapes, and lower-case it (DOIs are case-insensitive).
 */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().replace(/^<|>$/g, '').trim();
  for (const prefix of DOI_PREFIXES) v = v.replace(prefix, '');
  if (/%[0-9a-f]{2}/i.test(v)) {
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  v = v.replace(/\s+/g, '');
  v = trimUnbalancedClosers(v.replace(TRAILING_PUNCTUATION, ''));
  v = v.toLowerCase();
  return DOI_SHAPE.test(v) && v.length <= 300 ? v : null;
}

export interface ArxivIdentifier {
  /** Identifier without version: `2106.15928` or `quant-ph/9605011`. */
  id: string;
  /** `v2`, or null when the input named no version. */
  version: string | null;
}

/** Archives that used old-style (pre-April 2007) identifiers. */
const OLD_ARCHIVES = new Set([
  'acc-phys', 'adap-org', 'alg-geom', 'ao-sci', 'astro-ph', 'atom-ph', 'bayes-an', 'chao-dyn', 'chem-ph', 'cmp-lg',
  'comp-gas', 'cond-mat', 'cs', 'dg-ga', 'funct-an', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'math',
  'math-ph', 'mtrl-th', 'nlin', 'nucl-ex', 'nucl-th', 'patt-sol', 'physics', 'plasm-ph', 'q-alg', 'q-bio', 'quant-ph',
  'solv-int', 'supr-con',
]);

const NEW_STYLE = /^(\d{2})(\d{2})\.(\d{4,5})(v\d+)?$/;
const OLD_STYLE = /^([a-z-]+)(\.[a-z]{2})?\/(\d{7})(v\d+)?$/i;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/;

/**
 * Parse an arXiv identifier from a bare ID, `arXiv:` prefix, abstract/PDF URL
 * or arXiv DOI (`10.48550/arXiv.…`). New-style IDs use four digits after the
 * dot up to 1412 and five from 1501. Old-style IDs drop the subject class
 * (`math.GT/0309136` → `math/0309136`).
 */
export function parseArxivId(input: string | null | undefined): ArxivIdentifier | null {
  if (!input) return null;
  let v = input.trim();
  const doi = normalizeDoi(v);
  if (doi) {
    const m = ARXIV_DOI.exec(doi);
    if (!m?.[1]) return null;
    v = m[1];
  }
  v = v
    .replace(/^arxiv:\s*/i, '')
    .replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

  const n = NEW_STYLE.exec(v);
  if (n) {
    const [, yy, mm, num, version] = n;
    const month = Number(mm);
    if (month < 1 || month > 12) return null;
    const yymm = Number(`${yy}${mm}`);
    if (yymm < 704) return null;
    if ((yymm < 1501 && num!.length !== 4) || (yymm >= 1501 && num!.length !== 5)) return null;
    return { id: `${yy}${mm}.${num}`, version: version ?? null };
  }
  const o = OLD_STYLE.exec(v);
  if (o) {
    const archive = o[1]!.toLowerCase();
    if (!OLD_ARCHIVES.has(archive)) return null;
    const month = Number(o[3]!.slice(2, 4));
    if (month < 1 || month > 12) return null;
    return { id: `${archive}/${o[3]}`, version: o[4] ?? null };
  }
  return null;
}

/** The DataCite DOI arXiv assigns to every paper. */
export function arxivDoi(arxivId: string): string {
  return `10.48550/arxiv.${arxivId.toLowerCase()}`;
}

/** `W2741809807`, `https://openalex.org/W2741809807`, `openalex:W…` → `W2741809807` (works); `A…` for authors. */
export function normalizeOpenAlexId(input: string | null | undefined, kind: 'W' | 'A' = 'W'): string | null {
  if (!input) return null;
  const v = input.trim().replace(/^openalex:/i, '').replace(/^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/|authors\/)?/i, '');
  const m = /^([WA])(\d{1,12})$/i.exec(v);
  return m && m[1]!.toUpperCase() === kind ? `${kind}${m[2]}` : null;
}

/** Semantic Scholar paper IDs are 40-character hex hashes. */
export function normalizeSemanticScholarId(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().replace(/^semantic-scholar:/i, '').replace(/^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^/]+\/)?/i, '');
  return /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null;
}

/** ORCID iD in bare form, checksum verified (ISO 7064 11,2). */
export function normalizeOrcid(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').toUpperCase();
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(v)) return null;
  const digits = v.replace(/-/g, '');
  let total = 0;
  for (const ch of digits.slice(0, 15)) total = (total + Number(ch)) * 2;
  const check = (12 - (total % 11)) % 11;
  const expected = check === 10 ? 'X' : String(check);
  return digits[15] === expected ? v : null;
}

export function normalizePmid(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().replace(/^https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pubmed)\//i, '').replace(/\/+$/, '');
  return /^\d{1,9}$/.test(v) ? v : null;
}

/** ISSN `1050-2947`, checksum verified. */
export function normalizeIssn(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toUpperCase().replace(/^(\d{4})(\d{3}[\dX])$/, '$1-$2');
  if (!/^\d{4}-\d{3}[\dX]$/.test(v)) return null;
  const digits = v.replace('-', '');
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return digits[7] === (check === 10 ? 'X' : String(check)) ? v : null;
}
