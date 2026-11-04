import type { BibChangeLike } from './citation-key-resolver';

/**
 * Which of a `.bib` preview's changes a citation needs: only adding the
 * entry (or missing fields) for the cited items. Existing entries are never
 * rewritten; collisions are reported, not resolved.
 */
export function bibChangesFor(itemIds: readonly string[], changes: readonly (BibChangeLike & { id: string })[]): { changeIds: string[]; collisions: string[]; messages: string[] } {
  const mine = changes.filter((c) => itemIds.includes(c.libraryItemId));
  return {
    changeIds: mine.filter((c) => c.applicable && c.kind === 'add-entry').map((c) => c.id),
    collisions: mine.filter((c) => c.kind === 'key-collision').map((c) => c.message),
    messages: mine.filter((c) => c.kind !== 'unchanged').map((c) => c.message),
  };
}
