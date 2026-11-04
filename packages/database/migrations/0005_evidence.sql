CREATE TABLE `citation_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`scholarly_work_id` text,
	`library_item_id` text,
	`citation_key` text NOT NULL,
	`key_source` text NOT NULL,
	`recommended_placement` text NOT NULL,
	`evidence_assessment_id` text,
	`evidence_record_id` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`proposal_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scholarly_work_id`) REFERENCES `scholarly_works`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `citation_recommendations_claim_idx` ON `citation_recommendations` (`claim_id`);--> statement-breakpoint
CREATE TABLE `claim_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`block_id` text NOT NULL,
	`sentence_id` text,
	`section_id` text,
	`section_path` text NOT NULL,
	`parent_block_id` text,
	`text_snapshot` text NOT NULL,
	`prefix_context` text NOT NULL,
	`suffix_context` text NOT NULL,
	`text_hash` text NOT NULL,
	`revision` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`structure_path` text NOT NULL,
	`mapping_status` text NOT NULL,
	`previous_text` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_anchors_claim_id_unique` ON `claim_anchors` (`claim_id`);--> statement-breakpoint
CREATE INDEX `claim_anchors_file_idx` ON `claim_anchors` (`project_id`,`file_path`);--> statement-breakpoint
CREATE TABLE `conflict_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`supporting_record_id` text NOT NULL,
	`opposing_record_id` text NOT NULL,
	`category` text NOT NULL,
	`explanation` text NOT NULL,
	`differences` text DEFAULT '[]' NOT NULL,
	`uncertainty` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conflict_analyses_claim_idx` ON `conflict_analyses` (`claim_id`);--> statement-breakpoint
CREATE TABLE `evidence_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`evidence_record_id` text NOT NULL,
	`assessment` text NOT NULL,
	`explanation` text NOT NULL,
	`supporting_text` text,
	`excerpt_verified` integer NOT NULL,
	`supported_subclaims` text DEFAULT '[]' NOT NULL,
	`unsupported_subclaims` text DEFAULT '[]' NOT NULL,
	`contradictory_statements` text DEFAULT '[]' NOT NULL,
	`limitations` text DEFAULT '[]' NOT NULL,
	`uncertainty` text NOT NULL,
	`validation_notes` text DEFAULT '[]' NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`assessment_version` text NOT NULL,
	`claim_text_hash` text NOT NULL,
	`source_snapshot_hash` text NOT NULL,
	`status` text NOT NULL,
	`job_id` text,
	`created_at` text NOT NULL,
	`superseded_at` text,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_record_id`) REFERENCES `evidence_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_assessments_record_idx` ON `evidence_assessments` (`evidence_record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evidence_assessments_claim_idx` ON `evidence_assessments` (`claim_id`,`status`);--> statement-breakpoint
CREATE TABLE `evidence_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`progress` text NOT NULL,
	`result` text,
	`error` text,
	`provider_id` text,
	`provider_kind` text,
	`model_id` text,
	`privacy_mode` text,
	`consent_at` text,
	`outgoing` text,
	`usage` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_jobs_project_idx` ON `evidence_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evidence_jobs_status_idx` ON `evidence_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `evidence_records` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`source_id` text NOT NULL,
	`retrieval_method` text NOT NULL,
	`query_variant` text,
	`relevance_rank` integer,
	`keyword_rank` integer,
	`semantic_rank` integer,
	`fused_score` real,
	`retrieval_index_version` text,
	`claim_text_hash` text NOT NULL,
	`status` text NOT NULL,
	`retrieved_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `evidence_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_records_uq` ON `evidence_records` (`claim_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `evidence_records_source_idx` ON `evidence_records` (`source_id`);--> statement-breakpoint
CREATE TABLE `evidence_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`evidence_record_id` text,
	`assessment_id` text,
	`decision` text NOT NULL,
	`reclassified_as` text,
	`note` text,
	`actor` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `scientific_claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_record_id`) REFERENCES `evidence_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_reviews_claim_idx` ON `evidence_reviews` (`claim_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `evidence_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_hash` text NOT NULL,
	`level` text NOT NULL,
	`scholarly_work_id` text,
	`library_item_id` text,
	`attachment_id` text,
	`extraction_id` text,
	`passage_id` text,
	`stable_key` text,
	`passage_text_hash` text,
	`source_sha256` text,
	`extractor_version` text,
	`external_id` text,
	`doi` text,
	`arxiv_id` text,
	`url` text,
	`title` text NOT NULL,
	`authors` text DEFAULT '[]' NOT NULL,
	`year` integer,
	`venue` text,
	`publication_type` text,
	`section_path` text,
	`page_start` integer,
	`page_end` integer,
	`coordinates` text DEFAULT '[]' NOT NULL,
	`text` text NOT NULL,
	`context_before` text,
	`context_after` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scholarly_work_id`) REFERENCES `scholarly_works`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`library_item_id`) REFERENCES `library_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_sources_snapshot_hash_unique` ON `evidence_sources` (`snapshot_hash`);--> statement-breakpoint
CREATE INDEX `evidence_sources_passage_idx` ON `evidence_sources` (`passage_id`);--> statement-breakpoint
CREATE INDEX `evidence_sources_stable_idx` ON `evidence_sources` (`stable_key`);--> statement-breakpoint
CREATE INDEX `evidence_sources_work_idx` ON `evidence_sources` (`scholarly_work_id`);--> statement-breakpoint
CREATE TABLE `manuscript_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`kind` text NOT NULL,
	`section_id` text,
	`section_path` text NOT NULL,
	`parent_block_id` text,
	`block_order` integer NOT NULL,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`prefix_context` text NOT NULL,
	`suffix_context` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`structure_path` text NOT NULL,
	`revision_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manuscript_blocks_file_idx` ON `manuscript_blocks` (`project_id`,`file_path`,`block_order`);--> statement-breakpoint
CREATE INDEX `manuscript_blocks_hash_idx` ON `manuscript_blocks` (`project_id`,`text_hash`);--> statement-breakpoint
CREATE TABLE `manuscript_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`document_revision` text NOT NULL,
	`review_scope` text NOT NULL,
	`scope_detail` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`coverage` text,
	`result` text,
	`model_provider` text,
	`model_id` text,
	`prompt_version` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manuscript_reviews_project_idx` ON `manuscript_reviews` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `manuscript_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_hash` text NOT NULL,
	`parser_version` text NOT NULL,
	`block_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manuscript_revisions_file_idx` ON `manuscript_revisions` (`project_id`,`file_path`,`created_at`);--> statement-breakpoint
CREATE TABLE `manuscript_sentences` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sentence_order` integer NOT NULL,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `manuscript_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manuscript_sentences_block_idx` ON `manuscript_sentences` (`block_id`,`sentence_order`);--> statement-breakpoint
CREATE INDEX `manuscript_sentences_hash_idx` ON `manuscript_sentences` (`project_id`,`text_hash`);--> statement-breakpoint
CREATE TABLE `scientific_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_block_id` text NOT NULL,
	`sentence_id` text,
	`original_text` text NOT NULL,
	`claim_text` text NOT NULL,
	`span_start` integer,
	`span_end` integer,
	`normalized_text` text NOT NULL,
	`claim_type` text NOT NULL,
	`atomicity` text NOT NULL,
	`entities` text DEFAULT '[]' NOT NULL,
	`concepts` text DEFAULT '[]' NOT NULL,
	`quantities` text DEFAULT '[]' NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`text_hash` text NOT NULL,
	`document_revision` text NOT NULL,
	`status` text NOT NULL,
	`review_state` text NOT NULL,
	`requires_evidence` integer NOT NULL,
	`exclusion_reason` text,
	`derived_from` text DEFAULT '[]' NOT NULL,
	`extracted_by` text NOT NULL,
	`model_provider` text,
	`model_id` text,
	`prompt_version` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scientific_claims_project_idx` ON `scientific_claims` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `scientific_claims_block_idx` ON `scientific_claims` (`document_block_id`);--> statement-breakpoint
CREATE INDEX `scientific_claims_hash_idx` ON `scientific_claims` (`project_id`,`text_hash`);--> statement-breakpoint
CREATE TABLE `writing_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`document_block_id` text,
	`file_path` text NOT NULL,
	`original_text` text NOT NULL,
	`proposed_text` text,
	`suggestion_type` text NOT NULL,
	`explanation` text NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`meaning_check` text,
	`proposal_id` text,
	`model_provider` text,
	`model_id` text,
	`prompt_version` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `writing_suggestions_project_idx` ON `writing_suggestions` (`project_id`,`created_at`);