/** 1-based line/column (as used by Monaco) to a UTF-16 offset. Columns past the line end clamp to it. */
export function offsetAt(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  if (lineEnd > offset && text[lineEnd - 1] === '\r') lineEnd--;
  return Math.min(offset + Math.max(0, column - 1), lineEnd);
}

/** UTF-16 offset to a 1-based line number. */
export function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/** Lines `from..to` (1-based, inclusive) of `text`. */
export function sliceLines(text: string, from: number, to: number): string {
  return text
    .split('\n')
    .slice(Math.max(0, from - 1), Math.max(0, to))
    .join('\n');
}

/** Cut `text` to at most `max` characters, keeping whole lines when possible. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return { text: lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut, truncated: true };
}
