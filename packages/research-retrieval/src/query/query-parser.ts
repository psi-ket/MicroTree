import { findArxivId, normalizeSearchText, SECTION_TYPES, type SectionType } from '@research-studio/document-intelligence';

/**
 * Query interpretation without a language model. The original query is kept
 * as typed; nothing is rewritten silently. Supported:
 *
 * - words (all must match by default): `bosonic codes`
 * - exact phrases: `"Lindblad master equation"`
 * - `OR` between two items, `-word` or `NOT word` to exclude
 * - `section:methods` (also `section:results`, …) to restrict sections
 * - identifiers: `10.1103/PhysRevA.52.R2493`, `doi:…`, `arXiv:1706.03762`
 */
export interface ParsedQuery {
  original: string;
  /** Normalised words and phrases in order, each with the operator joining it to the previous one. */
  clauses: { kind: 'term' | 'phrase'; text: string; op: 'AND' | 'OR' }[];
  excluded: string[];
  sections: SectionType[];
  doi: string | null;
  arxivId: string | null;
  /** The query text with field prefixes removed, as typed (used for semantic search). */
  semanticText: string;
  /** What was understood, for display. */
  notes: string[];
}

const DOI = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;
const SECTION_ALIASES: Record<string, SectionType> = { method: 'methods', result: 'results', intro: 'introduction', conclusions: 'conclusion', appendices: 'appendix', acknowledgements: 'acknowledgement', acknowledgments: 'acknowledgement', refs: 'references' };

export function parseQuery(original: string): ParsedQuery {
  const q: ParsedQuery = { original, clauses: [], excluded: [], sections: [], doi: null, arxivId: null, semanticText: '', notes: [] };
  const tokens: string[] = [];
  const re = /(-?)"([^"]*)"|(\S+)/g;
  for (let m = re.exec(original); m; m = re.exec(original)) tokens.push(m[2] !== undefined ? `${m[1]}"${m[2]}"` : m[3]!);
  let op: 'AND' | 'OR' = 'AND';
  let negateNext = false;
  const semantic: string[] = [];
  for (const raw of tokens) {
    if (raw === 'OR' || raw === '|') {
      op = 'OR';
      continue;
    }
    if (raw === 'AND' || raw === '&&') continue;
    if (raw === 'NOT') {
      negateNext = true;
      continue;
    }
    const field = /^(section|doi|arxiv):(.+)$/i.exec(raw);
    if (field) {
      const name = field[1]!.toLowerCase();
      const value = field[2]!;
      if (name === 'section') {
        const v = value.toLowerCase();
        const type = (SECTION_TYPES as readonly string[]).includes(v) ? (v as SectionType) : SECTION_ALIASES[v];
        if (type) q.sections.push(type);
        else q.notes.push(`Unknown section "${value}" was ignored.`);
        continue;
      }
      if (name === 'doi') {
        const d = DOI.exec(value);
        if (d) q.doi = d[1]!.replace(/[.,;)]+$/, '').toLowerCase();
        continue;
      }
      const a = findArxivId(`arXiv:${value}`);
      if (a) q.arxivId = a;
      continue;
    }
    const doi = DOI.exec(raw);
    if (doi && !q.doi) {
      q.doi = doi[1]!.replace(/[.,;)]+$/, '').toLowerCase();
      continue;
    }
    if (/^arxiv:/i.test(raw) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(raw)) {
      const a = findArxivId(/^arxiv:/i.test(raw) ? raw : `arXiv:${raw}`);
      if (a) {
        q.arxivId = a;
        continue;
      }
    }
    const isPhrase = raw.startsWith('"') || raw.startsWith('-"');
    const negative = negateNext || (raw.startsWith('-') && raw.length > 1);
    negateNext = false;
    const body = raw.replace(/^-/, '').replace(/^"|"$/g, '');
    const text = normalizeSearchText(body);
    if (!/[\p{L}\p{N}]/u.test(text)) continue; // a bare symbol has no keyword token
    if (negative) {
      q.excluded.push(text);
    } else {
      q.clauses.push({ kind: isPhrase || /\s/.test(text) ? 'phrase' : 'term', text, op: q.clauses.length ? op : 'AND' });
      semantic.push(body);
    }
    op = 'AND';
  }
  q.semanticText = semantic.join(' ').trim();
  if (q.doi) q.notes.push(`DOI ${q.doi}`);
  if (q.arxivId) q.notes.push(`arXiv ${q.arxivId}`);
  return q;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * FTS5 MATCH expression for a parsed query. Every word and phrase is quoted,
 * so FTS operators typed inside them have no effect; `any` joins all clauses
 * with OR (used only when the caller asks for a relaxed match).
 */
export function toFtsExpression(q: ParsedQuery, any = false): string | null {
  if (!q.clauses.length) return null;
  let expr = '';
  for (const c of q.clauses) {
    const item = quote(c.text);
    expr = expr ? `${expr} ${any ? 'OR' : c.op} ${item}` : item;
  }
  if (q.excluded.length) expr = `(${expr}) NOT (${q.excluded.map(quote).join(' OR ')})`;
  return expr;
}
