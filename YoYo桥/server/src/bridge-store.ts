// bridge-store.ts — 桥的数据事实源：bridge_config 单行配置、
// bridge_jobs 任务台账（守卫式状态机）、DB 支撑的同步租约。
// 桥任务是自包含记录：载荷与结果都存在行上，没有影子项目/节点。

import type { SpaceDb } from "@hatch/space-sdk";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = SpaceDb<typeof schema>;
export type BridgeConfigRow = typeof schema.bridgeConfig.$inferSelect;
export type BridgeJobRow = typeof schema.bridgeJobs.$inferSelect;
export type BridgeJobStatus = BridgeJobRow["status"];

export const BRIDGE_CONFIG_ID = "bridge";

/** Reads the single bridge config row, creating it with defaults on
 * first touch so every other store function can assume it exists. */
export async function getBridgeConfig(db: Db): Promise<BridgeConfigRow> {
  const rows = await db
    .select()
    .from(schema.bridgeConfig)
    .where(eq(schema.bridgeConfig.id, BRIDGE_CONFIG_ID))
    .limit(1);
  if (rows[0]) return rows[0];
  const now = Date.now();
  await db
    .insert(schema.bridgeConfig)
    .values({ id: BRIDGE_CONFIG_ID, updatedAt: now })
    .onConflictDoNothing();
  const again = await db
    .select()
    .from(schema.bridgeConfig)
    .where(eq(schema.bridgeConfig.id, BRIDGE_CONFIG_ID))
    .limit(1);
  return (
    again[0] ?? {
      id: BRIDGE_CONFIG_ID,
      baseUrl: "",
      token: "",
      lastOnlineAt: null,
      lastError: null,
      lastErrorAt: null,
      syncLeaseUntil: null,
      syncLeaseOwner: null,
      updatedAt: now,
    }
  );
}

export async function updateBridgeConfig(
  db: Db,
  patch: Partial<Omit<BridgeConfigRow, "id" | "updatedAt">>,
): Promise<BridgeConfigRow> {
  await getBridgeConfig(db);
  await db
    .update(schema.bridgeConfig)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.bridgeConfig.id, BRIDGE_CONFIG_ID));
  return getBridgeConfig(db);
}

/** The only shape a bridge token may ever leave the server in: empty
 * stays empty, short tokens are fully masked, longer ones keep just
 * the first 3 and last 2 characters around a fixed bullet run. */
export function maskBridgeToken(token: string | null | undefined): string {
  if (!token) return "";
  if (token.length <= 6) return "••••••";
  return `${token.slice(0, 3)}••••${token.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Job ledger
// ---------------------------------------------------------------------------

/** Inserts a freshly seen local job. jobId is the idempotency key: a
 * job the bridge already knows returns false and is left untouched. */
export async function insertBridgeJob(
  db: Db,
  job: {
    jobId: string;
    kind: string;
    localProjectId: string | null;
    localNodeId: string | null;
    payload: string;
  },
): Promise<boolean> {
  const now = Date.now();
  const inserted = await db
    .insert(schema.bridgeJobs)
    .values({
      jobId: job.jobId,
      kind: job.kind,
      localProjectId: job.localProjectId,
      localNodeId: job.localNodeId,
      payload: job.payload,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ jobId: schema.bridgeJobs.jobId });
  return inserted.length > 0;
}

export async function getBridgeJob(
  db: Db,
  jobId: string,
): Promise<BridgeJobRow | null> {
  const rows = await db
    .select()
    .from(schema.bridgeJobs)
    .where(eq(schema.bridgeJobs.jobId, jobId))
    .limit(1);
  return rows[0] ?? null;
}

/** The bridge job state machine's legal edges. queued may settle
 * synchronously at dispatch time (→ done/failed) or go in flight
 * (→ working); a working/done run may still flip to failed when the
 * local side rejects the delivered result; failed and done both end
 * at delivered (the outcome reached the local side), and delivered
 * ends at cleaned (the job directory is torn down, the row slimmed). */
const LEGAL_TRANSITIONS: Record<BridgeJobStatus, readonly BridgeJobStatus[]> = {
  queued: ["working", "done", "failed"],
  working: ["done", "failed", "delivered"],
  done: ["failed", "delivered"],
  failed: ["delivered"],
  delivered: ["cleaned"],
  cleaned: [],
};

export type BridgeJobPatch = Partial<
  Pick<
    BridgeJobRow,
    | "error"
    | "jobDir"
    | "resultType"
    | "resultText"
    | "resultFilePath"
    | "resultFileName"
    | "resultContentType"
    | "resultTitle"
    | "genSize"
  >
>;

/** Guarded state transition: the row moves to `toStatus` only while
 * its current status is one of `fromStatuses` AND the edge exists in
 * the state machine. Out-of-order moves return false — callers treat
 * that as "someone else already moved it" and stop. The final update
 * re-checks the status it validated, so a race cannot slip through. */
export async function transitionBridgeJob(
  db: Db,
  jobId: string,
  fromStatuses: readonly BridgeJobStatus[],
  toStatus: BridgeJobStatus,
  patch: BridgeJobPatch = {},
): Promise<boolean> {
  if (fromStatuses.length === 0) return false;
  const current = await getBridgeJob(db, jobId);
  if (!current) return false;
  if (!fromStatuses.includes(current.status)) return false;
  const legal = LEGAL_TRANSITIONS[current.status];
if (!legal || !legal.includes(toStatus)) return false;
  const moved = await db
    .update(schema.bridgeJobs)
    .set({ status: toStatus, updatedAt: Date.now(), ...patch })
    .where(
      and(
        eq(schema.bridgeJobs.jobId, jobId),
        eq(schema.bridgeJobs.status, current.status),
      ),
    )
    .returning({ jobId: schema.bridgeJobs.jobId });
  return moved.length > 0;
}

/** Updates a job row's non-status fields (job dir, result pointers)
 * without touching the state machine. */
export async function patchBridgeJob(
  db: Db,
  jobId: string,
  patch: BridgeJobPatch,
): Promise<void> {
  await db
    .update(schema.bridgeJobs)
    .set({ updatedAt: Date.now(), ...patch })
    .where(eq(schema.bridgeJobs.jobId, jobId));
}

export async function listBridgeJobsByStatus(
  db: Db,
  statuses: readonly BridgeJobStatus[],
  limit?: number,
): Promise<BridgeJobRow[]> {
  if (statuses.length === 0) return [];
  const query = db
    .select()
    .from(schema.bridgeJobs)
    .where(inArray(schema.bridgeJobs.status, [...statuses]))
    .orderBy(asc(schema.bridgeJobs.createdAt));
  return limit != null ? query.limit(limit) : query;
}

export async function listRecentBridgeJobs(
  db: Db,
  limit: number,
): Promise<BridgeJobRow[]> {
  return db
    .select()
    .from(schema.bridgeJobs)
    .orderBy(desc(schema.bridgeJobs.createdAt))
    .limit(limit);
}

export async function countBridgeJobsByStatus(
  db: Db,
  status: BridgeJobStatus,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bridgeJobs)
    .where(eq(schema.bridgeJobs.status, status));
  return rows[0]?.n ?? 0;
}

/** A row counts as a "failed record" the user can clear when it is
 * still in failed state, or it already walked to cleaned/delivered
 * but still carries a failure error (the audit ledger keeps the
 * error after cleanup, so a failed generation stays visible as a
 * cleaned row with an error until it is explicitly cleared). */
function clearableFailedWhere() {
  return or(
    eq(schema.bridgeJobs.status, "failed"),
    and(
      inArray(schema.bridgeJobs.status, ["cleaned", "delivered"]),
      isNotNull(schema.bridgeJobs.error),
    ),
  );
}

export async function listClearableFailedJobs(
  db: Db,
): Promise<BridgeJobRow[]> {
  const where = clearableFailedWhere();
  if (!where) return [];
  return db
    .select()
    .from(schema.bridgeJobs)
    .where(where)
    .orderBy(asc(schema.bridgeJobs.createdAt));
}

export async function countClearableFailedJobs(db: Db): Promise<number> {
  const where = clearableFailedWhere();
  if (!where) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bridgeJobs)
    .where(where);
  return rows[0]?.n ?? 0;
}

/** Hard-deletes the given job rows. Returns how many were removed. */
export async function deleteBridgeJobsByIds(
  db: Db,
  jobIds: string[],
): Promise<number> {
  if (jobIds.length === 0) return 0;
  const deleted = await db
    .delete(schema.bridgeJobs)
    .where(inArray(schema.bridgeJobs.jobId, jobIds))
    .returning({ jobId: schema.bridgeJobs.jobId });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Sync lease (DB-backed; action processes are stateless)
// ---------------------------------------------------------------------------

/** Takes the sync lease when it is free or expired. The conditional
 * update is the whole lock: exactly one racing round can move
 * syncLeaseUntil from an expired value to its own deadline. */
export async function acquireSyncLease(
  db: Db,
  owner: string,
  ttlMs = 300_000,
): Promise<boolean> {
  await getBridgeConfig(db);
  const now = Date.now();
  const taken = await db
    .update(schema.bridgeConfig)
    .set({
      syncLeaseUntil: now + ttlMs,
      syncLeaseOwner: owner,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.bridgeConfig.id, BRIDGE_CONFIG_ID),
        sql`(${schema.bridgeConfig.syncLeaseUntil} is null or ${schema.bridgeConfig.syncLeaseUntil} <= ${now})`,
      ),
    )
    .returning({ id: schema.bridgeConfig.id });
  return taken.length > 0;
}

export async function releaseSyncLease(db: Db, owner: string): Promise<void> {
  await db
    .update(schema.bridgeConfig)
    .set({ syncLeaseUntil: null, syncLeaseOwner: null, updatedAt: Date.now() })
    .where(
      and(
        eq(schema.bridgeConfig.id, BRIDGE_CONFIG_ID),
        eq(schema.bridgeConfig.syncLeaseOwner, owner),
      ),
    );
}
