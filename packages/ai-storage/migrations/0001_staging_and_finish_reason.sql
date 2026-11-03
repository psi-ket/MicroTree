CREATE TABLE `ai_staging_workspaces` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`state` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_staging_last_active_idx` ON `ai_staging_workspaces` (`last_active_at`);--> statement-breakpoint
ALTER TABLE `ai_messages` ADD `finish_reason` text;