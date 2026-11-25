// bridge-store.ts — 桥的数据事实源：bridge_config 两行配对配置
// （槽位 1 = 'bridge-1'、槽位 2 = 'bridge-2'，各自独立的地址/令牌/
// 在线与错误/同步租约）、bridge_jobs 任务台账（守卫式状态机，每行
// 带 pairing_id 标明归属槽位；存量行 pairing_id 为空一律按槽位 1）。
// 桥任务是自包含记录：载荷与结果都存在行上，没有影子项目/节点。

import type { SpaceDb } from "@hatch/space-sdk";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = SpaceDb<typeof schema>;
export type BridgeConfigRow = typeof schema.bridgeConfig.$inferSelect;
export type BridgeJobRow = typeof schema.bridgeJobs.$inferSelect;
export type BridgeJobStatus = BridgeJobRow["status"];

/** The bridge has exactly two pairing slots, numbered 1 and 2. */
export type PairingSlot = 1 | 2;

export const PAIRING_SLOTS: readonly PairingSlot[] = [1, 2];

/** bridge_config row id for a slot. */
export function configIdForSlot(slot: PairingSlot): string {
  return slot === 2 ? "bridge-2" : "bridge-1";
}

/** The pairing_id stored on job rows for a slot. */
export function pairingIdForSlot(slot: PairingSlot): string {
  return configIdForSlot(slot);
}

/** Which slot a stored pairing_id belongs to. Legacy rows predate
 * slots and carry null — they always count as slot 1. */
export function slotOfPairingId(
  pairingId: string | null | undefined,
): PairingSlot {
  return pairingId === "bridge-2" ? 2 : 1;
}

/** The effective pairing_id of a job row (legacy null → slot 1). */
export function effectivePairingId(row: BridgeJobRow): string {
  return pairingIdForSlot(slotOfPairingId(row.pairingId));
}

/** Reads one slot's config row, creating it with defaults on first
 * touch so every other store function can assume it exists. */
export async function getBridgeConfig(
  db: Db,
  slot: PairingSlot,
): Promise<BridgeConfigRow> {
  const id = configIdForSlot(slot);
  const rows = await db
    .select()
    .from(schema.bridgeConfig)
    .where(eq(schema.bridgeConfig.id, id))
    .limit(1);
  if (rows[0]) return rows[0];
  const now = Date.now();
  await db
    .insert(schema.bridgeConfig)
    .values({ id, updatedAt: now })
    .onConflictDoNothing();
  const again = await db
    .select()
    .from(schema.bridgeConfig)
    .where(eq(schema.bridgeConfig.id, id))
    .limit(1);
  return (
    again[0] ?? {
      id,
      label: "",
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
  slot: PairingSlot,
  patch: Partial<Omit<BridgeConfigRow, "id" | "updatedAt">>,
): Promise<BridgeConfigRow> {
  await getBridgeConfig(db, slot);
  await db
    .update(schema.bridgeConfig)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.bridgeConfig.id, configIdForSlot(slot)));
  return getBridgeConfig(db, slot);
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
// Connection state (single source of truth, computed at response time)
// ---------------------------------------------------------------------------

/** A paired slot counts as connected while its last successful sync
 * is within this window. Sync rounds run every 5 seconds, so 30s
 * tolerates roughly six missed rounds before a slot reads as
 * disconnected — a single flaky round never flickers the badge. */
export const CONNECTION_ONLINE_WINDOW_MS = 30_000;

export type PairingConnection = "unpaired" | "connected" | "disconnected";

/** Pure connection判定 for one slot at moment `now` (ms epoch):
 * no base URL or no token → unpaired; paired but never online, or
 * last online older than the window → disconnected; paired and
 * last online within the window (boundary inclusive) → connected. */
export function pairingConnection(
  config: Pick<BridgeConfigRow, "baseUrl" | "token" | "lastOnlineAt">,
  now: number,
): PairingConnection {
  if (!config.baseUrl || !config.token) return "unpaired";
  if (config.lastOnlineAt == null) return "disconnected";
  return now - config.lastOnlineAt <= CONNECTION_ONLINE_WINDOW_MS
    ? "connected"
    : "disconnected";
}

// ---------------------------------------------------------------------------
// Job ledger
// ---------------------------------------------------------------------------

/** Inserts a freshly seen local job, stamped with the pairing slot
 * that claimed it. jobId is the idempotency key: a job the bridge
 * already knows returns false and is left untouched. */
export async function insertBridgeJob(
  db: Db,
  job: {
    jobId: string;
    kind: string;
    localProjectId: string | null;
    localNodeId: string | null;
    pairingId: string;
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
      pairingId: job.pairingId,
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

/** SQL condition matching rows owned by one slot. Slot 1 also owns
 * the legacy rows whose pairing_id is still null. */
function pairingWhere(slot: PairingSlot) {
  const id = pairingIdForSlot(slot);
  return slot === 1
    ? or(eq(schema.bridgeJobs.pairingId, id), isNull(schema.bridgeJobs.pairingId))
    : eq(schema.bridgeJobs.pairingId, id);
}

export async function listBridgeJobsByStatus(
  db: Db,
  statuses: readonly BridgeJobStatus[],
  limit?: number,
  slot?: PairingSlot,
): Promise<BridgeJobRow[]> {
  if (statuses.length === 0) return [];
  const statusWhere = inArray(schema.bridgeJobs.status, [...statuses]);
  const where = slot != null ? and(statusWhere, pairingWhere(slot)) : statusWhere;
  const query = db
    .select()
    .from(schema.bridgeJobs)
    .where(where)
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
// Sync lease (DB-backed, one per slot; action processes are stateless)
// ---------------------------------------------------------------------------

/** Takes one slot's sync lease when it is free or expired. The
 * conditional update is the whole lock: exactly one racing round
 * per slot can move that slot's syncLeaseUntil from an expired
 * value to its own deadline. Leases are per-slot, so a round on
 * slot 1 never blocks slot 2. */
export async function acquireSyncLease(
  db: Db,
  slot: PairingSlot,
  owner: string,
  ttlMs = 300_000,
): Promise<boolean> {
  await getBridgeConfig(db, slot);
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
        eq(schema.bridgeConfig.id, configIdForSlot(slot)),
        sql`(${schema.bridgeConfig.syncLeaseUntil} is null or ${schema.bridgeConfig.syncLeaseUntil} <= ${now})`,
      ),
    )
    .returning({ id: schema.bridgeConfig.id });
  return taken.length > 0;
}

export async function releaseSyncLease(
  db: Db,
  slot: PairingSlot,
  owner: string,
): Promise<void> {
  await db
    .update(schema.bridgeConfig)
    .set({ syncLeaseUntil: null, syncLeaseOwner: null, updatedAt: Date.now() })
    .where(
      and(
        eq(schema.bridgeConfig.id, configIdForSlot(slot)),
        eq(schema.bridgeConfig.syncLeaseOwner, owner),
      ),
    );
}
