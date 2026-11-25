// actions.ts — YoYo桥的全部动作：
//   bridgeSync / bridgeFastSync — 同步编排：对两个配对槽位各跑
//     一轮（全量轮拉新 + 对账本槽位本地已取消的 queued 孤儿行 +
//     两轮都跑本槽位在途跟进）；槽位未配置则跳过该槽位，两槽位
//     都未配置时整轮空转回 skipped，不发请求不抛错。一槽位不可达
//     只记到该槽位自己的 config 行，绝不中断另一槽位。
//   bridgeSetConfig / bridgeStatus — 配对设置面（按 slot 作用，
//     令牌只以掩码出现）。
//   bridgeMovePairing — 运维动作：把一个槽位的配对整体迁移到另一
//     个槽位（服务端内部原样复制，令牌只回掩码），可同时清开源槽位。
//   bridgeClearFailed — 清除失败记录（failed 行 + 已清理但带失败
//     原因的行），连带删作业目录；成功与在途记录不动。
//   completeBridgeJob / failBridgeJob — 后台生成任务的交付回调。
// 桥任务是自包含记录：没有画布的项目/节点/图结构。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import * as schema from "./schema";
import {
PAIRING_SLOTS,
acquireSyncLease,
countBridgeJobsByStatus,
countClearableFailedJobs,
deleteBridgeJobsByIds,
effectivePairingId,
getBridgeConfig,
getBridgeJob,
insertBridgeJob,
listClearableFailedJobs,
listRecentBridgeJobs,
maskBridgeToken,
pairingConnection,
pairingIdForSlot,
releaseSyncLease,
slotOfPairingId,
transitionBridgeJob,
updateBridgeConfig,
type Db,
type PairingSlot,
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
// Claim phase (full rounds only), scoped to one slot
// ---------------------------------------------------------------------------

async function claimAndDispatch(
  ctx: Ctx,
  db: Db,
  slot: PairingSlot,
  transport: BridgeTransport,
  pending: BridgePendingJob[],
  counts: SyncCounts,
): Promise<void> {
  let handled = 0;
  for (const job of pending) {
    if (handled >= MAX_CLAIMS_PER_ROUND) break;
    const existing = await getBridgeJob(db, job.jobId);
    if (existing && existing.status !== "queued") continue;
    // A jobId already claimed by the other slot is never re-claimed
    // here: jobIds are unique to one local side, and re-stamping
    // would corrupt the other slot's bookkeeping.
    if (existing && effectivePairingId(existing) !== pairingIdForSlot(slot)) {
      continue;
    }
    handled += 1;
    if (!existing) {
      const inserted = await insertBridgeJob(db, {
        jobId: job.jobId,
        kind: job.kind,
        localProjectId: job.projectId,
        localNodeId: job.nodeId,
        pairingId: pairingIdForSlot(slot),
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
          // Retryable: the row stays queued, this slot's config
          // records why.
          await updateBridgeConfig(db, slot, {
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
      await updateBridgeConfig(db, slot, {
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
// Sync rounds: one round per configured slot, slots fully isolated
// ---------------------------------------------------------------------------

type SlotRoundOutcome =
  | "not_configured"
  | "lease_held"
  | "unreachable"
  | "auth_failed"
  | "ok";

/** Runs one slot's sync round under that slot's own lease, with a
 * transport built from that slot's own baseUrl/token. Every error
 * and online timestamp lands on that slot's config row only. */
async function runSlotRound(
  ctx: Ctx,
  db: Db,
  slot: PairingSlot,
  mode: "full" | "fast",
  counts: SyncCounts,
): Promise<SlotRoundOutcome> {
  const config = await getBridgeConfig(db, slot);
  if (!config.baseUrl || !config.token) return "not_configured";
  const owner = crypto.randomUUID();
  if (!(await acquireSyncLease(db, slot, owner))) return "lease_held";
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
        await updateBridgeConfig(db, slot, {
          lastError: errMsg(err),
          lastErrorAt: Date.now(),
        });
        return err instanceof BridgeAuthError ? "auth_failed" : "unreachable";
      }
      await updateBridgeConfig(db, slot, {
        lastOnlineAt: Date.now(),
        lastError: null,
        lastErrorAt: null,
      });
      await claimAndDispatch(ctx, db, slot, transport, pending, counts);
      // Reconcile against this slot's fresh pending list only:
      // queued rows of THIS slot that its local side no longer
      // offers were stopped/cancelled locally before dispatch —
      // settle them instead of leaving them frozen in 待处理
      // forever. The other slot's rows are never touched here.
      await reconcileOrphanedQueued(
        db,
        slot,
        new Set(pending.map((job) => job.jobId)),
      );
    }
    const follow = await followUpInFlight(ctx, db, slot, transport, counts);
    if (follow.aborted) return "unreachable";
    return "ok";
  } finally {
    await releaseSyncLease(db, slot, owner);
  }
}

/** Runs every configured slot's round and folds the outcomes into
 * the single sync result the schedulers have always consumed. Both
 * slots unconfigured keeps the original skipped/not_configured
 * semantics; one healthy slot makes the round ok even when the
 * other slot is unreachable or its lease is held elsewhere. */
async function runSyncRound(ctx: Ctx, mode: "full" | "fast"): Promise<SyncResult> {
  const db = ctx.db<typeof schema>();
  const counts = zeroCounts();
  const outcomes: SlotRoundOutcome[] = [];
  for (const slot of PAIRING_SLOTS) {
    outcomes.push(await runSlotRound(ctx, db, slot, mode, counts));
  }
  if (outcomes.every((o) => o === "not_configured")) {
    return { status: "skipped", reason: "not_configured", ...counts };
  }
  if (outcomes.includes("ok")) {
    ctx.invalidateQueries();
    return { status: "ok", reason: null, ...counts };
  }
  if (outcomes.includes("auth_failed")) {
    return { status: "skipped", reason: "auth_failed", ...counts };
  }
  if (outcomes.includes("unreachable")) {
    return { status: "skipped", reason: "local_unreachable", ...counts };
  }
  return { status: "skipped", reason: "lease_held", ...counts };
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

const slotArg = z
  .number()
  .int()
  .min(1)
  .max(2)
  .optional()
  .describe("Pairing slot: 1 or 2 (defaults to 1)");

function toSlot(value: number | undefined): PairingSlot {
  return value === 2 ? 2 : 1;
}

const pairingStatus = z.object({
  slot: z.number(),
  label: z.string(),
  configured: z.boolean(),
  connection: z.enum(["unpaired", "connected", "disconnected"]),
  baseUrl: z.string(),
  tokenMasked: z.string(),
  lastOnlineAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  leaseHeld: z.boolean(),
});

const pairingSummary = z.object({
  slot: z.number(),
  label: z.string(),
  configured: z.boolean(),
  baseUrl: z.string(),
  tokenMasked: z.string(),
});

export const Actions = {
  bridgeSync: defineAction({
    description:
      "Full bridge sync round: for each configured pairing slot (1 and 2), pulls queued generation jobs from that slot's paired local canvas through its tunnel, executes them in this space (direct generation, inference, or spawned tasks), delivers results back through the same slot, and reconciles that slot's queued jobs its local side no longer offers (stopped/cancelled locally before dispatch) by settling them as failed so they never freeze in pending. Unconfigured slots are skipped; a slot that is unreachable only records its own error and never blocks the other slot. Skips harmlessly when no slot is configured.",
    request: z.object({}),
    response: syncResponse,
    privileged: ALL_PRIVILEGED,
    handler: async (ctx): Promise<SyncResult> => runSyncRound(ctx, "full"),
  }),

  bridgeFastSync: defineAction({
    description:
      "Fast bridge sync round: follows up in-flight bridge jobs only, grouped by their pairing slot and delivered through each slot's own tunnel (delivers finished results, re-sends failures, cleans up); never pulls new jobs. Skips harmlessly when no slot is configured.",
    request: z.object({}),
    response: syncResponse,
    privileged: ALL_PRIVILEGED,
    handler: async (ctx): Promise<SyncResult> => runSyncRound(ctx, "fast"),
  }),

  bridgeSetConfig: defineAction({
    description:
      "Saves one pairing slot's config (slot 1 or 2, default 1): the local canvas tunnel base URL and bridge token for that slot only. The token is only ever returned masked. Optional label renames that slot only (trimmed, max 30 chars; empty string clears the custom name back to the default); omitting label leaves the existing name untouched, and a label-only call (label given, baseUrl empty) renames without requiring the slot to be paired. clear=true wipes that slot's pairing and its name back to a fresh unconfigured state and leaves the other slot untouched.",
    request: z.object({
      baseUrl: z.string().max(300),
      token: z.string().max(300).optional(),
      label: z.string().max(30).optional(),
      clear: z.boolean().optional(),
      slot: slotArg,
    }),
    response: z.object({
      configured: z.boolean(),
      baseUrl: z.string(),
      tokenMasked: z.string(),
      slot: z.number(),
      label: z.string(),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const slot = toSlot(args.slot);
      if (args.clear) {
        await updateBridgeConfig(db, slot, {
          baseUrl: "",
          token: "",
          label: "",
        });
        ctx.invalidateQueries();
        return {
          configured: false,
          baseUrl: "",
          tokenMasked: "",
          slot,
          label: "",
        };
      }
      // 只改名：传了 label 且没给地址时只更新名称，不要求该槽位
      // 已配对；名称去首尾空白后保存，空字符串即恢复缺省名。
      if (args.label !== undefined && !args.baseUrl.trim()) {
        const config = await updateBridgeConfig(db, slot, {
          label: args.label.trim(),
        });
        ctx.invalidateQueries();
        return {
          configured: Boolean(config.baseUrl && config.token),
          baseUrl: config.baseUrl,
          tokenMasked: maskBridgeToken(config.token),
          slot,
          label: config.label,
        };
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
      const existing = await getBridgeConfig(db, slot);
      const token =
        args.token && args.token.trim() ? args.token : existing.token;
      if (!token) throw new Error("请填写桥令牌");
      const config = await updateBridgeConfig(db, slot, {
        baseUrl,
        token,
        ...(args.label !== undefined ? { label: args.label.trim() } : {}),
      });
      ctx.invalidateQueries();
      return {
        configured: true,
        baseUrl: config.baseUrl,
        tokenMasked: maskBridgeToken(config.token),
        slot,
        label: config.label,
      };
    },
  }),

  bridgeMovePairing: defineAction({
    description:
      "Moves one pairing slot's pairing (tunnel base URL, bridge token, and custom name label) wholesale to the other slot, entirely server-side: the token is copied verbatim inside the server and only ever returned masked. The target slot's online/error state and sync lease are reset so it restarts as the new pairing; with clearFrom (default true) the source slot is wiped back to unconfigured, name included. Job records and their pairing ownership are never touched. Rejects when the source slot is not configured or both slots are the same.",
    request: z.object({
      fromSlot: z
        .number()
        .int()
        .min(1)
        .max(2)
        .describe("Source pairing slot: 1 or 2"),
      toSlot: z
        .number()
        .int()
        .min(1)
        .max(2)
        .describe("Target pairing slot: 1 or 2, must differ from fromSlot"),
      clearFrom: z
        .boolean()
        .optional()
        .describe("Wipe the source slot after the move (default true)"),
    }),
    response: z.object({
      from: pairingSummary,
      to: pairingSummary,
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const from = toSlot(args.fromSlot);
      const to = toSlot(args.toSlot);
      if (from === to) {
        throw new Error("源槽位与目标槽位不能相同");
      }
      const source = await getBridgeConfig(db, from);
      if (!source.baseUrl || !source.token) {
        throw new Error(`配对 ${from} 未配对，无法迁移`);
      }
      const clearFrom = args.clearFrom ?? true;
      // Copy verbatim into the target; its online/error/lease state
      // resets so the target restarts under the moved pairing.
      await updateBridgeConfig(db, to, {
        baseUrl: source.baseUrl,
        token: source.token,
        label: source.label,
        lastOnlineAt: null,
        lastError: null,
        lastErrorAt: null,
        syncLeaseUntil: null,
        syncLeaseOwner: null,
      });
      if (clearFrom) {
        await updateBridgeConfig(db, from, {
          baseUrl: "",
          token: "",
          label: "",
          lastOnlineAt: null,
          lastError: null,
          lastErrorAt: null,
          syncLeaseUntil: null,
          syncLeaseOwner: null,
        });
      }
      ctx.invalidateQueries();
      const summarize = async (slot: PairingSlot) => {
        const config = await getBridgeConfig(db, slot);
        return {
          slot,
          label: config.label,
          configured: Boolean(config.baseUrl && config.token),
          baseUrl: config.baseUrl,
          tokenMasked: maskBridgeToken(config.token),
        };
      };
      return { from: await summarize(from), to: await summarize(to) };
    },
  }),

  bridgeStatus: defineAction({
    description:
      "Reports the bridge pairing state for both slots: a pairings array with each slot's custom name label (raw stored value, empty when never renamed), configured flag, connection state computed at response time (unpaired when the slot has no address/token, connected when its last successful sync was within 30 seconds, otherwise disconnected), tunnel base URL, masked token, last online/error and lease state; the top-level fields mirror slot 1 for compatibility; plus global job counts by state (including how many failed records can be cleared) and the 10 most recent jobs, each tagged with its pairing slot.",
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
      pairings: z.array(pairingStatus),
      recentJobs: z.array(
        z.object({
          jobId: z.string(),
          kind: z.string(),
          status: z.string(),
          error: z.string().nullable(),
          genSize: z.string().nullable(),
          pairing: z.number(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const iso = (ms: number | null) =>
        ms != null ? new Date(ms).toISOString() : null;
      const now = Date.now();
      const pairings = await Promise.all(
        PAIRING_SLOTS.map(async (slot) => {
          const config = await getBridgeConfig(db, slot);
          return {
            slot,
            label: config.label,
            configured: Boolean(config.baseUrl && config.token),
            connection: pairingConnection(config, now),
            baseUrl: config.baseUrl,
            tokenMasked: maskBridgeToken(config.token),
            lastOnlineAt: iso(config.lastOnlineAt),
            lastError: config.lastError,
            lastErrorAt: iso(config.lastErrorAt),
            leaseHeld:
              config.syncLeaseUntil != null && config.syncLeaseUntil > now,
          };
        }),
      );
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
      const first = pairings[0];
      return {
        configured: first?.configured ?? false,
        baseUrl: first?.baseUrl ?? "",
        tokenMasked: first?.tokenMasked ?? "",
        pending: queued,
        inFlight: working + done,
        failed,
        cleaned,
        clearableFailed,
        lastOnlineAt: first?.lastOnlineAt ?? null,
        lastError: first?.lastError ?? null,
        lastErrorAt: first?.lastErrorAt ?? null,
        leaseHeld: first?.leaseHeld ?? false,
        pairings,
        recentJobs: recent.map((row) => ({
          jobId: row.jobId,
          kind: row.kind,
          status: row.status,
          error: row.error,
          genSize: row.genSize,
          pairing: slotOfPairingId(row.pairingId),
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
