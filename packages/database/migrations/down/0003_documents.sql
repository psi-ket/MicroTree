-- Reverses 0003_documents. Not applied automatically (drizzle migrations are
-- forward only). Run it by hand on a backup, then remove the 0003 row (the one
-- with the newest created_at) from __drizzle_migrations. Library items, works,
-- attachments and PDFs are not touched.
DROP TRIGGER IF EXISTS `document_passages_fts_delete`;
DROP TABLE IF EXISTS `passage_fts`;
DROP TABLE IF EXISTS `passage_embeddings`;
DROP TABLE IF EXISTS `embedding_vectors`;
DROP TABLE IF EXISTS `embedding_spaces`;
DROP TABLE IF EXISTS `document_jobs`;
DROP TABLE IF EXISTS `document_elements`;
DROP TABLE IF EXISTS `document_references`;
DROP TABLE IF EXISTS `document_sentences`;
DROP TABLE IF EXISTS `document_passages`;
DROP TABLE IF EXISTS `document_blocks`;
DROP TABLE IF EXISTS `document_sections`;
DROP TABLE IF EXISTS `document_raw_outputs`;
DROP TABLE IF EXISTS `document_extractions`;
