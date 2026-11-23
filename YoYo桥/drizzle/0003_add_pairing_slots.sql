UPDATE `bridge_config` SET `id` = 'bridge-1' WHERE `id` = 'bridge';
--> statement-breakpoint
ALTER TABLE `bridge_jobs` ADD COLUMN `pairing_id` text;
