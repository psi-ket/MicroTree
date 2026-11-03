CREATE TABLE `document_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`section_id` text,
	`block_type` text NOT NULL,
	`block_order` integer NOT NULL,
	`content` text NOT NULL,
	`plain_text` text NOT NULL,
	`source_xml_id` text,
	`element_id` text,
	`sentence_source` text NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_blocks_order_uq` ON `document_blocks` (`extraction_id`,`block_order`);--> statement-breakpoint
CREATE INDEX `document_blocks_section_idx` ON `document_blocks` (`section_id`);--> statement-breakpoint
CREATE TABLE `document_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`section_id` text,
	`element_type` text NOT NULL,
	`element_order` integer NOT NULL,
	`label` text,
	`caption` text,
	`content` text,
	`source_xml_id` text,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_elements_order_uq` ON `document_elements` (`extraction_id`,`element_order`);--> statement-breakpoint
CREATE TABLE `document_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`attachment_id` text NOT NULL,
	`library_item_id` text NOT NULL,
	`scholarly_work_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`extractor` text NOT NULL,
	`extractor_version` text,
	`parser_version` text NOT NULL,
	`segmenter_version` text NOT NULL,
	`config` text NOT NULL,
	`config_hash` text NOT NULL,
	`status` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`language` text,
	`page_count` integer,
	`pages` text DEFAULT '[]' NOT NULL,
	`metadata` text NOT NULL,
	`quality` text NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`processing_started_at` text NOT NULL,
	`processing_completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `library_attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extractions_active_uq` ON `document_extractions` (`attachment_id`) WHERE "document_extractions"."is_active" = 1;--> statement-breakpoint
CREATE INDEX `document_extractions_attachment_idx` ON `document_extractions` (`attachment_id`);--> statement-breakpoint
CREATE INDEX `document_extractions_item_idx` ON `document_extractions` (`library_item_id`);--> statement-breakpoint
CREATE INDEX `document_extractions_sha_idx` ON `document_extractions` (`source_sha256`);--> statement-breakpoint
CREATE TABLE `document_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`attachment_id` text NOT NULL,
	`library_item_id` text NOT NULL,
	`config_hash` text NOT NULL,
	`status` text NOT NULL,
	`progress` real,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`previous_extraction_id` text,
	`extraction_id` text,
	`notes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `library_attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_jobs_unfinished_uq` ON `document_jobs` (`attachment_id`,`config_hash`) WHERE "document_jobs"."status" NOT IN ('completed', 'partial', 'needs_ocr', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX `document_jobs_status_idx` ON `document_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `document_jobs_created_idx` ON `document_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `document_passages` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`section_id` text,
	`parent_block_id` text,
	`block_ids` text DEFAULT '[]' NOT NULL,
	`passage_order` integer NOT NULL,
	`kind` text NOT NULL,
	`section_path` text NOT NULL,
	`section_type` text NOT NULL,
	`text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`text_hash` text NOT NULL,
	`stable_key` text NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	`token_count` integer NOT NULL,
	`language` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_passages_order_uq` ON `document_passages` (`extraction_id`,`passage_order`);--> statement-breakpoint
CREATE INDEX `document_passages_hash_idx` ON `document_passages` (`text_hash`);--> statement-breakpoint
CREATE INDEX `document_passages_stable_idx` ON `document_passages` (`stable_key`);--> statement-breakpoint
CREATE TABLE `document_raw_outputs` (
	`extraction_id` text PRIMARY KEY NOT NULL,
	`format` text NOT NULL,
	`encoding` text NOT NULL,
	`content` blob NOT NULL,
	`size_bytes` integer NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `document_references` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`reference_order` integer NOT NULL,
	`raw_reference` text,
	`parsed_metadata` text NOT NULL,
	`doi` text,
	`arxiv_id` text,
	`source_xml_id` text,
	`linked_scholarly_work_id` text,
	`resolution_status` text DEFAULT 'unresolved' NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_scholarly_work_id`) REFERENCES `scholarly_works`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_references_order_uq` ON `document_references` (`extraction_id`,`reference_order`);--> statement-breakpoint
CREATE INDEX `document_references_doi_idx` ON `document_references` (`doi`);--> statement-breakpoint
CREATE INDEX `document_references_arxiv_idx` ON `document_references` (`arxiv_id`);--> statement-breakpoint
CREATE TABLE `document_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`parent_section_id` text,
	`heading` text NOT NULL,
	`heading_number` text,
	`section_level` integer NOT NULL,
	`section_order` integer NOT NULL,
	`section_path` text NOT NULL,
	`section_type` text NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_sections_order_uq` ON `document_sections` (`extraction_id`,`section_order`);--> statement-breakpoint
CREATE TABLE `document_sentences` (
	`id` text PRIMARY KEY NOT NULL,
	`extraction_id` text NOT NULL,
	`block_id` text NOT NULL,
	`passage_id` text,
	`sentence_order` integer NOT NULL,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`extraction_id`) REFERENCES `document_extractions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_sentences_block_idx` ON `document_sentences` (`block_id`,`sentence_order`);--> statement-breakpoint
CREATE INDEX `document_sentences_passage_idx` ON `document_sentences` (`passage_id`);--> statement-breakpoint
CREATE TABLE `embedding_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`model_version` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_spaces_uq` ON `embedding_spaces` (`provider`,`model`,`dimensions`,`model_version`);--> statement-breakpoint
CREATE TABLE `embedding_vectors` (
	`space_id` text NOT NULL,
	`text_hash` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`space_id`, `text_hash`),
	FOREIGN KEY (`space_id`) REFERENCES `embedding_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `passage_embeddings` (
	`space_id` text NOT NULL,
	`passage_id` text NOT NULL,
	`extraction_id` text NOT NULL,
	`text_hash` text NOT NULL,
	`embedded_at` text NOT NULL,
	PRIMARY KEY(`space_id`, `passage_id`),
	FOREIGN KEY (`space_id`) REFERENCES `embedding_spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`passage_id`) REFERENCES `document_passages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passage_embeddings_extraction_idx` ON `passage_embeddings` (`space_id`,`extraction_id`);--> statement-breakpoint
-- Keyword index over passages (FTS5). The body is the normalised search text
-- (the original text stays in document_passages.text). Underscores stay inside
-- tokens (H_2); hyphens split, so "qubit-level" matches "qubit level".
CREATE VIRTUAL TABLE `passage_fts` USING fts5(
	`body`,
	`heading`,
	`passage_id` UNINDEXED,
	`extraction_id` UNINDEXED,
	`kind` UNINDEXED,
	`section_type` UNINDEXED,
	tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
--> statement-breakpoint
CREATE TRIGGER `document_passages_fts_delete` AFTER DELETE ON `document_passages` BEGIN
	DELETE FROM `passage_fts` WHERE `passage_id` = old.`id`;
END;
