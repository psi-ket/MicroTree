import { asciiFold, sanitizeCitationKey } from '@research-studio/literature-engine/format';
import type { CitationKeyFormat, ScholarlyWork } from '@research-studio/shared-types';

/**
 * Citation keys. A key is generated once, stored with the library item and
 * never changed behind the user's back; collisions get `a`, `b`, … suffixes.
 */

export const KEY_FORMAT_TEMPLATES: Readonly<Record<Exclude<CitationKeyFormat, 'custom'>, string>> = {
  'author-year': '{author}{year}',
  'author-year-keyword': '{author}{year}{word}',
  'author-year-title': '{author}{year}{title}',
};

export const KEY_TOKENS = ['author', 'Author', 'authors', 'year', 'yy', 'word', 'Word', 'title'] as const;

const STOPWORDS = new Set(
  'a an the on of in for and to with from by at is are as via into using towards toward its their this that these or'.split(' '),
);

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function familyOf(work: ScholarlyWork, index: number): string {
  const a = work.authors[index];
  if (!a) return '';
  return asciiFold(a.familyName ?? a.name.split(/\s+/).at(-1) ?? '').toLowerCase();
}

function titleWords(work: ScholarlyWork): string[] {
  return work.title
    .split(/\s+/)
    .map((w) => asciiFold(w).toLowerCase())
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/** Problems with a custom template, or null when it is usable. */
export function validateKeyTemplate(template: string): string | null {
  if (!template.trim()) return 'The template is empty';
  if (template.length > 100) return 'The template is longer than 100 characters';
  const tokens = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
  const unknown = tokens.filter((t) => !(KEY_TOKENS as readonly string[]).includes(t));
  if (unknown.length) return `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `{${t}}`).join(', ')}`;
  if (!tokens.length) return 'The template needs at least one placeholder, e.g. {author}';
  const literal = template.replace(/\{[^{}]*\}/g, '');
  if (/[^A-Za-z0-9:_-]/.test(literal)) return 'Outside placeholders, use only letters, digits, ":", "_" and "-"';
  return null;
}

/** The key a work would get, before collision handling. */
export function generateCitationKey(work: ScholarlyWork, format: CitationKeyFormat, customTemplate = ''): string {
  const template = format === 'custom' ? customTemplate : KEY_FORMAT_TEMPLATES[format];
  const words = titleWords(work);
  const values: Record<(typeof KEY_TOKENS)[number], string> = {
    author: familyOf(work, 0),
    Author: capitalise(familyOf(work, 0)),
    authors: [0, 1, 2].map((i) => capitalise(familyOf(work, i))).join('').replace(/^./, (c) => c.toLowerCase()),
    year: work.publicationYear?.toString() ?? '',
    yy: work.publicationYear?.toString().slice(-2) ?? '',
    word: words[0] ?? '',
    Word: capitalise(words[0] ?? ''),
    title: words.slice(0, 3).map(capitalise).join(''),
  };
  let key = template.replace(/\{([^{}]*)\}/g, (_m, token: string) => values[token as keyof typeof values] ?? '');
  // No author: start from the title so the key still says what the work is,
  // unless the template already takes words from the title.
  if (!values.author && /\{(author|Author|authors)\}/.test(template) && !/\{(word|Word|title)\}/.test(template)) key = `${values.word}${key}`;
  key = sanitizeCitationKey(key);
  return key || 'ref';
}

/** First of `base`, `basea`, `baseb`, …, `baseaa`, … that `taken` does not report as used (case-insensitive). */
export function uniqueCitationKey(base: string, taken: (keyLower: string) => boolean): string {
  if (!taken(base.toLowerCase())) return base;
  for (let n = 0; n < 26 * 27; n++) {
    const suffix = n < 26 ? String.fromCharCode(97 + n) : String.fromCharCode(96 + Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26));
    const candidate = `${base}${suffix}`;
    if (!taken(candidate.toLowerCase())) return candidate;
  }
  let i = 2;
  while (taken(`${base}-${i}`.toLowerCase())) i++;
  return `${base}-${i}`;
}

/** Problems with a key typed by the user, or null. */
export function validateCitationKey(key: string): string | null {
  if (!key) return 'The key is empty';
  if (key.length > 120) return 'The key is longer than 120 characters';
  if (sanitizeCitationKey(key) !== key) return 'Use only letters, digits, ":", "_", "." and "-"';
  return null;
}
