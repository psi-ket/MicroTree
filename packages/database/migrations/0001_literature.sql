CREATE TABLE `literature_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`retrieved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`size_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `literature_cache_expires_idx` ON `literature_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `literature_cache_provider_idx` ON `literature_cache` (`provider`);--> statement-breakpoint
CREATE TABLE `literature_provider_state` (
	`provider` text PRIMARY KEY NOT NULL,
	`last_success_at` text,
	`last_error_at` text,
	`last_error_kind` text,
	`last_error` text,
	`rate_limit` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `literature_search_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`request` text NOT NULL,
	`result_count` integer NOT NULL,
	`providers` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `literature_search_history_created_idx` ON `literature_search_history` (`created_at`);