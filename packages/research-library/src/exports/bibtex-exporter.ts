import { bibtexEntry, formatBibtexEntry, type BibtexField } from '@research-studio/literature-engine/format';
import type { BibField, ScholarlyWork } from '@research-studio/shared-types';

export interface BibtexExportable {
  /** The work as shown (provider metadata with the user's corrections). */
  work: ScholarlyWork;
  citationKey: string;
  /** Entry type to use instead of the one derived from the publication type (e.g. kept from an imported `.bib`). */
  bibtexType: string | null;
  /** Fields kept verbatim from the source; written after the generated ones unless a generated field has the same name. */
  bibtexExtra: BibField[];
}

const VENUE_FIELD: Record<string, string> = {
  article: 'journal',
  inproceedings: 'booktitle',
  conference: 'booktitle',
  incollection: 'booktitle',
  inbook: 'booktitle',
};
const PUBLISHER_FIELD: Record<string, string> = {
  phdthesis: 'school',
  mastersthesis: 'school',
  thesis: 'institution',
  techreport: 'institution',
  report: 'institution',
};

/** The fields one item exports, in order. */
export function itemBibtexFields(item: BibtexExportable): { type: string; fields: BibtexField[] } {
  const generated = bibtexEntry(item.work);
  const type = (item.bibtexType ?? generated.type).toLowerCase();
  let fields = generated.fields;
  if (type !== generated.type) {
    // Move the venue and publisher to the fields the chosen entry type uses.
    const venue = fields.find((f) => f.name === 'journal' || f.name === 'booktitle');
    const publisher = fields.find((f) => f.name === 'publisher' || f.name === 'school' || f.name === 'institution');
    fields = fields.filter((f) => f !== venue && f !== publisher);
    const at = Math.min(2, fields.length);
    if (venue && VENUE_FIELD[type]) fields.splice(at, 0, { name: VENUE_FIELD[type]!, value: venue.value });
    else if (venue) fields.splice(at, 0, { name: 'howpublished', value: venue.value });
    if (publisher) fields.push({ name: PUBLISHER_FIELD[type] ?? 'publisher', value: publisher.value });
  }
  const names = new Set(fields.map((f) => f.name));
  for (const extra of item.bibtexExtra) {
    const name = extra.name.toLowerCase();
    if (names.has(name) || !/^[a-z][a-z0-9_\-:.+]*$/.test(name)) continue;
    names.add(name);
    fields.push({ name, value: extra.value, ...(extra.bare ? { bare: true } : {}) });
  }
  return { type, fields };
}

export function itemToBibtex(item: BibtexExportable): string {
  const { type, fields } = itemBibtexFields(item);
  return formatBibtexEntry(type, item.citationKey, fields);
}

/** A `.bib` file for several items, in the given order. */
export function exportBibtex(items: readonly BibtexExportable[], header?: string): string {
  const parts = items.map(itemToBibtex);
  const head = header ? `${header.split('\n').map((l) => `% ${l}`.trimEnd()).join('\n')}\n\n` : '';
  return head + parts.join('\n');
}
