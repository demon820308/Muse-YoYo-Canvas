DROP TABLE IF EXISTS `entries`;
--> statement-breakpoint
CREATE TABLE `bridge_config` (
	`id` text PRIMARY KEY NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`token` text DEFAULT '' NOT NULL,
	`last_online_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`sync_lease_until` integer,
	`sync_lease_owner` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bridge_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`local_project_id` text,
	`local_node_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`job_dir` text,
	`result_type` text,
	`result_text` text,
	`result_file_path` text,
	`result_file_name` text,
	`result_content_type` text,
	`result_title` text,
	`gen_size` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
