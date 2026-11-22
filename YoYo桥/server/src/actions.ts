// actions.ts — YoYo桥的全部动作：
//   bridgeSync / bridgeFastSync — 同步编排（全量轮拉新 + 对账
//     本地已取消的 queued 孤儿行 + 两轮都跑在途跟进）；未配置时
//     空转回 skipped，不发请求不抛错。
//   bridgeSetConfig / bridgeStatus — 配对设置面（令牌只以掩码出现）。
//   bridgeClearFailed — 清除失败记录（failed 行 + 已清理但带失败
//     原因的行），连带删作业目录；成功与在途记录不动。
//   completeBridgeJob / failBridgeJob — 后台生成任务的交付回调。
// 桥任务是自包含记录：没有画布的项目/节点/图结构。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import * as schema from "./schema";
import {
acquireSyncLease,
countBridgeJobsByStatus,
countClearableFailedJobs,
deleteBridgeJobsByIds,
getBridgeConfig,
getBridgeJob,
insertBridgeJob,
listClearableFailedJobs,
listRecentBridgeJobs,
maskBridgeToken,
releaseSyncLease,
transitionBridgeJob,
updateBridgeConfig,
type Db,
} from "./bridge-store";
import {
BridgeAuthError,
createBridgeTransport,
normalizeBridgeBaseUrl,
type BridgePendingJob,
type BridgeTransport,
} from "./bridge-transport";
import {
PermanentJobError,
SYNC_KINDS,
TASK_KINDS,
errMsg,
executeSyncJob,
jobDirName,
prepareTaskJob,
spawnPreparedTask,
validateSyncPayload,
} from "./bridge-executor";
import {
followUpInFlight,
reconcileOrphanedQueued,
zeroCounts,
type SyncCounts,
} from "./bridge-deliver";

const MAX_CLAIMS_PER_ROUND = 3;

const syncResponse = z.object({
  status: z.enum(["ok", "skipped"]),
  reason: z.string().nullable(),
  claimed: z.number(),
  dispatched: z.number(),
  delivered: z.number(),
  cleaned: z.number(),
  failed: z.number(),
});

type SyncResult = z.infer<typeof syncResponse>;

const ALL_PRIVILEGED = [
  Contracts.ensureJobDir,
  Contracts.writeJobFile,
  Contracts.readJobFile,
  Contracts.probeJobFile,
  Contracts.deleteJobFile,
  Contracts.deleteJobDir,
  Contracts.mirrorBlobToJobFile,
  Contracts.convertImageToPng,
  Contracts.shrinkImageForInference,
];

// ---------------------------------------------------------------------------
// Claim phase (full rounds only)
// ---------------------------------------------------------------------------

async function claimAndDispatch(
  ctx: Ctx,
  db: Db,
  transport: BridgeTransport,
  pending: BridgePendingJob[],
  counts: SyncCounts,
): Promise<void> {
  let handled = 0;
  for (const job of pending) {
    if (handled >= MAX_CLAIMS_PER_ROUND) break;
    const existing = await getBridgeJob(db, job.jobId);
    if (existing && existing.status !== "queued") continue;
    handled += 1;
    if (!existing) {
      const inserted = await insertBridgeJob(db, {
        jobId: job.jobId,
        kind: job.kind,
        localProjectId: job.projectId,
        localNodeId: job.nodeId,
        payload: JSON.stringify(job.payload ?? {}),
      });
      if (inserted) counts.claimed += 1;
    }
    const row = await getBridgeJob(db, job.jobId);
    if (!row || row.status !== "queued") continue;

    // Prepare: validate the payload, and for task-* jobs download
    // the reference files into the job directory first.
    let preparedMessage: string | null = null;
    if (TASK_KINDS.has(row.kind)) {
      try {
        preparedMessage = (await prepareTaskJob(ctx, db, transport, row)).message;
      } catch (err) {
        if (err instanceof PermanentJobError) {
          await transitionBridgeJob(db, row.jobId, ["queued"], "failed", {
            error: err.message,
          });
        } else {
          // Retryable: the row stays queued, config records why.
          await updateBridgeConfig(db, {
            lastError: errMsg(err),
            lastErrorAt: Date.now(),
          });
        }
        continue;
      }
    } else if (SYNC_KINDS.has(row.kind)) {
      const invalid = validateSyncPayload(row);
      if (invalid) {
        await transitionBridgeJob(db, row.jobId, ["queued"], "failed", {
          error: invalid,
        });
        continue;
      }
    } else {
      await transitionBridgeJob(db, row.jobId, ["queued"], "failed", {
        error: `未知任务类型：${row.kind || "(空)"}`,
      });
      continue;
    }

    try {
      await transport.ackClaim(job.jobId);
    } catch (err) {
      // Not claimed on the local side: no dispatch, row stays queued.
      await updateBridgeConfig(db, {
        lastError: errMsg(err),
        lastErrorAt: Date.now(),
      });
      continue;
    }

    counts.dispatched += 1;
    if (preparedMessage != null) {
      await spawnPreparedTask(ctx, db, row, preparedMessage);
    } else {
      await executeSyncJob(ctx, db, transport, row);
    }
  }
}

// ---------------------------------------------------------------------------
// Sync round
// ---------------------------------------------------------------------------

async function runSyncRound(ctx: Ctx, mode: "full" | "fast"): Promise<SyncResult> {
  const db = ctx.db<typeof schema>();
  const counts = zeroCounts();
  const config = await getBridgeConfig(db);
  if (!config.baseUrl || !config.token) {
    return { status: "skipped", reason: "not_configured", ...counts };
  }
  const owner = crypto.randomUUID();
  if (!(await acquireSyncLease(db, owner))) {
    return { status: "skipped", reason: "lease_held", ...counts };
  }
  try {
    const transport = createBridgeTransport({
      baseUrl: config.baseUrl,
      token: config.token,
    });
    if (mode === "full") {
      let pending: BridgePendingJob[];
      try {
        pending = await transport.getPending();
      } catch (err) {
        await updateBridgeConfig(db, {
          lastError: errMsg(err),
          lastErrorAt: Date.now(),
        });
        return {
          status: "skipped",
          reason: err instanceof BridgeAuthError ? "auth_failed" : "local_unreachable",
          ...counts,
        };
      }
      await updateBridgeConfig(db, {
        lastOnlineAt: Date.now(),
        lastError: null,
        lastErrorAt: null,
      });
      await claimAndDispatch(ctx, db, transport, pending, counts);
      // Reconcile against this round's fresh pending list: queued
      // rows the local side no longer offers were stopped/cancelled
      // locally before dispatch — settle them instead of leaving
      // them frozen in 待处理 forever.
      await reconcileOrphanedQueued(
        db,
        new Set(pending.map((job) => job.jobId)),
      );
    }
    const follow = await followUpInFlight(ctx, db, transport, counts);
    if (follow.aborted) {
      return { status: "skipped", reason: "local_unreachable", ...counts };
    }
    ctx.invalidateQueries();
    return { status: "ok", reason: null, ...counts };
  } finally {
    await releaseSyncLease(db, owner);
  }
}

// ---------------------------------------------------------------------------
// Delivery callbacks (completeBridgeJob / failBridgeJob)
// ---------------------------------------------------------------------------

const settleResponse = z.object({
  status: z.string(),
  error: z.string().nullable(),
});

type SettleResult = z.infer<typeof settleResponse>;

const MEDIA_PREFIX_BY_KIND: Record<string, string> = {
  "task-image": "image/",
  "task-video": "video/",
  "task-audio": "audio/",
};

async function settleComplete(
  ctx: Ctx,
  args: { jobId: string; filePath: string; title?: string },
): Promise<SettleResult> {
  const db = ctx.db<typeof schema>();
  const row = await getBridgeJob(db, args.jobId);
  if (!row) return { status: "failed", error: "任务不存在" };
  if (row.status !== "queued" && row.status !== "working") {
    // Already settled (done / failed / delivered / cleaned): a
    // repeated callback is idempotent and changes nothing.
    return { status: row.status, error: row.error };
  }
  const dirName = row.jobDir ?? jobDirName(row.jobId);
  const dir = await ctx.executePrivileged(Contracts.ensureJobDir, { dirName });
  const normalized = args.filePath.replace(/\\/g, "/");
  const dirNormalized = dir.path.replace(/\\/g, "/");
  if (!normalized.startsWith(`${dirNormalized}/`)) {
    const error = "成片不在本任务作业目录内，已拒绝回传";
    await transitionBridgeJob(db, row.jobId, ["queued", "working"], "failed", {
      error,
    });
    return { status: "failed", error };
  }
  let file: { dataBase64: string; sizeBytes: number; contentType: string };
  try {
    file = await ctx.executePrivileged(Contracts.readJobFile, {
      path: args.filePath,
    });
  } catch (err) {
    const error = `成片文件读取失败：${errMsg(err)}`;
    await transitionBridgeJob(db, row.jobId, ["queued", "working"], "failed", {
      error,
    });
    return { status: "failed", error };
  }
  const prefix = MEDIA_PREFIX_BY_KIND[row.kind];
  if (prefix && !file.contentType.startsWith(prefix)) {
    const error = `成片类型与任务不符：期望 ${prefix}*，实际 ${file.contentType}`;
    await transitionBridgeJob(db, row.jobId, ["queued", "working"], "failed", {
      error,
    });
    return { status: "failed", error };
  }
  const probe = await ctx.executePrivileged(Contracts.probeJobFile, {
    path: args.filePath,
  });
  const fileName =
    normalized.split("/").filter(Boolean).pop() ?? "result";
  const moved = await transitionBridgeJob(
    db,
    row.jobId,
    ["queued", "working"],
    "done",
    {
      jobDir: dirName,
      resultType: "media",
      resultFilePath: args.filePath,
      resultFileName: fileName,
      resultContentType: file.contentType,
      resultTitle: args.title ?? row.resultTitle,
      genSize:
        probe.width != null && probe.height != null
          ? `${probe.width}x${probe.height}`
          : null,
      error: null,
    },
  );
  if (!moved) {
    const fresh = await getBridgeJob(db, row.jobId);
    return { status: fresh?.status ?? "failed", error: fresh?.error ?? null };
  }
  ctx.invalidateQueries();
  return { status: "done", error: null };
}

async function settleFail(
  ctx: Ctx,
  args: { jobId: string; error: string },
): Promise<SettleResult> {
  const db = ctx.db<typeof schema>();
  const row = await getBridgeJob(db, args.jobId);
  if (!row) return { status: "failed", error: "任务不存在" };
  if (row.status === "queued" || row.status === "working") {
    await transitionBridgeJob(db, row.jobId, ["queued", "working"], "failed", {
      error: args.error,
    });
    ctx.invalidateQueries();
    return { status: "failed", error: args.error };
  }
  // Already settled: repeated failure callbacks are ignored.
  return { status: row.status, error: row.error };
}

const clearFailedResponse = z.object({
  deleted: z.number(),
});

type ClearFailedResult = z.infer<typeof clearFailedResponse>;

/** Deletes every clearable failed record: rows still in `failed`,
 * plus cleaned/delivered rows that still carry a failure error.
 * Job directories are torn down best-effort before the rows go.
 * In-flight (queued/working/done) and successful records are kept. */
async function clearFailedRecords(ctx: Ctx): Promise<ClearFailedResult> {
  const db = ctx.db<typeof schema>();
  const rows = await listClearableFailedJobs(db);
  if (rows.length === 0) return { deleted: 0 };
  for (const row of rows) {
    const dirName = row.jobDir ?? jobDirName(row.jobId);
    try {
      await ctx.executePrivileged(Contracts.deleteJobDir, { dirName });
    } catch {
      // Best-effort: a missing directory must not block the clear.
    }
  }
  const deleted = await deleteBridgeJobsByIds(
    db,
    rows.map((r) => r.jobId),
  );
  if (deleted > 0) ctx.invalidateQueries();
  return { deleted };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  bridgeSync: defineAction({
    description:
      "Full bridge sync round: pulls queued generation jobs from the paired local canvas through its tunnel, executes them in this space (direct generation, inference, or spawned tasks), delivers results back, and reconciles queued jobs the local side no longer offers (stopped/cancelled locally before dispatch) by settling them as failed so they never freeze in pending. Skips harmlessly when the bridge is not configured.",
    request: z.object({}),
    response: syncResponse,
    privileged: ALL_PRIVILEGED,
    handler: async (ctx): Promise<SyncResult> => runSyncRound(ctx, "full"),
  }),

  bridgeFastSync: defineAction({
    description:
      "Fast bridge sync round: follows up in-flight bridge jobs only (delivers finished results, re-sends failures, cleans up); never pulls new jobs. Skips harmlessly when the bridge is not configured.",
    request: z.object({}),
    response: syncResponse,
    privileged: ALL_PRIVILEGED,
    handler: async (ctx): Promise<SyncResult> => runSyncRound(ctx, "fast"),
  }),

  bridgeSetConfig: defineAction({
    description:
      "Saves the bridge pairing config (local canvas tunnel base URL and bridge token). The token is only ever returned masked. clear=true wipes the pairing back to unconfigured.",
    request: z.object({
      baseUrl: z.string().max(300),
      token: z.string().max(300).optional(),
      clear: z.boolean().optional(),
    }),
    response: z.object({
      configured: z.boolean(),
      baseUrl: z.string(),
      tokenMasked: z.string(),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      if (args.clear) {
        await updateBridgeConfig(db, { baseUrl: "", token: "" });
        ctx.invalidateQueries();
        return { configured: false, baseUrl: "", tokenMasked: "" };
      }
      const baseUrl = normalizeBridgeBaseUrl(args.baseUrl);
      let parsed: URL | null = null;
      try {
        parsed = baseUrl ? new URL(baseUrl) : null;
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        throw new Error("桥地址无效：请填写本地画布的隧道地址（http/https）");
      }
      const existing = await getBridgeConfig(db);
      const token =
        args.token && args.token.trim() ? args.token : existing.token;
      if (!token) throw new Error("请填写桥令牌");
      const config = await updateBridgeConfig(db, { baseUrl, token });
      ctx.invalidateQueries();
      return {
        configured: true,
        baseUrl: config.baseUrl,
        tokenMasked: maskBridgeToken(config.token),
      };
    },
  }),

  bridgeStatus: defineAction({
    description:
      "Reports the bridge pairing state: configured flag, tunnel base URL, masked token, job counts by state (including how many failed records can be cleared), last online/error, whether a sync lease is currently held, and the 10 most recent jobs.",
    request: z.object({}),
    response: z.object({
      configured: z.boolean(),
      baseUrl: z.string(),
      tokenMasked: z.string(),
      pending: z.number(),
      inFlight: z.number(),
      failed: z.number(),
      cleaned: z.number(),
      clearableFailed: z.number(),
      lastOnlineAt: z.string().nullable(),
      lastError: z.string().nullable(),
      lastErrorAt: z.string().nullable(),
      leaseHeld: z.boolean(),
      recentJobs: z.array(
        z.object({
          jobId: z.string(),
          kind: z.string(),
          status: z.string(),
          error: z.string().nullable(),
          genSize: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const config = await getBridgeConfig(db);
      const [queued, working, done, failed, cleaned, clearableFailed, recent] =
        await Promise.all([
          countBridgeJobsByStatus(db, "queued"),
          countBridgeJobsByStatus(db, "working"),
          countBridgeJobsByStatus(db, "done"),
          countBridgeJobsByStatus(db, "failed"),
          countBridgeJobsByStatus(db, "cleaned"),
          countClearableFailedJobs(db),
          listRecentBridgeJobs(db, 10),
        ]);
      const iso = (ms: number | null) =>
        ms != null ? new Date(ms).toISOString() : null;
      return {
        configured: Boolean(config.baseUrl && config.token),
        baseUrl: config.baseUrl,
        tokenMasked: maskBridgeToken(config.token),
        pending: queued,
        inFlight: working + done,
        failed,
        cleaned,
        clearableFailed,
        lastOnlineAt: iso(config.lastOnlineAt),
        lastError: config.lastError,
        lastErrorAt: iso(config.lastErrorAt),
        leaseHeld:
          config.syncLeaseUntil != null && config.syncLeaseUntil > Date.now(),
        recentJobs: recent.map((row) => ({
          jobId: row.jobId,
          kind: row.kind,
          status: row.status,
          error: row.error,
          genSize: row.genSize,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        })),
      };
    },
  }),

  bridgeClearFailed: defineAction({
    description:
      "Clears failed bridge records: permanently deletes jobs still in failed state plus cleaned/delivered rows that still carry a failure error, tearing down their job directories. Successful and in-flight jobs are kept. Returns how many records were deleted.",
    request: z.object({}),
    response: clearFailedResponse,
    privileged: [Contracts.deleteJobDir],
    handler: async (ctx): Promise<ClearFailedResult> =>
      clearFailedRecords(ctx),
  }),

  completeBridgeJob: defineAction({
    description:
      "Delivery callback for a spawned bridge generation task: records the finished media file (which must live inside the job's own working directory) as the job's result and marks the job done. Repeated calls after settlement are idempotent.",
    request: z.object({
      jobId: z.string().min(1).max(300),
      filePath: z.string().min(1).max(1000),
      title: z.string().max(300).optional(),
    }),
    response: settleResponse,
    privileged: [
      Contracts.ensureJobDir,
      Contracts.readJobFile,
      Contracts.probeJobFile,
    ],
    handler: async (ctx, args): Promise<SettleResult> =>
      settleComplete(ctx, args),
  }),

  failBridgeJob: defineAction({
    description:
      "Failure callback for a spawned bridge generation task: marks a queued/working bridge job failed with the given error. Repeated calls after settlement are ignored.",
    request: z.object({
      jobId: z.string().min(1).max(300),
      error: z.string().min(1).max(2000),
    }),
    response: settleResponse,
    handler: async (ctx, args): Promise<SettleResult> => settleFail(ctx, args),
  }),
} satisfies ActionsModule;
