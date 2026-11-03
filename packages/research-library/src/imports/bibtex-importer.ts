import {
  latexToUnicode,
  parseBibName,
  parseBibtex,
  splitBibNames,
  type BibEntryNode,
  type BibFieldNode,
} from '@research-studio/document-engine';
import { normalizeDate, normalizeDoi, normalizeIssn, parseArxivId, safeUrl } from '@research-studio/literature-engine';
import type { BibField, PublicationType } from '@research-studio/shared-types';
import { emptyReference, type ImportedReference, type ParsedImport } from '../library/library-types';

const TYPE_MAP: Record<string, PublicationType> = {
  article: 'journal-article',
  inproceedings: 'conference-paper',
  conference: 'conference-paper',
  proceedings: 'book',
  incollection: 'book-chapter',
  inbook: 'book-chapter',
  book: 'book',
  mvbook: 'book',
  booklet: 'book',
  phdthesis: 'dissertation',
  mastersthesis: 'dissertation',
  thesis: 'dissertation',
  techreport: 'report',
  report: 'report',
  dataset: 'dataset',
};

/**
 * Fields read into the work and written back from it on export. Every other
 * field (`month`, `date`, `note`, `editor`, `file`, custom fields, …) is kept
 * verbatim in the item's extra fields and written back unchanged.
 */
const MAPPED = new Set([
  'title',
  'author',
  'year',
  'journal',
  'journaltitle',
  'booktitle',
  'publisher',
  'school',
  'institution',
  'volume',
  'number',
  'pages',
]);

/** Whether a field must be kept as written because the work does not carry it back on export. */
function keepVerbatim(name: string, ref: ImportedReference): boolean {
  // Export writes `url` only for works without a DOI, and `eprint` only for arXiv IDs.
  if (name === 'url') return !!ref.doi;
  if (name === 'eprint' || name === 'archiveprefix' || name === 'eprinttype') return !ref.arxivId;
  // A `doi` field that is not a DOI is kept rather than dropped.
  if (name === 'doi') return !ref.doi;
  return !MAPPED.has(name);
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

function text(entry: BibEntryNode, name: string): string | null {
  const f = entry.fields.find((x) => x.name === name);
  if (!f) return null;
  const v = latexToUnicode(f.value);
  return v || null;
}

function raw(entry: BibEntryNode, name: string): BibFieldNode | undefined {
  return entry.fields.find((x) => x.name === name);
}

/** One parsed entry as a reference. Values the entry does not have stay empty. */
export function referenceFromBibEntry(entry: BibEntryNode): ImportedReference {
  const ref = emptyReference('bibtex');
  ref.citationKey = entry.key;
  ref.bibtexType = entry.type;
  ref.title = text(entry, 'title');
  const authorField = raw(entry, 'author');
  if (authorField) {
    ref.authors = splitBibNames(authorField.value)
      .filter((n) => n.toLowerCase() !== 'others')
      .map(parseBibName)
      .map((n) => (n.familyName || n.givenName ? { givenName: n.givenName, familyName: n.familyName, name: null } : { givenName: null, familyName: null, name: n.name }));
  }

  // Dates: biblatex `date`, else `year` (+ `month` when it is a month).
  const date = normalizeDate(text(entry, 'date'));
  const yearText = text(entry, 'year');
  const year = yearText && /^\d{4}$/.test(yearText.trim()) ? Number(yearText.trim()) : null;
  if (date) {
    ref.publicationDate = date;
    ref.publicationYear = Number(date.slice(0, 4));
  } else if (year) {
    ref.publicationYear = year;
    const month = text(entry, 'month')?.toLowerCase();
    const mm = month ? (MONTHS[month] ?? (/^\d{1,2}$/.test(month) && Number(month) >= 1 && Number(month) <= 12 ? month.padStart(2, '0') : null)) : null;
    ref.publicationDate = mm ? `${year}-${mm}` : String(year);
  }

  const type = TYPE_MAP[entry.type] ?? null;
  const eprint = text(entry, 'eprint');
  const archive = (text(entry, 'archiveprefix') ?? text(entry, 'eprinttype'))?.toLowerCase();
  const arxiv = (eprint && (!archive || archive === 'arxiv') ? parseArxivId(eprint) : null) ?? parseArxivId(text(entry, 'url'));
  ref.arxivId = arxiv?.id ?? null;
  ref.publicationType = type ?? (entry.type === 'misc' || entry.type === 'unpublished' || entry.type === 'online' ? (arxiv ? 'preprint' : 'other') : 'other');

  ref.venue = text(entry, 'journal') ?? text(entry, 'journaltitle') ?? text(entry, 'booktitle');
  ref.publisher = text(entry, 'publisher') ?? text(entry, 'school') ?? text(entry, 'institution');
  ref.volume = text(entry, 'volume');
  ref.issue = text(entry, 'number');
  ref.pages = text(entry, 'pages');
  ref.doi = normalizeDoi(text(entry, 'doi'));
  ref.abstract = text(entry, 'abstract');
  ref.issn = (text(entry, 'issn') ?? '')
    .split(/[,;\s]+/)
    .map((v) => normalizeIssn(v))
    .filter((v): v is string => !!v);
  ref.keywords = (text(entry, 'keywords') ?? '')
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);
  const url = safeUrl(text(entry, 'url'));
  ref.url = url;

  const extra: BibField[] = [];
  for (const f of entry.fields) {
    if (!keepVerbatim(f.name, ref)) continue;
    extra.push(f.bare ? { name: f.name, value: f.raw, bare: true } : { name: f.name, value: f.value });
  }
  ref.extraFields = extra;
  ref.localSource = {
    format: 'bibtex',
    type: entry.type,
    key: entry.key,
    line: entry.line,
    fields: entry.fields.map((f) => ({ name: f.name, raw: f.raw })),
  };
  return ref;
}

/** Read a `.bib` file. Malformed entries become warnings; every valid entry is returned. */
export function importBibtex(source: string): ParsedImport {
  const parsed = parseBibtex(source);
  const warnings = parsed.errors.map((e) => ({ line: e.line, message: e.message }));
  const seen = new Map<string, number>();
  const references: ImportedReference[] = [];
  for (const entry of parsed.entries) {
    const lower = entry.key.toLowerCase();
    const first = seen.get(lower);
    if (first !== undefined) {
      warnings.push({ line: entry.line, message: `Key "${entry.key}" is used again (first on line ${first}); both entries are imported and the second gets a new key` });
    } else seen.set(lower, entry.line);
    references.push(referenceFromBibEntry(entry));
  }
  return { references, warnings };
}
