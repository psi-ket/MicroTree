import type { PublicationType, ScholarlyWork } from '@research-studio/shared-types';

const RIS_TYPE: Record<PublicationType, string> = {
  'journal-article': 'JOUR',
  review: 'JOUR',
  editorial: 'JOUR',
  letter: 'JOUR',
  erratum: 'JOUR',
  'conference-paper': 'CPAPER',
  preprint: 'UNPB',
  book: 'BOOK',
  'book-chapter': 'CHAP',
  dissertation: 'THES',
  report: 'RPRT',
  dataset: 'DATA',
  other: 'GEN',
};

export interface RisExportable {
  work: ScholarlyWork;
  citationKey: string | null;
  tags: string[];
}

/** One-line RIS values: newlines and tabs become spaces. */
const clean = (v: string) => v.replace(/[\r\n\t]+/g, ' ').trim();

export function itemToRis(item: RisExportable): string {
  const w = item.work;
  const lines: string[] = [];
  const add = (tag: string, value: string | null | undefined) => {
    if (value && clean(value)) lines.push(`${tag}  - ${clean(value)}`);
  };
  add('TY', RIS_TYPE[w.publicationType ?? 'other']);
  add('ID', item.citationKey);
  add('TI', w.title);
  for (const a of w.authors) add('AU', a.familyName ? [a.familyName, a.givenName].filter(Boolean).join(', ') : a.name);
  add('T2', w.venue);
  add('PY', w.publicationYear?.toString());
  if (w.publicationDate && w.publicationDate.length > 4) add('DA', w.publicationDate.replace(/-/g, '/'));
  add('VL', w.bibliographic.volume);
  add('IS', w.bibliographic.issue);
  if (w.bibliographic.pages) {
    const [sp, ep] = w.bibliographic.pages.split(/\s*[-‐-―]+\s*/);
    add('SP', sp);
    add('EP', ep);
  }
  add('PB', w.publisher);
  for (const issn of w.bibliographic.issn) add('SN', issn);
  add('DO', w.identifiers.doi);
  add('UR', w.identifiers.doi ? `https://doi.org/${w.identifiers.doi}` : (w.urls.landingPage ?? (w.identifiers.arxivId ? `https://arxiv.org/abs/${w.identifiers.arxivId}` : null)));
  if (w.identifiers.arxivId && w.identifiers.doi) add('L2', `https://arxiv.org/abs/${w.identifiers.arxivId}`);
  add('AB', w.abstract);
  for (const tag of item.tags) add('KW', tag);
  lines.push('ER  - ');
  return lines.join('\n');
}

export function exportRis(items: readonly RisExportable[]): string {
  return items.map(itemToRis).join('\n\n') + (items.length ? '\n' : '');
}
