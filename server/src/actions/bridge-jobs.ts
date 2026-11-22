// [yoyo-local] 本地桥任务：生成三通道（spawnTask / generate_media /
// inference）在本地版的统一落点。本文件是本地版新增文件，云端版没有。
//
// 语义（S1 第四/五节）：本地点生成只组装任务数据并写入本地队列，
// 节点置 working 且 genTaskId = jobId——带 genTaskId 的节点被
// queue-sweep 的孤儿回收豁免，于是稳定停在「等待云端生成」状态，
// 直到桥（第三步）把结果经 /bridge/result 送回并走既有 complete*
// 落地链。桥未配对时任务同样入队，只是无人拉取。
//
// 任务表 local_bridge_jobs 是本地专用表（不在云端迁移 0001–0014
// 内），由 ensureBridgeJobsTable 幂等建出。状态机：
// queued → claimed → done / failed（result/fail 落地后结算）。

import { and, asc, eq, inArray } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import * as schema from "../schema";
import type { Db, NodeRow } from "./contracts";

/** 本地生成通道的「已入队」信号：ctx 的本地实现抛出它，三个调用点
 * （直出图 / 配置文本 / 提示词逆推）捕获后走 queueNodeForBridge。
 * 用品牌字段识别，避免跨打包副本 instanceof 失效（与 SDK 的
 * InferenceSchemaError 同一手法）。 */
export class BridgeQueuedError extends Error {
  readonly bridgeQueued = true as const;
  readonly channel: string;
  constructor(channel: string) {
    super(`本地版：${channel} 已转入本地桥队列等待云端生成`);
    this.name = "BridgeQueuedError";
    this.channel = channel;
  }
}

export function isBridgeQueuedError(value: unknown): value is BridgeQueuedError {
  return (
    value instanceof BridgeQueuedError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { bridgeQueued?: unknown }).bridgeQueued === true)
  );
}

export const localBridgeJobs = sqliteTable("local_bridge_jobs", {
  jobId: text("job_id").primaryKey(),
  // task-image | task-video | task-audio | direct-image | text | prompt-reverse
  kind: text("kind").notNull(),
  // queued | claimed | done | failed
  status: text("status").notNull().default("queued"),
  projectId: text("project_id"),
  nodeId: text("node_id"),
  expectsAction: text("expects_action"),
  dedupeKey: text("dedupe_key"),
  payload: text("payload").notNull().default("{}"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type BridgeJobRow = typeof localBridgeJobs.$inferSelect;

export async function ensureBridgeJobsTable(db: Db): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS local_bridge_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      project_id TEXT,
      node_id TEXT,
      expects_action TEXT,
      dedupe_key TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_bridge_jobs_status ON local_bridge_jobs (status, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_bridge_jobs_dedupe ON local_bridge_jobs (dedupe_key, status)`,
  );
}

export type BridgeJobSpec = {
  kind: string;
  projectId?: string | null;
  nodeId?: string | null;
  expectsAction?: string | null;
  dedupeKey?: string | null;
  payload: unknown;
};

/** 建一条桥任务。同 dedupeKey 已有未结（queued/claimed）任务时直接
 * 返回既有任务——沿用平台 spawnTask 的单飞语义，重复点击不重复生成。 */
export async function cancelNodeBridgeJobs(
  db: Db,
  nodeId: string,
): Promise<void> {
  await ensureBridgeJobsTable(db);
  await db
    .update(localBridgeJobs)
    .set({
      status: "failed",
      error: "用户已停止/取消",
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(localBridgeJobs.nodeId, nodeId),
        inArray(localBridgeJobs.status, ["queued", "claimed"]),
      ),
    );
}

export async function createBridgeJob(
  db: Db,
  spec: BridgeJobSpec,
): Promise<BridgeJobRow> {
  await ensureBridgeJobsTable(db);
  if (spec.dedupeKey) {
    const existing = await db
      .select()
      .from(localBridgeJobs)
      .where(
        and(
          eq(localBridgeJobs.dedupeKey, spec.dedupeKey),
          inArray(localBridgeJobs.status, ["queued", "claimed"]),
        ),
      )
      .orderBy(asc(localBridgeJobs.createdAt));
    const found = existing[0];
    if (found) return found;
  }
  const now = Date.now();
  const row: BridgeJobRow = {
    jobId: crypto.randomUUID(),
    kind: spec.kind,
    status: "queued",
    projectId: spec.projectId ?? null,
    nodeId: spec.nodeId ?? null,
    expectsAction: spec.expectsAction ?? null,
    dedupeKey: spec.dedupeKey ?? null,
    payload: JSON.stringify(spec.payload ?? {}),
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(localBridgeJobs).values(row);
  return row;
}

/** 入队并把节点置为等待态：genStatus=working + genTaskId=jobId。
 * 返回 jobId（调用方据此向前端回 working）。 */
export async function queueNodeForBridge(
  db: Db,
  node: NodeRow,
  spec: BridgeJobSpec,
): Promise<string> {
  const job = await createBridgeJob(db, {
    ...spec,
    projectId: spec.projectId ?? node.projectId,
    nodeId: spec.nodeId ?? node.id,
    dedupeKey: spec.dedupeKey ?? `yoyo-bridge-${spec.kind}-${node.id}`,
  });
  await db
    .update(schema.canvasNodes)
    .set({
      genStatus: "working",
      genTaskId: job.jobId,
      genError: null,
      status: "loading",
      updatedAt: new Date(),
    })
    .where(eq(schema.canvasNodes.id, node.id));
  return job.jobId;
}

export async function getBridgeJob(
  db: Db,
  jobId: string,
): Promise<BridgeJobRow | null> {
  await ensureBridgeJobsTable(db);
  const rows = await db
    .select()
    .from(localBridgeJobs)
    .where(eq(localBridgeJobs.jobId, jobId));
  return rows[0] ?? null;
}

export async function listPendingBridgeJobs(db: Db): Promise<BridgeJobRow[]> {
  await ensureBridgeJobsTable(db);
  return db
    .select()
    .from(localBridgeJobs)
    .where(eq(localBridgeJobs.status, "queued"))
    .orderBy(asc(localBridgeJobs.createdAt));
}

/** 认领：queued → claimed。已 claimed 时幂等返回当前行；已结算
 * （done/failed）返回 null，调用方据此拒绝重复处理。 */
export async function claimBridgeJob(
  db: Db,
  jobId: string,
): Promise<BridgeJobRow | null> {
  const job = await getBridgeJob(db, jobId);
  if (!job) return null;
  if (job.status === "claimed") return job;
  if (job.status !== "queued") return null;
  await db
    .update(localBridgeJobs)
    .set({ status: "claimed", updatedAt: Date.now() })
    .where(
      and(
        eq(localBridgeJobs.jobId, jobId),
        eq(localBridgeJobs.status, "queued"),
      ),
    );
  return getBridgeJob(db, jobId);
}

/** 结算：done / failed。已结算的任务不重复结算（幂等）。 */
export async function settleBridgeJob(
  db: Db,
  jobId: string,
  status: "done" | "failed",
  error?: string | null,
): Promise<BridgeJobRow | null> {
  const job = await getBridgeJob(db, jobId);
  if (!job) return null;
  if (job.status === "done" || job.status === "failed") return job;
  await db
    .update(localBridgeJobs)
    .set({ status, error: error ?? null, updatedAt: Date.now() })
    .where(eq(localBridgeJobs.jobId, jobId));
  return getBridgeJob(db, jobId);
}
