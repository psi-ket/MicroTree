import type Database from 'better-sqlite3';
import type { SqliteVectorStore } from '../vector-search/vector-store';

/**
 * Index upkeep. Replacing or deleting an extraction removes its passages;
 * the delete trigger removes their keyword rows and the foreign key removes
 * their vector links. What is left to clean is cached vectors no passage uses
 * and keyword rows of extractions that no longer exist (defensive).
 */
export function sweepIndexes(sqlite: Database.Database, vectors: SqliteVectorStore): { vectorsRemoved: number; keywordRowsRemoved: number } {
  const keywordRowsRemoved = sqlite.prepare('DELETE FROM passage_fts WHERE passage_id NOT IN (SELECT id FROM document_passages)').run().changes;
  const vectorsRemoved = vectors.sweep();
  vectors.invalidate();
  return { vectorsRemoved, keywordRowsRemoved };
}
