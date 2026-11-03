-- Hand-edited: foreign keys to `projects` (created by @research-studio/database
-- migrations, which always run first) were added after generation.
CREATE TABLE `ai_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`permission` text NOT NULL,
	`status` text NOT NULL,
	`external_session_id` text,
	`model` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`usage` text,
	`changed_files` text NOT NULL,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_agent_runs_project_idx` ON `ai_agent_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`mode` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text,
	`title` text NOT NULL,
	`agent_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_conversations_project_idx` ON `ai_conversations` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`action` text,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`context` text NOT NULL,
	`usage` text,
	`error` text,
	`edit_issues` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_messages_conversation_idx` ON `ai_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `ai_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`agent_run_id` text,
	`source` text NOT NULL,
	`action` text,
	`block_index` integer,
	`file` text NOT NULL,
	`change_type` text NOT NULL,
	`base_hash` text,
	`original` text NOT NULL,
	`proposed` text NOT NULL,
	`range_start` integer,
	`range_end` integer,
	`explanation` text NOT NULL,
	`warnings` text NOT NULL,
	`status` text NOT NULL,
	`applied_hash` text,
	`previous_content` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_proposals_project_idx` ON `ai_proposals` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_proposals_message_idx` ON `ai_proposals` (`message_id`);--> statement-breakpoint
CREATE INDEX `ai_proposals_file_idx` ON `ai_proposals` (`project_id`,`file`,`status`);--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`base_url` text,
	`default_model` text,
	`enabled` integer DEFAULT true NOT NULL,
	`secret_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_agent_approvals` (
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`permission` text NOT NULL,
	`approved_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `agent_id`, `permission`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
