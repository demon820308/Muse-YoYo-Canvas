// Drizzle schema for the YoYo Bridge space.
//
// Two tables only — the bridge is deliberately self-contained (no
// canvas projects / nodes / graph): bridge_config is the single
// pairing row (id fixed 'bridge'); bridge_jobs is the job ledger,
// one row per local job, carrying its payload and its result until
// the result has been delivered back to the local side and the row
// is slimmed to its audit fields at cleanup.
//
// Timestamps are plain integer milliseconds (the bridge contract's
// wire shape), not timestamp-mode columns.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bridgeConfig = sqliteTable("bridge_config", {
  id: text("id").primaryKey(),
  baseUrl: text("base_url").notNull().default(""),
  token: text("token").notNull().default(""),
  lastOnlineAt: integer("last_online_at"),
  lastError: text("last_error"),
  lastErrorAt: integer("last_error_at"),
  syncLeaseUntil: integer("sync_lease_until"),
  syncLeaseOwner: text("sync_lease_owner"),
  updatedAt: integer("updated_at").notNull(),
});

export const bridgeJobs = sqliteTable("bridge_jobs", {
  jobId: text("job_id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status", {
    enum: ["queued", "working", "done", "failed", "delivered", "cleaned"],
  })
    .notNull()
    .default("queued"),
  localProjectId: text("local_project_id"),
  localNodeId: text("local_node_id"),
  payload: text("payload").notNull().default("{}"),
  jobDir: text("job_dir"),
  resultType: text("result_type", { enum: ["media", "text"] }),
  resultText: text("result_text"),
  resultFilePath: text("result_file_path"),
  resultFileName: text("result_file_name"),
  resultContentType: text("result_content_type"),
  resultTitle: text("result_title"),
  genSize: text("gen_size"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
