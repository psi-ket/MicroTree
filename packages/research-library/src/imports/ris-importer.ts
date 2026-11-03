import { escapeBibtex, normalizeDate, normalizeDoi, normalizeIssn, parseArxivId, safeUrl } from '@research-studio/literature-engine';
import type { BibField, EditedAuthor, PublicationType } from '@research-studio/shared-types';
import { emptyReference, type ImportedReference, type ImportWarning, type ParsedImport } from '../library/library-types';

/**
 * RIS reader (the tagged format exported by Zotero, Mendeley, EndNote and
 * publishers): `TY  - JOUR` … `ER  -`. Repeated tags (authors, keywords)
 * accumulate; untagged lines continue the previous value.
 */

const TYPE_MAP: Record<string, PublicationType> = {
  JOUR: 'journal-article',
  JFULL: 'journal-article',
  MGZN: 'journal-article',
  EJOUR: 'journal-article',
  CONF: 'conference-paper',
  CPAPER: 'conference-paper',
  BOOK: 'book',
  EBOOK: 'book',
  EDBOOK: 'book',
  CHAP: 'book-chapter',
  ECHAP: 'book-chapter',
  THES: 'dissertation',
  RPRT: 'report',
  DATA: 'dataset',
  UNPB: 'preprint',
};

const BIBTEX_TYPE: Partial<Record<PublicationType, string>> = {
  'journal-article': 'article',
  'conference-paper': 'inproceedings',
  book: 'book',
  'book-chapter': 'incollection',
  dissertation: 'phdthesis',
  report: 'techreport',
};

const LINE = /^([A-Z][A-Z0-9]) {2}-(?: (.*))?$/;

export interface RisRecord {
  /** 1-based line of the `TY` tag. */
  line: number;
  tags: [string, string][];
}

export function parseRis(source: string): { records: RisRecord[]; warnings: ImportWarning[] } {
  const records: RisRecord[] = [];
  const warnings: ImportWarning[] = [];
  let current: RisRecord | null = null;
  const lines = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const n = index + 1;
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) return;
    const m = LINE.exec(line);
    if (!m) {
      const last = current?.tags.at(-1);
      if (current && last) last[1] = `${last[1]} ${line.trim()}`;
      else warnings.push({ line: n, message: `Line is not a RIS tag ("XX  - value") and is outside a record` });
      return;
    }
    const [, tag, value = ''] = m;
    if (tag === 'TY') {
      if (current) {
        warnings.push({ line: current.line, message: 'Record has no "ER" line; it ends where the next one starts' });
        records.push(current);
      }
      current = { line: n, tags: [['TY', value.trim()]] };
      return;
    }
    if (!current) {
      warnings.push({ line: n, message: `Tag ${tag} appears before any "TY" line and is ignored` });
      return;
    }
    if (tag === 'ER') {
      records.push(current);
      current = null;
      return;
    }
    current.tags.push([tag!, value.trim()]);
  });
  if (current) {
    warnings.push({ line: (current as RisRecord).line, message: 'Record has no "ER" line at the end of the file' });
    records.push(current);
  }
  return { records, warnings };
}

function risAuthor(value: string): EditedAuthor {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length >= 2 && parts[0]) return { familyName: parts[0], givenName: parts.slice(1).filter(Boolean).join(' ') || null, name: null };
  return { givenName: null, familyName: null, name: value.trim() };
}

/** `2017/06/12/`, `2017///`, `2017-06`, `2017`. */
function risDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(?:[/-](\d{1,2})?(?:[/-](\d{1,2})?)?)?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const parts = [y, mo?.padStart(2, '0'), mo && d ? d.padStart(2, '0') : undefined].filter(Boolean);
  return normalizeDate(parts.join('-'));
}

export function referenceFromRis(record: RisRecord): { reference: ImportedReference; warnings: string[] } {
  const ref = emptyReference('ris');
  const warnings: string[] = [];
  const all = (...tags: string[]) => record.tags.filter(([t]) => tags.includes(t)).map(([, v]) => v).filter(Boolean);
  const first = (...tags: string[]) => {
    for (const t of tags) {
      const v = record.tags.find(([tag, value]) => tag === t && value)?.[1];
      if (v) return v;
    }
    return undefined;
  };
  const type = first('TY') ?? '';
  ref.publicationType = TYPE_MAP[type] ?? (type ? 'other' : null);
  ref.bibtexType = ref.publicationType ? (BIBTEX_TYPE[ref.publicationType] ?? 'misc') : 'misc';
  ref.title = first('TI', 'T1') ?? null;
  ref.authors = all('AU', 'A1').map(risAuthor);
  ref.publicationDate = risDate(first('DA')) ?? risDate(first('PY', 'Y1'));
  ref.publicationYear = ref.publicationDate ? Number(ref.publicationDate.slice(0, 4)) : null;
  ref.venue = first('T2', 'JO', 'JF', 'BT', 'JA', 'J2') ?? null;
  ref.publisher = first('PB') ?? null;
  ref.volume = first('VL') ?? null;
  ref.issue = first('IS') ?? null;
  const sp = first('SP');
  const ep = first('EP');
  ref.pages = sp && ep ? `${sp}–${ep}` : (sp ?? null);
  ref.abstract = first('AB', 'N2') ?? null;
  const doiValue = first('DO');
  ref.doi = normalizeDoi(doiValue);
  if (doiValue && !ref.doi) warnings.push(`"${doiValue}" is not a DOI and was kept as a note field`);
  const urls = all('UR', 'L2');
  ref.url = urls.map((u) => safeUrl(u)).find((u): u is string => !!u) ?? null;
  ref.arxivId = urls.map((u) => parseArxivId(u)?.id).find(Boolean) ?? null;
  ref.issn = all('SN')
    .map((v) => normalizeIssn(v))
    .filter((v): v is string => !!v);
  ref.keywords = all('KW');
  ref.citationKey = first('ID') ?? null;
  ref.notes = all('N1').join('\n\n') || null;

  // RIS values are plain text: they are escaped for BibTeX (URLs are written verbatim, as BibTeX styles expect).
  const extra: BibField[] = [];
  const editors = all('A2', 'ED');
  if (editors.length && ref.publicationType !== 'journal-article') {
    extra.push({ name: 'editor', value: editors.map((e) => escapeBibtex(e)).join(' and ') });
  }
  if (doiValue && !ref.doi) extra.push({ name: 'note', value: escapeBibtex(`DOI: ${doiValue}`) });
  if (ref.keywords.length) extra.push({ name: 'keywords', value: escapeBibtex(ref.keywords.join(', ')) });
  if (ref.doi && ref.url) extra.push({ name: 'url', value: ref.url.replace(/[{}]/g, '') });
  ref.extraFields = extra;
  ref.localSource = { format: 'ris', line: record.line, tags: record.tags };
  return { reference: ref, warnings };
}

export function importRis(source: string): ParsedImport {
  const { records, warnings } = parseRis(source);
  const references: ImportedReference[] = [];
  for (const record of records) {
    const { reference, warnings: w } = referenceFromRis(record);
    references.push(reference);
    for (const message of w) warnings.push({ line: record.line, message });
  }
  return { references, warnings };
}
