-- Reverses 0004_visual. Not applied automatically. Run it by hand on a
-- backup, then remove the newest row from __drizzle_migrations. Files in
-- <RS_DATA_DIR>/visual and anything inserted into projects are not touched.
DROP TABLE IF EXISTS `visual_insertions`;
DROP TABLE IF EXISTS `visual_tasks`;
DROP TABLE IF EXISTS `visual_artifact_versions`;
DROP TABLE IF EXISTS `visual_artifacts`;
DROP TABLE IF EXISTS `visual_assets`;
