/** Tolerant BibTeX entry scanner (keys + common fields), used for `\cite` completion. */

export interface BibEntry {
  key: string;
  type: string;
  line: number;
  title: string | null;
  author: string | null;
  year: string | null;
}

const NON_ENTRY_TYPES = new Set(['comment', 'preamble', 'string']);

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Return the index just after the matching closing delimiter, or `text.length`. */
function findEntryEnd(text: string, openIndex: number): number {
  const open = text[openIndex];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{' || ch === open) depth++;
    else if (ch === '}' || ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function readField(body: string, field: string): string | null {
  const re = new RegExp(`(?:^|[,\\s])${field}\\s*=\\s*`, 'i');
  const m = re.exec(body);
  if (!m) return null;
  let i = m.index + m[0].length;
  const first = body[i];
  if (first === '{') {
    let depth = 0;
    const start = i + 1;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) return clean(body.slice(start, i));
      }
    }
    return clean(body.slice(start));
  }
  if (first === '"') {
    const end = body.indexOf('"', i + 1);
    return clean(body.slice(i + 1, end === -1 ? undefined : end));
  }
  const bare = /^[^,}\s]+/.exec(body.slice(i));
  return bare ? clean(bare[0]) : null;
}

function clean(value: string): string {
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export function parseBibEntries(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([a-zA-Z]+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const type = m[1]!.toLowerCase();
    const openIndex = m.index + m[0].length - 1;
    const end = findEntryEnd(text, openIndex);
    re.lastIndex = Math.max(end, re.lastIndex);
    if (NON_ENTRY_TYPES.has(type)) continue;
    const body = text.slice(openIndex + 1, end - 1);
    const keyMatch = /^\s*([^,\s]+)\s*,/.exec(body);
    if (!keyMatch) continue;
    entries.push({
      key: keyMatch[1]!,
      type,
      line: lineAt(text, m.index),
      title: readField(body, 'title'),
      author: readField(body, 'author'),
      year: readField(body, 'year') ?? readField(body, 'date')?.slice(0, 4) ?? null,
    });
  }
  return entries;
}
