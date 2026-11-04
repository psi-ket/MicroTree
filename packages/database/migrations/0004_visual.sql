CREATE TABLE `visual_artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`source_code` text NOT NULL,
	`structured_data` text,
	`data_csv` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`origin` text NOT NULL,
	`change_description` text NOT NULL,
	`packages` text DEFAULT '[]' NOT NULL,
	`compilation_status` text DEFAULT 'not-compiled' NOT NULL,
	`diagnostics` text DEFAULT '[]' NOT NULL,
	`compile_log` text,
	`preview_asset_id` text,
	`task_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `visual_artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visual_artifact_versions_uq` ON `visual_artifact_versions` (`artifact_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `visual_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`project_id` text,
	`source_asset_id` text,
	`current_version` integer NOT NULL,
	`approval` text DEFAULT 'draft' NOT NULL,
	`approved_at` text,
	`approved_version` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `visual_artifacts_updated_idx` ON `visual_artifacts` (`updated_at`);--> statement-breakpoint
CREATE INDEX `visual_artifacts_project_idx` ON `visual_artifacts` (`project_id`);--> statement-breakpoint
CREATE TABLE `visual_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_asset_id` text,
	`original_asset_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`operations` text DEFAULT '[]' NOT NULL,
	`preprocess_version` text,
	`provenance` text NOT NULL,
	`label` text NOT NULL,
	`project_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `visual_assets_original_idx` ON `visual_assets` (`original_asset_id`);--> statement-breakpoint
CREATE INDEX `visual_assets_sha_idx` ON `visual_assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `visual_assets_created_idx` ON `visual_assets` (`created_at`);--> statement-breakpoint
CREATE TABLE `visual_insertions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`created_files` text NOT NULL,
	`modified_files` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`rolled_back_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `visual_insertions_project_idx` ON `visual_insertions` (`project_id`);--> statement-breakpoint
CREATE TABLE `visual_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`resolved_type` text,
	`project_id` text,
	`source_asset_id` text,
	`input_asset_id` text,
	`source_attachment_id` text,
	`source_page` integer,
	`provider_id` text,
	`provider_kind` text,
	`model` text,
	`privacy_mode` text NOT NULL,
	`consent_at` text,
	`prompt_version` text NOT NULL,
	`config` text NOT NULL,
	`status` text NOT NULL,
	`progress` text,
	`error` text,
	`choices` text,
	`usage` text,
	`artifact_id` text,
	`artifact_version` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `visual_tasks_created_idx` ON `visual_tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `visual_tasks_status_idx` ON `visual_tasks` (`status`);