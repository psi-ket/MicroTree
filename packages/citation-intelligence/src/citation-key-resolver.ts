/** The parts of a `.bib` preview change the resolver needs (structurally typed). */
export interface BibChangeLike {
  id?: string;
  kind: 'add-entry' | 'add-fields' | 'existing-key-for-doi' | 'key-collision' | 'unchanged' | 'missing-key';
  libraryItemId: string;
  citationKey: string | null;
  applicable: boolean;
  existingKey?: string;
  message: string;
}

export type KeySource = 'bib-existing' | 'bib' | 'library' | 'none';

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
  /** A reviewed `.bib` change is needed before the citation compiles. */
  needsBibChange: boolean;
  collision: boolean;
  problems: string[];
}

/**
 * The key to cite a library item with: the key the project's `.bib` already
 * uses for the same work (matched by DOI, arXiv ID or title), else the
 * library's key (with a `.bib` entry to add), never a key that the file uses
 * for a different work.
 */
export function resolveCitationKey(item: { id: string; citationKey: string | null }, changes: readonly BibChangeLike[]): ResolvedKey {
  const mine = changes.filter((c) => c.libraryItemId === item.id);
  const existing = mine.find((c) => c.kind === 'existing-key-for-doi' && c.existingKey);
  if (existing) return { key: existing.existingKey!, source: 'bib-existing', needsBibChange: false, collision: false, problems: [] };
  const collision = mine.find((c) => c.kind === 'key-collision');
  if (collision) return { key: item.citationKey, source: 'library', needsBibChange: false, collision: true, problems: [collision.message] };
  const missing = mine.find((c) => c.kind === 'missing-key');
  if (missing || !item.citationKey) return { key: null, source: 'none', needsBibChange: false, collision: false, problems: [missing?.message ?? 'The library item has no citation key.'] };
  const add = mine.find((c) => (c.kind === 'add-entry' || c.kind === 'add-fields') && c.applicable);
  if (add?.kind === 'add-entry') return { key: item.citationKey, source: 'library', needsBibChange: true, collision: false, problems: [] };
  return { key: item.citationKey, source: 'bib', needsBibChange: !!add, collision: false, problems: [] };
}
