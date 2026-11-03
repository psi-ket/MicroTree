import type { PublicationType, ScholarlyAuthor, ScholarlyWork } from '@research-studio/shared-types';

/** Browser-safe: this module and the rest of `format/` import nothing from Node. */

const ENTRY_TYPE: Record<PublicationType, string> = {
  'journal-article': 'article',
  review: 'article',
  'conference-paper': 'inproceedings',
  preprint: 'misc',
  book: 'book',
  'book-chapter': 'incollection',
  dissertation: 'phdthesis',
  report: 'techreport',
  dataset: 'misc',
  editorial: 'article',
  letter: 'article',
  erratum: 'article',
  other: 'misc',
};

const LATEX_SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * Escape text for a BibTeX field value: LaTeX specials are escaped, control
 * characters removed, whitespace collapsed. Unicode is kept (biber and
 * modern BibTeX read UTF-8); provider text is never passed through as LaTeX.
 */
export function escapeBibtex(text: string): string {
  // Control characters are removed on purpose.
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return visible
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\{}&%$#_~^]/g, (c) => LATEX_SPECIAL[c]!);
}

/** Protect words whose capitalisation must survive bibliography styles (acronyms, `qubit`-style mixed case, chemical formulae). */
function protectCase(escaped: string): string {
  return escaped
    .split(' ')
    .map((word) => (/^[^\\]*\p{Lu}/u.test(word.slice(1)) && !word.includes('\\') ? `{${word}}` : word))
    .join(' ');
}

function bibName(a: ScholarlyAuthor): string {
  if (a.familyName && a.givenName) return `${escapeBibtex(a.familyName)}, ${escapeBibtex(a.givenName)}`;
  if (a.familyName) return escapeBibtex(a.familyName);
  // A name the provider did not split is kept whole, so it is never mis-split.
  return `{${escapeBibtex(a.name)}}`;
}

/** Letters with no Unicode decomposition to ASCII. */
const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ı: 'i' };

export function asciiFold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßæÆøØœŒłŁđĐðÐþÞı]/g, (c) => FOLD[c]!)
    .replace(/[^A-Za-z0-9]/g, '');
}

const KEY_STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'by', 'at', 'is', 'are']);

/** Citation key `familyYearWord`, ASCII only (e.g. `shor1995scheme`). */
export function citationKey(work: ScholarlyWork): string {
  const first = work.authors[0];
  const family = first ? asciiFold(first.familyName ?? first.name.split(/\s+/).at(-1) ?? '') : '';
  const word =
    work.title
      .split(/\s+/)
      .map((w) => asciiFold(w).toLowerCase())
      .find((w) => w.length > 0 && !KEY_STOPWORDS.has(w)) ?? '';
  const key = `${family.toLowerCase()}${work.publicationYear ?? ''}${word}`;
  return key || `work${asciiFold(work.id).toLowerCase().slice(-12)}`;
}

function primaryArxivCategory(work: ScholarlyWork): string | null {
  return work.categories.find((c) => c.scheme === 'arxiv')?.value ?? null;
}

/** One BibTeX field: `value` is written inside braces, or as is when `bare` (numbers, month macros). */
export interface BibtexField {
  name: string;
  value: string;
  bare?: boolean;
}

/** Entry type and fields for a work. Values come only from the work's normalised fields, already escaped. */
export function bibtexEntry(work: ScholarlyWork): { type: string; fields: BibtexField[] } {
  const type = ENTRY_TYPE[work.publicationType ?? 'other'];
  const fields: BibtexField[] = [];
  const add = (name: string, value: string | null | undefined, raw = false) => {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: raw ? value : escapeBibtex(value) });
  };

  fields.push({ name: 'title', value: protectCase(escapeBibtex(work.title)) });
  if (work.authors.length) fields.push({ name: 'author', value: work.authors.map(bibName).join(' and ') });
  const venue = work.venue;
  if (type === 'article') add('journal', venue);
  else if (type === 'inproceedings' || type === 'incollection') add('booktitle', venue);
  if (work.publicationYear !== null) add('year', String(work.publicationYear));
  add('volume', work.bibliographic.volume);
  add('number', work.bibliographic.issue);
  add('pages', work.bibliographic.pages?.replace(/\s*[-‐-―]\s*/g, '--') ?? null);
  if (type === 'phdthesis') add('school', work.publisher);
  else if (type === 'techreport') add('institution', work.publisher);
  else if (type !== 'misc' || work.publicationType === 'dataset') add('publisher', work.publisher);
  if (work.identifiers.doi) add('doi', work.identifiers.doi);
  if (work.identifiers.arxivId) {
    add('eprint', work.identifiers.arxivId);
    add('archiveprefix', 'arXiv');
    add('primaryclass', primaryArxivCategory(work));
  }
  if (!work.identifiers.doi) add('url', work.urls.landingPage ?? work.urls.abstract);
  return { type, fields };
}

/** Characters a citation key may contain (BibTeX and biber accept these everywhere). */
export function sanitizeCitationKey(key: string): string {
  return key.replace(/[^A-Za-z0-9:_.-]/g, '');
}

/** Write one entry with aligned field names. */
export function formatBibtexEntry(type: string, key: string, fields: readonly BibtexField[]): string {
  const keyText = sanitizeCitationKey(key) || 'work';
  if (!fields.length) return `@${type}{${keyText}\n}\n`;
  const width = Math.max(...fields.map((f) => f.name.length));
  const body = fields.map((f) => `  ${f.name.padEnd(width)} = ${f.bare ? f.value : `{${f.value}}`}`).join(',\n');
  return `@${type}{${keyText},\n${body}\n}\n`;
}

/** One BibTeX entry for a work. Values come only from the work's normalised fields. */
export function toBibTeX(work: ScholarlyWork, key: string = citationKey(work)): string {
  const { type, fields } = bibtexEntry(work);
  return formatBibtexEntry(type, key, fields);
}
