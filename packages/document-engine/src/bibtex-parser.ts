/**
 * Full BibTeX reader (M3.2): `@string` definitions with `#` concatenation and
 * the standard month macros, `@preamble`, `@comment`, braced and quoted values
 * with nesting and escapes, entries delimited by `{}` or `()`. A malformed
 * entry is reported with its line number and skipped; reading resumes at the
 * next line that starts with `@`, so valid entries are never lost.
 *
 * Pure and browser-safe. The tolerant scanner in `bibtex.ts` stays the source
 * for editor completion.
 */

export interface BibFieldNode {
  /** Lower-case field name. */
  name: string;
  /** Field text with macros expanded and outer delimiters removed (still LaTeX). */
  value: string;
  /** Exactly as written in the file, e.g. `{Foo}`, `"a" # jan`, `2020`. */
  raw: string;
  /** True for a single number or a single macro (written without braces). */
  bare: boolean;
}

export interface BibEntryNode {
  /** Lower-case entry type (`article`, `inproceedings`, …). */
  type: string;
  key: string;
  fields: BibFieldNode[];
  /** 1-based line of the `@`. */
  line: number;
  /** Offsets of the whole entry in the source: `text.slice(start, end)` is the entry. */
  start: number;
  end: number;
  /** Offset just after the last field's value (or the key): where new fields are inserted. */
  fieldsEnd: number;
}

export interface BibParseError {
  line: number;
  message: string;
}

export interface BibFile {
  entries: BibEntryNode[];
  /** `@string` definitions (lower-case names), expanded. */
  strings: Record<string, string>;
  preambles: string[];
  errors: BibParseError[];
}

/** Standard BibTeX month macros. */
export const MONTH_MACROS: Readonly<Record<string, string>> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

class BibSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const NAME_CHAR = /[A-Za-z0-9_\-:.+/'!?&*<>|[\]]/;
const MAX_INPUT = 20 * 1024 * 1024;

export function parseBibtex(text: string): BibFile {
  const result: BibFile = { entries: [], strings: {}, preambles: [], errors: [] };
  if (text.length > MAX_INPUT) {
    result.errors.push({ line: 1, message: `File is larger than ${MAX_INPUT / 1024 / 1024} MB` });
    return result;
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  let pos = 0;
  while (pos < text.length) {
    const at = text.indexOf('@', pos);
    if (at === -1) break;
    try {
      pos = readItem(text, at, result, lineOf);
    } catch (err) {
      const e = err instanceof BibSyntaxError ? err : new BibSyntaxError(String(err), at);
      result.errors.push({ line: lineOf(e.offset), message: `${e.message} (entry starting on line ${lineOf(at)})` });
      pos = nextEntryStart(text, at + 1);
    }
  }
  return result;
}

/** Next `@` at the start of a line (after optional whitespace). */
function nextEntryStart(text: string, from: number): number {
  const re = /(^|\n)[ \t]*@/g;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].length - 1 : text.length;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function readName(text: string, i: number): { name: string; end: number } {
  let j = i;
  while (j < text.length && NAME_CHAR.test(text[j]!)) j++;
  return { name: text.slice(i, j), end: j };
}

/** Read one `@…` item starting at `at`; returns the offset after it. */
function readItem(text: string, at: number, out: BibFile, lineOf: (o: number) => number): number {
  let i = skipSpace(text, at + 1);
  const { name: rawType, end: typeEnd } = readName(text, i);
  const type = rawType.toLowerCase();
  if (!/^[a-z]+$/.test(type)) {
    // A stray `@` in free text (e.g. an e-mail address) is a comment, as in BibTeX.
    return at + 1;
  }
  i = skipSpace(text, typeEnd);
  const open = text[i];
  if (open !== '{' && open !== '(') {
    if (type === 'comment') return i; // `@comment` without braces: the rest of the line is ignored
    throw new BibSyntaxError(`Expected "{" or "(" after @${rawType}`, i);
  }
  const close = open === '{' ? '}' : ')';

  if (type === 'comment') {
    return matchDelimited(text, i, open, close) + 1;
  }
  i = skipSpace(text, i + 1);

  if (type === 'preamble') {
    const value = readValue(text, i, out.strings);
    out.preambles.push(value.value);
    i = skipSpace(text, value.end);
    if (text[i] !== close) throw new BibSyntaxError(`Expected "${close}" to end @preamble`, i);
    return i + 1;
  }

  if (type === 'string') {
    const { name, end } = readName(text, i);
    if (!name) throw new BibSyntaxError('Expected a name in @string', i);
    i = skipSpace(text, end);
    if (text[i] !== '=') throw new BibSyntaxError(`Expected "=" after @string name "${name}"`, i);
    const value = readValue(text, skipSpace(text, i + 1), out.strings);
    out.strings[name.toLowerCase()] = value.value;
    i = skipSpace(text, value.end);
    if (text[i] !== close) throw new BibSyntaxError(`Expected "${close}" to end @string`, i);
    return i + 1;
  }

  // Regular entry: key, then fields.
  let keyEnd = i;
  while (keyEnd < text.length && !/[,\s]/.test(text[keyEnd]!) && text[keyEnd] !== close) keyEnd++;
  const key = text.slice(i, keyEnd);
  if (!key) throw new BibSyntaxError(`Missing citation key in @${rawType}`, i);
  if (/[{}"#%'(),=\\]/.test(key)) throw new BibSyntaxError(`Invalid citation key "${key.slice(0, 60)}"`, i);
  i = skipSpace(text, keyEnd);
  const fields: BibFieldNode[] = [];
  let fieldsEnd = keyEnd;
  const seen = new Set<string>();
  for (;;) {
    if (text[i] === close) break;
    if (text[i] !== ',') throw new BibSyntaxError(`Expected "," or "${close}" in entry "${key}"`, i);
    i = skipSpace(text, i + 1);
    if (text[i] === close) break; // trailing comma
    const { name, end } = readName(text, i);
    if (!name || !/^[A-Za-z]/.test(name)) throw new BibSyntaxError(`Expected a field name in entry "${key}"`, i);
    i = skipSpace(text, end);
    if (text[i] !== '=') throw new BibSyntaxError(`Expected "=" after field "${name}" in entry "${key}"`, i);
    const valueStart = skipSpace(text, i + 1);
    const value = readValue(text, valueStart, out.strings);
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      out.errors.push({ line: lineOf(i), message: `Field "${lower}" appears twice in entry "${key}"; the first is kept` });
    } else {
      seen.add(lower);
      fields.push({ name: lower, value: value.value, raw: text.slice(valueStart, value.end), bare: value.bare });
    }
    fieldsEnd = value.end;
    i = skipSpace(text, value.end);
  }
  out.entries.push({ type, key, fields, line: lineOf(at), start: at, end: i + 1, fieldsEnd });
  return i + 1;
}

/** Index of the delimiter closing the one at `open` (braces nest; `\{` does not count). */
function matchDelimited(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === open || (open === '(' && ch === '{')) depth++;
    else if (ch === close || (open === '(' && ch === '}')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new BibSyntaxError(`Unbalanced "${open}"`, start);
}

/** A value: parts joined by `#`. */
function readValue(text: string, i: number, strings: Record<string, string>): { value: string; end: number; bare: boolean } {
  const parts: string[] = [];
  let partCount = 0;
  let bare: boolean;
  for (;;) {
    const ch = text[i];
    partCount++;
    if (ch === '{') {
      const end = matchBraces(text, i);
      parts.push(text.slice(i + 1, end));
      i = end + 1;
      bare = false;
    } else if (ch === '"') {
      const end = matchQuote(text, i);
      parts.push(text.slice(i + 1, end));
      i = end + 1;
      bare = false;
    } else if (ch !== undefined && /[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j]!)) j++;
      parts.push(text.slice(i, j));
      i = j;
      bare = true;
    } else if (ch !== undefined && /[A-Za-z]/.test(ch)) {
      const { name, end } = readName(text, i);
      const macro = name.toLowerCase();
      const expanded = strings[macro] ?? MONTH_MACROS[macro];
      if (expanded === undefined) throw new BibSyntaxError(`Undefined @string "${name}"`, i);
      parts.push(expanded);
      i = end;
      bare = true;
    } else {
      throw new BibSyntaxError(ch === undefined ? 'Unexpected end of file in a value' : `Unexpected "${ch}" where a value was expected`, i);
    }
    const next = skipSpace(text, i);
    if (text[next] !== '#') return { value: parts.join(''), end: i, bare: bare && partCount === 1 };
    i = skipSpace(text, next + 1);
  }
}

function matchBraces(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '@' && depth > 0 && /\n[ \t]*$/.test(text.slice(Math.max(0, i - 80), i))) {
      // An `@` at the start of a line inside an open value almost always means a missing "}".
      throw new BibSyntaxError('Missing "}" before the next entry', start);
    }
  }
  throw new BibSyntaxError('Missing "}" at the end of a value', start);
}

function matchQuote(text: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' && depth === 0) return i;
    else if (ch === '@' && /\n[ \t]*$/.test(text.slice(Math.max(0, i - 80), i))) {
      throw new BibSyntaxError('Missing closing quote before the next entry', start);
    }
  }
  throw new BibSyntaxError('Missing closing quote', start);
}

// ----------------------------------------------------------------- LaTeX → Unicode

const ACCENTS: Record<string, string> = {
  "'": '\u0301',
  '`': '\u0300',
  '^': '\u0302',
  '"': '\u0308',
  '~': '\u0303',
  '=': '\u0304',
  '.': '\u0307',
  u: '\u0306',
  v: '\u030c',
  H: '\u030b',
  c: '\u0327',
  k: '\u0328',
  r: '\u030a',
  d: '\u0323',
  b: '\u0331',
};

const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  textendash: '–',
  textemdash: '—',
  textquoteright: '’',
  textquoteleft: '‘',
  textasciitilde: '~',
  textbackslash: '\\',
  textunderscore: '_',
  textasciicircum: '^',
  textregistered: '®',
  texttrademark: '™',
  copyright: '©',
  dag: '†',
  S: '§',
  P: '¶',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
};

/** Commands whose argument is kept as text (`\emph{x}` → `x`). */
const TEXT_COMMANDS = /\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|textup|textnormal|mathrm|mathit|mathbf|mbox|url|href\{[^{}]*\})\s*\{/g;

/**
 * Plain Unicode text for display and matching: accents and special letters
 * become Unicode, escaped characters lose their backslash, protective braces
 * and font commands are dropped, `--`/`---` become dashes. Math stays as
 * written between the dollar signs.
 */
export function latexToUnicode(value: string): string {
  let s = value;
  // \'{e}, {\'e}, \'e, \"{\i}
  s = s.replace(/\\([`'^"~=.])\s*\{?\\?([A-Za-z])\}?/g, (_m, acc: string, ch: string) => (ch === 'i' ? 'i' : ch) + ACCENTS[acc]!);
  s = s.replace(/\\([uvHckrdb])(?:\s*\{\\?([A-Za-z])\}|\s+\\?([A-Za-z]))/g, (_m, acc: string, a?: string, b?: string) => {
    const ch = a ?? b ?? '';
    return (ch === 'i' ? 'i' : ch) + ACCENTS[acc]!;
  });
  s = s.replace(/\\([A-Za-z]+)(?:\{\}|\b\s?)/g, (m, name: string) => SYMBOLS[name] ?? m);
  s = s.replace(TEXT_COMMANDS, '{');
  s = s.replace(/\\([&%$#_{}])/g, '$1');
  s = s.replace(/---/g, '—').replace(/--/g, '–');
  s = s.replace(/(?<!\\)~/g, '\u00a0');
  // Drop grouping braces, but keep escaped ones restored above.
  s = s.replace(/(?<!\\)[{}]/g, '');
  s = s.replace(/\\\\/g, ' ');
  return s.normalize('NFC').replace(/[\s\u00a0]+/g, ' ').trim();
}

/** Split a BibTeX name list (`A and B and others`) into names; `and` inside braces does not split. */
export function splitBibNames(value: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  const tokens = value.split(/(\s+and\s+|[{}])/i);
  for (const token of tokens) {
    if (token === '{') depth++;
    else if (token === '}') depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(token)) {
      names.push(current.trim());
      current = '';
    } else current += token;
  }
  if (current.trim()) names.push(current.trim());
  return names.filter(Boolean);
}

/** A BibTeX name: `Family, Given`, `Given Family`, `von Family, Jr, Given`, or `{Organisation}`. */
export function parseBibName(raw: string): { givenName: string | null; familyName: string | null; name: string } {
  const trimmed = raw.trim();
  if (/^\{.*\}$/.test(trimmed) && matchedOuter(trimmed)) {
    const whole = latexToUnicode(trimmed);
    return { givenName: null, familyName: null, name: whole };
  }
  const parts = splitTopLevel(trimmed, ',');
  if (parts.length >= 2) {
    const family = latexToUnicode(parts[0]!);
    const given = latexToUnicode(parts.length === 3 ? parts[2]! : parts[1]!);
    const suffix = parts.length === 3 ? latexToUnicode(parts[1]!) : '';
    const familyName = suffix ? `${family}, ${suffix}` : family;
    return { givenName: given || null, familyName: familyName || null, name: [given, family].filter(Boolean).join(' ') };
  }
  const words = splitTopLevel(trimmed, ' ').filter(Boolean);
  if (words.length === 1) {
    const only = latexToUnicode(words[0]!);
    return { givenName: null, familyName: only, name: only };
  }
  // "Given von Family": the family name starts at the first lower-case word that is not the last word.
  let split = words.length - 1;
  for (let i = 1; i < words.length - 1; i++) {
    if (/^[a-z]/.test(latexToUnicode(words[i]!))) {
      split = i;
      break;
    }
  }
  const given = latexToUnicode(words.slice(0, split).join(' '));
  const family = latexToUnicode(words.slice(split).join(' '));
  return { givenName: given || null, familyName: family || null, name: `${given} ${family}`.trim() };
}

function matchedOuter(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return true;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      current += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === sep && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}
