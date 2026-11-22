// bridge-deliver.ts — 桥的回送与清理：在途任务的跟进（把行上存着
// 的结果回送本地）、回送后清理作业目录并把行瘦身为审计记录；外加
// 全量轮次的对账：本地待处理列表里已经消失的 queued 行（用户在
// 本地停止/取消、桥还没领取派发）结算为 failed，随后走正常 fail
// 回送路径收尾，不再永久冻结在待处理。
// 状态机转换一律经 bridge-store 的守卫转换，本文件不直写 status。

import type { Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import {
getBridgeJob,
listBridgeJobsByStatus,
transitionBridgeJob,
updateBridgeConfig,
type BridgeJobRow,
type Db,
} from "./bridge-store";
import {
BridgeUnreachableError,
type BridgeResultReply,
type BridgeTransport,
} from "./bridge-transport";
import { errMsg } from "./bridge-executor";

const MAX_FOLLOW_UP_PER_ROUND = 10;

export type SyncCounts = {
  claimed: number;
  dispatched: number;
  delivered: number;
  cleaned: number;
  failed: number;
};

export function zeroCounts(): SyncCounts {
  return { claimed: 0, dispatched: 0, delivered: 0, cleaned: 0, failed: 0 };
}

/** Tears down a delivered job's working directory (best-effort) and
 * slim-marks its audit row cleaned: payload and result payloads are
 * dropped, only the ledger facts (jobId / kind / status / error /
 * genSize / timestamps) stay. */
export async function cleanupJob(
  ctx: Ctx,
  db: Db,
  row: BridgeJobRow,
  counts: SyncCounts,
): Promise<void> {
  if (row.jobDir) {
    try {
      await ctx.executePrivileged(Contracts.deleteJobDir, {
        dirName: row.jobDir,
      });
    } catch {
      // Directory cleanup is best-effort; the row still slim-marks.
    }
  }
  await db
    .update(schema.bridgeJobs)
    .set({
      payload: "{}",
      resultText: null,
      resultFilePath: null,
      updatedAt: Date.now(),
    })
    .where(eq(schema.bridgeJobs.jobId, row.jobId));
  if (await transitionBridgeJob(db, row.jobId, ["delivered"], "cleaned")) {
    counts.cleaned += 1;
  }
}

async function deliverFailRow(
  ctx: Ctx,
  db: Db,
  transport: BridgeTransport,
  row: BridgeJobRow,
  counts: SyncCounts,
): Promise<void> {
  await transport.postFail(row.jobId, row.error ?? "生成失败");
  if (await transitionBridgeJob(db, row.jobId, ["failed"], "delivered")) {
    counts.failed += 1;
    counts.delivered += 1;
    const fresh = await getBridgeJob(db, row.jobId);
    await cleanupJob(ctx, db, fresh ?? row, counts);
  }
}

/** Handles a local-side {status:"failed"} answer to a result post:
 * the job flips to failed with the local error, that failure is
 * posted back through the fail path, and the row walks to cleaned. */
async function settleResultRejected(
  ctx: Ctx,
  db: Db,
  transport: BridgeTransport,
  row: BridgeJobRow,
  reply: BridgeResultReply,
  counts: SyncCounts,
): Promise<void> {
  const error = reply.error ?? "本地落地失败";
  await transitionBridgeJob(db, row.jobId, ["done"], "failed", { error });
  counts.failed += 1;
  const fresh = await getBridgeJob(db, row.jobId);
  if (fresh && fresh.status === "failed") {
    await transport.postFail(row.jobId, error);
    if (await transitionBridgeJob(db, row.jobId, ["failed"], "delivered")) {
      counts.delivered += 1;
      const deliveredRow = await getBridgeJob(db, row.jobId);
      await cleanupJob(ctx, db, deliveredRow ?? fresh, counts);
    }
  }
}

async function settleResultAccepted(
  ctx: Ctx,
  db: Db,
  row: BridgeJobRow,
  counts: SyncCounts,
): Promise<void> {
  if (await transitionBridgeJob(db, row.jobId, ["done"], "delivered")) {
    counts.delivered += 1;
    const fresh = await getBridgeJob(db, row.jobId);
    await cleanupJob(ctx, db, fresh ?? row, counts);
  }
}

async function followUpRow(
  ctx: Ctx,
  db: Db,
  transport: BridgeTransport,
  row: BridgeJobRow,
  counts: SyncCounts,
): Promise<void> {
  if (row.status === "failed") {
    await deliverFailRow(ctx, db, transport, row, counts);
    return;
  }
  if (row.status !== "done") return; // working: still in flight, leave it
  if (row.resultType === "text") {
    const reply = await transport.postResultText(
      row.jobId,
      row.resultText ?? "",
    );
    if (reply.status === "done") {
      await settleResultAccepted(ctx, db, row, counts);
    } else if (reply.status === "failed") {
      await settleResultRejected(ctx, db, transport, row, reply, counts);
    }
    return;
  }
  if (row.resultType === "media") {
    if (!row.resultFilePath) return; // No bytes to send yet; next round
    const file = await ctx.executePrivileged(Contracts.readJobFile, {
      path: row.resultFilePath,
    });
    const bytes = Buffer.from(file.dataBase64, "base64");
    const reply = await transport.postResultMedia(row.jobId, {
      fileName:
        row.resultFileName ??
        row.resultFilePath.split("/").filter(Boolean).pop() ??
        "result",
      title: row.resultTitle,
      contentType: row.resultContentType ?? file.contentType,
      bytes,
    });
    if (reply.status === "done") {
      await settleResultAccepted(ctx, db, row, counts);
    } else if (reply.status === "failed") {
      await settleResultRejected(ctx, db, transport, row, reply, counts);
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan reconciliation (full rounds only)
// ---------------------------------------------------------------------------

/** How long a queued row must have gone untouched before its absence
 * from the local pending list is read as a local cancellation. The
 * grace window keeps a row that is merely waiting behind the
 * per-round claim cap (or mid-retry) from being settled on a single
 * round's snapshot. */
export const ORPHANED_QUEUED_GRACE_MS = 60_000;

export const ORPHANED_QUEUED_ERROR =
  "本地已取消该任务：桥侧对账时本地待处理列表已无此任务，自动结算（未执行）";

const MAX_RECONCILE_PER_ROUND = 10;

/** Settles queued rows the local side no longer offers. The caller
 * passes the jobId set from THIS round's successful /bridge/pending
 * fetch — reconciliation never runs on a stale or failed fetch, so
 * absence here means the local side has dropped the job (stopped or
 * cancelled before the bridge claimed it). Settled rows land in
 * `failed` with the reason on the row; the round's follow-up phase
 * then delivers that failure through the normal fail path and the
 * row walks on to cleaned, exactly like any other failed job. */
export async function reconcileOrphanedQueued(
  db: Db,
  pendingJobIds: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<void> {
  const queued = await listBridgeJobsByStatus(db, ["queued"]);
  let settled = 0;
  for (const row of queued) {
    if (settled >= MAX_RECONCILE_PER_ROUND) break;
    if (pendingJobIds.has(row.jobId)) continue;
    if (now - row.updatedAt < ORPHANED_QUEUED_GRACE_MS) continue;
    if (
      await transitionBridgeJob(db, row.jobId, ["queued"], "failed", {
        error: ORPHANED_QUEUED_ERROR,
      })
    ) {
      settled += 1;
    }
  }
}

/** In-flight follow-up shared by both sync modes. An unreachable
 * local side stops the round's remaining deliveries (rows keep
 * their state for the next round) and flags the round aborted;
 * any other per-row failure is recorded and the round moves on. */
export async function followUpInFlight(
  ctx: Ctx,
  db: Db,
  transport: BridgeTransport,
  counts: SyncCounts,
): Promise<{ aborted: boolean }> {
  const rows = await listBridgeJobsByStatus(
    db,
    ["working", "done", "failed"],
    MAX_FOLLOW_UP_PER_ROUND,
  );
  for (const row of rows) {
    try {
      await followUpRow(ctx, db, transport, row, counts);
    } catch (err) {
      await updateBridgeConfig(db, {
        lastError: errMsg(err),
        lastErrorAt: Date.now(),
      });
      if (err instanceof BridgeUnreachableError) return { aborted: true };
    }
  }
  return { aborted: false };
}
