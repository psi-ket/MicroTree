/**
 * Rule-based sentence segmentation for scientific prose, used when the
 * extractor did not segment (PyMuPDF fallback, GROBID without `<s>`).
 *
 * A boundary is a `.`, `!` or `?` (optionally followed by closing quotes,
 * brackets or a citation such as `[12]`) followed by whitespace and a
 * sentence start (capital letter, digit, opening bracket or quote, Greek
 * capital). It is not a boundary after common abbreviations (`et al.`,
 * `Fig.`, `Eq.`, `i.e.`, …), single initials (`J. Preskill`), inside
 * decimals (`0.5`) or inside identifiers (`arXiv:1706.03762`).
 */

const ABBREVIATIONS = new Set(
  [
    'al', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'sec', 'secs', 'tab', 'tabs', 'app', 'apps', 'chap', 'ch',
    'e.g', 'i.e', 'cf', 'vs', 'viz', 'etc', 'resp', 'approx', 'ca', 'no', 'nos', 'vol', 'vols', 'pp', 'p',
    'dr', 'prof', 'mr', 'mrs', 'ms', 'jr', 'sr', 'st', 'thm', 'lem', 'prop', 'def', 'cor', 'ex', 'phys', 'rev',
    'lett', 'proc', 'eqn', 'eqns', 'est', 'max', 'min', 'std', 'avg', 'dept', 'univ', 'inc', 'ltd', 'co',
  ].map((s) => s.toLowerCase()),
);

export interface SentenceSpan {
  text: string;
  /** Offsets into the input string. */
  start: number;
  end: number;
}

const BOUNDARY = /[.!?](?:["'”’)\]]*)(?:\s*\[[\d,\s–-]{1,40}\])?(?=\s+)/g;
const START = /^\s+(?=["'“‘([]?[\p{Lu}\p{N}Α-Ω])/u;

function wordBefore(text: string, index: number): string {
  // The token immediately before the punctuation mark at `index`.
  const before = text.slice(Math.max(0, index - 24), index);
  const m = /([\p{L}.]+)$/u.exec(before);
  return m ? m[1]!.toLowerCase() : '';
}

export function segmentSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  BOUNDARY.lastIndex = 0;
  for (let m = BOUNDARY.exec(text); m; m = BOUNDARY.exec(text)) {
    const punct = m.index;
    const end = punct + m[0].length;
    const rest = text.slice(end);
    if (!START.test(rest)) continue;
    if (text[punct] === '.') {
      const word = wordBefore(text, punct);
      const bare = word.replace(/\.$/, '');
      if (ABBREVIATIONS.has(bare) || ABBREVIATIONS.has(word)) continue;
      // Single initials ("J. Preskill") and dotted abbreviations ("U.S.").
      if (/^\p{Lu}$/u.test(text.slice(punct - 1, punct)) && (punct < 2 || /\s|\./.test(text[punct - 2]!))) continue;
    }
    const piece = text.slice(start, end).trim();
    if (piece) {
      const s = text.indexOf(piece, start);
      spans.push({ text: piece, start: s, end: s + piece.length });
    }
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    const s = text.indexOf(tail, start);
    spans.push({ text: tail, start: s, end: s + tail.length });
  }
  return spans;
}
