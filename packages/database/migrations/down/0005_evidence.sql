-- Reverses 0005_evidence. Not applied automatically. Run it by hand on a
-- backup, then remove the newest row from __drizzle_migrations. The library,
-- full-text index and project files are not touched.
DROP TABLE IF EXISTS `evidence_jobs`;
DROP TABLE IF EXISTS `manuscript_reviews`;
DROP TABLE IF EXISTS `writing_suggestions`;
DROP TABLE IF EXISTS `citation_recommendations`;
DROP TABLE IF EXISTS `conflict_analyses`;
DROP TABLE IF EXISTS `evidence_reviews`;
DROP TABLE IF EXISTS `evidence_assessments`;
DROP TABLE IF EXISTS `evidence_records`;
DROP TABLE IF EXISTS `evidence_sources`;
DROP TABLE IF EXISTS `claim_anchors`;
DROP TABLE IF EXISTS `scientific_claims`;
DROP TABLE IF EXISTS `manuscript_sentences`;
DROP TABLE IF EXISTS `manuscript_blocks`;
DROP TABLE IF EXISTS `manuscript_revisions`;
