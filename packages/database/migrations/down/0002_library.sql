-- Reverses 0002_library. Not applied automatically (drizzle migrations are
-- forward only). Run it by hand on a backup, then remove the 0002 row (the one
-- with the newest created_at) from __drizzle_migrations, if the library tables
-- must be removed. Library PDFs
-- under <RS_DATA_DIR>/library are not touched by this script.
DROP TABLE IF EXISTS `library_import_jobs`;
DROP TABLE IF EXISTS `library_project_links`;
DROP TABLE IF EXISTS `library_external_collections`;
DROP TABLE IF EXISTS `library_external_links`;
DROP TABLE IF EXISTS `library_attachments`;
DROP TABLE IF EXISTS `library_item_tags`;
DROP TABLE IF EXISTS `library_tags`;
DROP TABLE IF EXISTS `library_collection_items`;
DROP TABLE IF EXISTS `library_collections`;
DROP TABLE IF EXISTS `library_items`;
DROP TABLE IF EXISTS `scholarly_works`;
