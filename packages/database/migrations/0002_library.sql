CREATE TABLE `library_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`library_item_id` text NOT NULL,
	`file_name` text NOT NULL,
	`original_file_name` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`attachment_type` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_attachments_item_sha_uq` ON `library_attachments` (`library_item_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `library_attachments_sha_idx` ON `library_attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `library_collection_items` (
	`collection_id` text NOT NULL,
	`library_item_id` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`collection_id`, `library_item_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `library_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_collection_items_item_idx` ON `library_collection_items` (`library_item_id`);--> statement-breakpoint
CREATE TABLE `library_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_collections_name_uq` ON `library_collections` (lower("name"));--> statement-breakpoint
CREATE TABLE `library_external_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_library_id` text NOT NULL,
	`external_collection_id` text NOT NULL,
	`external_version` integer,
	`last_synced_at` text,
	FOREIGN KEY (`collection_id`) REFERENCES `library_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_external_collections_remote_uq` ON `library_external_collections` (`provider`,`external_library_id`,`external_collection_id`);--> statement-breakpoint
CREATE TABLE `library_external_links` (
	`id` text PRIMARY KEY NOT NULL,
	`library_item_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_library_id` text NOT NULL,
	`external_item_id` text NOT NULL,
	`external_version` integer,
	`last_synced_at` text,
	`sync_status` text NOT NULL,
	`remote_snapshot` text,
	`local_fingerprint` text,
	`conflict` text,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_external_links_remote_uq` ON `library_external_links` (`provider`,`external_library_id`,`external_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_external_links_local_uq` ON `library_external_links` (`provider`,`external_library_id`,`library_item_id`);--> statement-breakpoint
CREATE TABLE `library_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`total` integer NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `library_import_jobs_created_idx` ON `library_import_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `library_item_tags` (
	`library_item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`library_item_id`, `tag_id`),
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `library_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_item_tags_tag_idx` ON `library_item_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `library_items` (
	`id` text PRIMARY KEY NOT NULL,
	`scholarly_work_id` text NOT NULL,
	`citation_key` text,
	`reading_status` text DEFAULT 'to-read' NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`metadata_status` text NOT NULL,
	`match` text,
	`bibtex_type` text,
	`bibtex_extra` text DEFAULT '[]' NOT NULL,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_opened_at` text,
	`archived_at` text,
	FOREIGN KEY (`scholarly_work_id`) REFERENCES `scholarly_works`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_items_scholarly_work_id_unique` ON `library_items` (`scholarly_work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_items_citation_key_uq` ON `library_items` (lower("citation_key"));--> statement-breakpoint
CREATE INDEX `library_items_added_idx` ON `library_items` (`added_at`);--> statement-breakpoint
CREATE INDEX `library_items_status_idx` ON `library_items` (`reading_status`);--> statement-breakpoint
CREATE INDEX `library_items_opened_idx` ON `library_items` (`last_opened_at`);--> statement-breakpoint
CREATE TABLE `library_project_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`library_item_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_project_links_uq` ON `library_project_links` (`project_id`,`library_item_id`);--> statement-breakpoint
CREATE INDEX `library_project_links_item_idx` ON `library_project_links` (`library_item_id`);--> statement-breakpoint
CREATE TABLE `library_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_tags_name_uq` ON `library_tags` (lower("name"));--> statement-breakpoint
CREATE TABLE `scholarly_works` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_id` text,
	`origin` text NOT NULL,
	`work` text NOT NULL,
	`local_source` text,
	`user_edits` text DEFAULT '{}' NOT NULL,
	`doi` text,
	`arxiv_id` text,
	`title_key` text NOT NULL,
	`first_author_key` text,
	`authors_key` text DEFAULT '' NOT NULL,
	`year` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scholarly_works_canonical_id_unique` ON `scholarly_works` (`canonical_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scholarly_works_doi_unique` ON `scholarly_works` (`doi`);--> statement-breakpoint
CREATE UNIQUE INDEX `scholarly_works_arxiv_id_unique` ON `scholarly_works` (`arxiv_id`);--> statement-breakpoint
CREATE INDEX `scholarly_works_title_idx` ON `scholarly_works` (`title_key`);--> statement-breakpoint
CREATE INDEX `scholarly_works_year_idx` ON `scholarly_works` (`year`);