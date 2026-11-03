CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`actor` text,
	`project_id` text,
	`target` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_project_idx` ON `audit_events` (`project_id`);--> statement-breakpoint
CREATE TABLE `compilation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`engine` text NOT NULL,
	`main_file` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	`exit_code` integer,
	`pdf_available` integer DEFAULT false NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`diagnostics` text DEFAULT '[]' NOT NULL,
	`status_message` text,
	`output_tail` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `compilation_jobs_project_created_idx` ON `compilation_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`modified_at` text NOT NULL,
	`indexed_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_files_project_path_uq` ON `project_files` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`root_path` text NOT NULL,
	`main_file` text DEFAULT 'main.tex' NOT NULL,
	`engine` text DEFAULT 'pdflatex' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_opened_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
