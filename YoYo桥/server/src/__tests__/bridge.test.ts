// 特征测试：YoYo桥的存储层 / 出站层 / 执行器 / 同步空转。
// 存储层用真内存 SQLite（按序应用 drizzle 迁移）验证行为，不用
// 手写假 DB；transport 用 fake fetch；执行器用 fake ctx 记录调用。
// 口径纪律：桥是纯执行器——这里只断言「原样透传」（targetSize、
// durationSeconds、prompt），不断言任何桥侧推导的像素/归一结果。

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import * as schema from "../schema";
import {
CONNECTION_ONLINE_WINDOW_MS,
acquireSyncLease,
configIdForSlot,
countBridgeJobsByStatus,
effectivePairingId,
getBridgeConfig,
getBridgeJob,
insertBridgeJob,
maskBridgeToken,
pairingConnection,
pairingIdForSlot,
releaseSyncLease,
slotOfPairingId,
transitionBridgeJob,
updateBridgeConfig,
type Db,
type PairingSlot,
} from "../bridge-store";
import {
BridgeAuthError,
BridgeUnreachableError,
createBridgeTransport,
normalizeBridgeBaseUrl,
type BridgeTransport,
} from "../bridge-transport";
import {
PermanentJobError,
buildTaskMessage,
executeSyncJob,
extractReverseRelPath,
extractTargetSize,
mechanicalOrientation,
parseTaskPayload,
prepareTaskJob,
spawnPreparedTask,
validateSyncPayload,
type ParsedTaskPayload,
} from "../bridge-executor";
import {
ORPHANED_QUEUED_ERROR,
reconcileOrphanedQueued,
zeroCounts,
} from "../bridge-deliver";
import { Actions } from "../actions";

const MIGRATIONS_DIR = join(import.meta.dir, "../../../drizzle");

function makeDb(): { db: Db; sqlite: Database } {
  const sqlite = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  const db = drizzle(sqlite, { schema }) as unknown as Db;
  return { db, sqlite };
}

async function insertJob(
  db: Db,
  jobId: string,
  kind: string,
  payload: unknown,
  slot: PairingSlot = 1,
): Promise<void> {
  await insertBridgeJob(db, {
    jobId,
    kind,
    localProjectId: "lp",
    localNodeId: "ln",
    pairingId: pairingIdForSlot(slot),
    payload: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// 迁移与存储层
// ---------------------------------------------------------------------------

describe("迁移建表", () => {
  test("bridge_config / bridge_jobs 存在且列齐全，entries 已删除", () => {
    const { sqlite } = makeDb();
    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("bridge_config");
    expect(names).toContain("bridge_jobs");
    expect(names).not.toContain("entries");
    const jobCols = (
      sqlite.query("PRAGMA table_info(bridge_jobs)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      "job_id", "kind", "status", "local_project_id", "local_node_id",
      "pairing_id",
      "payload", "job_dir", "result_type", "result_text",
      "result_file_path", "result_file_name", "result_content_type",
      "result_title", "gen_size", "error", "created_at", "updated_at",
    ]) {
      expect(jobCols).toContain(col);
    }
    const configCols = (
      sqlite.query("PRAGMA table_info(bridge_config)").all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      "id", "label", "base_url", "token", "last_online_at", "last_error",
      "last_error_at", "sync_lease_until", "sync_lease_owner", "updated_at",
    ]) {
      expect(configCols).toContain(col);
    }
  });
});

describe("迁移 0003：单配对改双槽位", () => {
  test("旧 id='bridge' 行改名为 'bridge-1' 且数据原样保留；bridge_jobs 新增 pairing_id", () => {
    // 只应用 0001+0002，手工造一行旧配对，再应用 0003。
    const sqlite = new Database(":memory:");
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const apply = (file: string) => {
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
    };
    for (const file of files.filter((f) => !f.startsWith("0003"))) apply(file);
    sqlite.exec(
      `INSERT INTO bridge_config (id, base_url, token, last_online_at, updated_at)
       VALUES ('bridge', 'https://yoyo-bridge.ck971.cc.cd', 'tok-keep-me', 123456789, 42)`,
    );
    sqlite.exec(
      `INSERT INTO bridge_jobs (job_id, kind, status, payload, created_at, updated_at)
       VALUES ('legacy-job', 'text', 'cleaned', '{}', 1, 2)`,
    );
    for (const file of files.filter((f) => f.startsWith("0003"))) apply(file);
    const rows = sqlite
      .query("SELECT id, base_url, token, last_online_at FROM bridge_config")
      .all() as { id: string; base_url: string; token: string; last_online_at: number }[];
    expect(rows).toEqual([
      {
        id: "bridge-1",
        base_url: "https://yoyo-bridge.ck971.cc.cd",
        token: "tok-keep-me",
        last_online_at: 123456789,
      },
    ]);
    const job = sqlite
      .query("SELECT pairing_id FROM bridge_jobs WHERE job_id = 'legacy-job'")
      .get() as { pairing_id: string | null };
    expect(job.pairing_id).toBeNull();
    sqlite.close();
  });
});

describe("bridge-store", () => {
  test("配置行 get-or-create：首次建行带默认值，再读同一行", async () => {
    const { db } = makeDb();
    const first = await getBridgeConfig(db, 1);
    expect(first.id).toBe("bridge-1");
    expect(first.baseUrl).toBe("");
    expect(first.token).toBe("");
    expect(first.lastOnlineAt).toBeNull();
    const second = await getBridgeConfig(db, 1);
    expect(second.id).toBe("bridge-1");
    await updateBridgeConfig(db, 1, { baseUrl: "https://t.example.com" });
    const third = await getBridgeConfig(db, 1);
    expect(third.baseUrl).toBe("https://t.example.com");
  });

  test("两槽位配置互不影响：写一槽位不碰另一槽位，租约各自独立", async () => {
    const { db } = makeDb();
    expect(configIdForSlot(1)).toBe("bridge-1");
    expect(configIdForSlot(2)).toBe("bridge-2");
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://one.example",
      token: "tok-one",
    });
    await updateBridgeConfig(db, 2, {
      baseUrl: "https://two.example",
      token: "tok-two",
      lastError: "槽位2的错误",
    });
    const one = await getBridgeConfig(db, 1);
    const two = await getBridgeConfig(db, 2);
    expect(one.baseUrl).toBe("https://one.example");
    expect(one.token).toBe("tok-one");
    expect(one.lastError).toBeNull();
    expect(two.baseUrl).toBe("https://two.example");
    expect(two.token).toBe("tok-two");
    expect(two.lastError).toBe("槽位2的错误");
    // 租约按槽位独立：槽位 1 被占不影响槽位 2
    expect(await acquireSyncLease(db, 1, "owner-a")).toBe(true);
    expect(await acquireSyncLease(db, 2, "owner-a")).toBe(true);
    expect(await acquireSyncLease(db, 1, "owner-b")).toBe(false);
    await releaseSyncLease(db, 1, "owner-a");
    expect(await acquireSyncLease(db, 1, "owner-b")).toBe(true);
  });

  test("pairing 归属：存量 null 按槽位 1，'bridge-2' 按槽位 2", async () => {
    expect(slotOfPairingId(null)).toBe(1);
    expect(slotOfPairingId(undefined)).toBe(1);
    expect(slotOfPairingId("bridge-1")).toBe(1);
    expect(slotOfPairingId("bridge-2")).toBe(2);
    expect(pairingIdForSlot(1)).toBe("bridge-1");
    expect(pairingIdForSlot(2)).toBe("bridge-2");
    const { db } = makeDb();
    await insertJob(db, "legacy-null", "text", { prompt: "x" });
    await db
      .update(schema.bridgeJobs)
      .set({ pairingId: null })
      .where(eq(schema.bridgeJobs.jobId, "legacy-null"));
    const legacy = await getBridgeJob(db, "legacy-null");
    expect(effectivePairingId(legacy!)).toBe("bridge-1");
  });

  test("状态机合法边可走、非法边返回 false 不抛错", async () => {
    const { db } = makeDb();
    await insertJob(db, "j1", "text", { prompt: "x" });
    // queued → delivered 非法
    expect(await transitionBridgeJob(db, "j1", ["queued"], "delivered")).toBe(false);
    // queued → working 合法
    expect(await transitionBridgeJob(db, "j1", ["queued"], "working")).toBe(true);
    // working → queued 非法
    expect(await transitionBridgeJob(db, "j1", ["working"], "queued")).toBe(false);
    // fromStatuses 不含当前状态 → false
    expect(await transitionBridgeJob(db, "j1", ["queued"], "done")).toBe(false);
    // working → done → delivered → cleaned 全程合法
    expect(await transitionBridgeJob(db, "j1", ["working"], "done")).toBe(true);
    expect(await transitionBridgeJob(db, "j1", ["done"], "delivered")).toBe(true);
    expect(await transitionBridgeJob(db, "j1", ["delivered"], "cleaned")).toBe(true);
    // cleaned 无出边
    expect(await transitionBridgeJob(db, "j1", ["cleaned"], "failed")).toBe(false);
    // 不存在的任务
    expect(await transitionBridgeJob(db, "nope", ["queued"], "failed")).toBe(false);
    // queued → failed、failed → delivered 合法
    await insertJob(db, "j2", "text", { prompt: "x" });
    expect(await transitionBridgeJob(db, "j2", ["queued"], "failed")).toBe(true);
    expect(await transitionBridgeJob(db, "j2", ["failed"], "delivered")).toBe(true);
    // insert 幂等：同 jobId 再插返回 false
    expect(
      await insertBridgeJob(db, {
        jobId: "j2", kind: "text", localProjectId: null, localNodeId: null,
        pairingId: "bridge-1", payload: "{}",
      }),
    ).toBe(false);
    expect(await countBridgeJobsByStatus(db, "delivered")).toBe(1);
  });

  test("租约：夺取、他人夺不到、释放后可再夺、过期可再夺", async () => {
    const { db } = makeDb();
    expect(await acquireSyncLease(db, 1, "owner-a")).toBe(true);
    expect(await acquireSyncLease(db, 1, "owner-b")).toBe(false);
    await releaseSyncLease(db, 1, "owner-b"); // 不是持有者，释放无效
    expect(await acquireSyncLease(db, 1, "owner-b")).toBe(false);
    await releaseSyncLease(db, 1, "owner-a");
    expect(await acquireSyncLease(db, 1, "owner-b")).toBe(true);
    await updateBridgeConfig(db, 1, { syncLeaseUntil: Date.now() - 1000 });
    expect(await acquireSyncLease(db, 1, "owner-c")).toBe(true);
  });

  test("maskBridgeToken 三形态", () => {
    expect(maskBridgeToken("")).toBe("");
    expect(maskBridgeToken(null)).toBe("");
    expect(maskBridgeToken("abc")).toBe("••••••");
    expect(maskBridgeToken("abcdef")).toBe("••••••");
    expect(maskBridgeToken("abcdefg")).toBe("abc••••fg");
    expect(maskBridgeToken("tok-123456789")).toBe("tok••••89");
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("normalizeBridgeBaseUrl", () => {
  test("去尾斜杠、无 scheme 补 https、已有 scheme 不动、空值回空", () => {
    expect(normalizeBridgeBaseUrl("example.com/")).toBe("https://example.com");
    expect(normalizeBridgeBaseUrl("https://a.b///")).toBe("https://a.b");
    expect(normalizeBridgeBaseUrl("http://a.b")).toBe("http://a.b");
    expect(normalizeBridgeBaseUrl("  ")).toBe("");
  });
});

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("transport", () => {
  test("getPending 形状过滤与字段归一", async () => {
    const calls: FetchCall[] = [];
    const transport = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "secret-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return jsonResponse({
          jobs: [
            { jobId: "a", kind: "text", payload: { prompt: "hi" } },
            { kind: "text" },
            "junk",
            { jobId: "b", kind: 42, projectId: "p" },
          ],
        });
      },
    });
    const jobs = await transport.getPending();
    expect(jobs.length).toBe(2);
    expect(jobs[0]?.jobId).toBe("a");
    expect(jobs[0]?.payload).toEqual({ prompt: "hi" });
    expect(jobs[1]?.kind).toBe("");
    expect(jobs[1]?.projectId).toBe("p");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-bridge-token"]).toBe("secret-token");
    expect(calls[0]?.url).toBe("https://local.example/bridge/pending");
  });

  test("downloadFile 按 Range 分段拼接并校验 Content-Range", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const ranges: string[] = [];
    const transport = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        const range = ((init?.headers ?? {}) as Record<string, string>).Range ?? "";
        ranges.push(range);
        const m = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = Number(m?.[1]);
        const end = Math.min(Number(m?.[2]), data.length - 1);
        return new Response(data.subarray(start, end + 1), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${data.length}` },
        });
      },
    });
    const out = await transport.downloadFile("proj/file.png");
    expect(Array.from(out)).toEqual(Array.from(data));
    expect(ranges).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-11"]);
  });

  test("downloadFile 对端回 200 整文件时直接接受", async () => {
    const data = new Uint8Array([9, 8, 7]);
    const transport = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      chunkSize: 2,
      fetchImpl: async () => new Response(data, { status: 200 }),
    });
    const out = await transport.downloadFile("a/b.bin.png");
    expect(Array.from(out)).toEqual([9, 8, 7]);
  });

  test("postResultMedia 分块头序列、段重试、422 failed 原样返回", async () => {
    const seen: { index: string; total: string; job: string; len: number }[] = [];
    let flaked = false;
    const transport = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      chunkSize: 4,
      fetchImpl: async (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const index = headers["x-chunk-index"];
        if (index === "1" && !flaked) {
          flaked = true;
          throw new TypeError("network down");
        }
        seen.push({
          index: index ?? "",
          total: headers["x-chunk-total"] ?? "",
          job: headers["x-job-id"] ?? "",
          len: (init?.body as Uint8Array).byteLength,
        });
        if (index === "2") return jsonResponse({ status: "done" });
        return jsonResponse({ status: "chunk_received" });
      },
    });
    const reply = await transport.postResultMedia("job-9", {
      fileName: "result.mp4",
      contentType: "video/mp4",
      bytes: new Uint8Array(10),
    });
    expect(reply.status).toBe("done");
    expect(seen.map((s) => s.index)).toEqual(["0", "1", "2"]);
    expect(seen.every((s) => s.total === "3" && s.job === "job-9")).toBe(true);
    expect(seen.map((s) => s.len)).toEqual([4, 4, 2]);

    const failing = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      chunkSize: 100,
      fetchImpl: async () =>
        jsonResponse({ status: "failed", error: "落地失败原因" }, 422),
    });
    const failedReply = await failing.postResultMedia("job-9", {
      fileName: "r.png",
      contentType: "image/png",
      bytes: new Uint8Array(3),
    });
    expect(failedReply).toEqual({ status: "failed", error: "落地失败原因" });
  });

  test("错误三分类：401 → Auth、网络失败 → Unreachable、503 未配对 → Unreachable", async () => {
    const auth = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      fetchImpl: async () => new Response("no", { status: 401 }),
    });
    await expect(auth.getPending()).rejects.toBeInstanceOf(BridgeAuthError);

    const down = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.getPending()).rejects.toBeInstanceOf(BridgeUnreachableError);

    const unpaired = createBridgeTransport({
      baseUrl: "https://local.example",
      token: "t",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "bridge_not_configured" }), {
          status: 503,
        }),
    });
    await expect(unpaired.getPending()).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
  });
});

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

type PrivCall = { name: string; args: Record<string, unknown> };
type FakeCalls = {
  priv: PrivCall[];
  media: { prompt: string; opts: unknown }[];
  inference: { prompt: string; opts: Record<string, unknown> }[];
  spawn: { message: string; opts: Record<string, unknown> }[];
};

function makeFakeCtx(
  db: Db,
  overrides: {
    readFile?: { dataBase64: string; sizeBytes: number; contentType: string };
    probe?: { width: number | null; height: number | null; durationSeconds: number | null };
    inferenceText?: string;
    spawnOk?: boolean;
  } = {},
): { ctx: Ctx; calls: FakeCalls } {
  const calls: FakeCalls = { priv: [], media: [], inference: [], spawn: [] };
  const readFile = overrides.readFile ?? {
    dataBase64: Buffer.from("img").toString("base64"),
    sizeBytes: 3,
    contentType: "image/png",
  };
  const probe = overrides.probe ?? {
    width: 640,
    height: 480,
    durationSeconds: null,
  };
  const ctx = {
    db: () => db,
    spaceDir: "/tmp/fake-space",
    invalidateQueries: () => {},
    executePrivileged: async (contract: unknown, args: Record<string, unknown>) => {
      if (contract === Contracts.ensureJobDir) {
        calls.priv.push({ name: "ensureJobDir", args });
        return { path: `/tmp/jobs/${String(args.dirName)}` };
      }
      if (contract === Contracts.writeJobFile) {
        calls.priv.push({ name: "writeJobFile", args });
        return { path: `/tmp/jobs/${String(args.dirName)}/${String(args.fileName)}` };
      }
      if (contract === Contracts.readJobFile) {
        calls.priv.push({ name: "readJobFile", args });
        return readFile;
      }
      if (contract === Contracts.probeJobFile) {
        calls.priv.push({ name: "probeJobFile", args });
        return probe;
      }
      if (contract === Contracts.mirrorBlobToJobFile) {
        calls.priv.push({ name: "mirrorBlobToJobFile", args });
        return {
          path: `/tmp/jobs/${String(args.dirName)}/${String(args.fileName)}`,
          sizeBytes: 42,
        };
      }
      if (contract === Contracts.convertImageToPng) {
        calls.priv.push({ name: "convertImageToPng", args });
        return { path: `/tmp/jobs/out/${String(args.fileName)}` };
      }
      if (contract === Contracts.shrinkImageForInference) {
        calls.priv.push({ name: "shrinkImageForInference", args });
        return { path: `/tmp/jobs/out/${String(args.fileName)}`, width: 100, height: 50 };
      }
      if (contract === Contracts.deleteJobFile) {
        calls.priv.push({ name: "deleteJobFile", args });
        return { deleted: true };
      }
      if (contract === Contracts.deleteJobDir) {
        calls.priv.push({ name: "deleteJobDir", args });
        return { deleted: true };
      }
      throw new Error("unexpected privileged contract");
    },
    tool: {
      generate_media: async (prompt: string, opts: unknown) => {
        calls.media.push({ prompt, opts });
        return { blobKey: "blob-1", contentType: "image/webp", url: "", bytes: 42 };
      },
    },
    inference: {
      complete: async (prompt: string, opts: Record<string, unknown>) => {
        calls.inference.push({ prompt, opts });
        return { text: overrides.inferenceText ?? "生成正文" };
      },
    },
    agent: {
      spawnTask: async (message: string, opts: Record<string, unknown>) => {
        calls.spawn.push({ message, opts });
        return overrides.spawnOk === false
          ? { ok: false, error: "spawn 被拒" }
          : { ok: true, taskId: "task-1" };
      },
    },
  };
  return { ctx: ctx as unknown as Ctx, calls };
}

function fakeTransport(
  download: (relPath: string) => Promise<Uint8Array>,
): BridgeTransport {
  return {
    baseUrl: "https://local.example",
    getPending: async () => [],
    downloadFile: download,
    ackClaim: async () => ({ status: "ok", error: null }),
    postResultText: async () => ({ status: "done", error: null }),
    postResultMedia: async () => ({ status: "done", error: null }),
    postFail: async () => ({ status: "ok", error: null }),
  } as BridgeTransport;
}

describe("executor: direct-image", () => {
  test("prompt 原样、orientation 按 ratio 宽高机械判断、结果落行", async () => {
    const { db } = makeDb();
    const cases: [string, string][] = [
      ["3:2", "landscape"],
      ["2:3", "portrait"],
      ["1:1", "square"],
      ["garbage", "square"],
    ];
    for (const [ratio, expected] of cases) {
      const jobId = `di-${ratio}`;
      await insertJob(db, jobId, "direct-image", { prompt: "画一只猫", ratio });
      const row = await getBridgeJob(db, jobId);
      const { ctx, calls } = makeFakeCtx(db);
      await executeSyncJob(ctx, db, fakeTransport(async () => new Uint8Array()), row!);
      expect(calls.media.length).toBe(1);
      expect(calls.media[0]?.prompt).toBe("画一只猫");
      expect(calls.media[0]?.opts).toEqual({ orientation: expected });
      const after = await getBridgeJob(db, jobId);
      expect(after?.status).toBe("done");
      expect(after?.resultType).toBe("media");
      expect(after?.resultFileName).toBe("result.webp");
      expect(after?.resultContentType).toBe("image/webp");
      expect(after?.genSize).toBe("640x480"); // fake probe 实测值
    }
    expect(mechanicalOrientation("21:9")).toBe("landscape");
    expect(mechanicalOrientation(null)).toBe("square");
  });
});

describe("executor: text", () => {
  test("inference 包装文本与 system 透传、结果落行", async () => {
    const { db } = makeDb();
    await insertJob(db, "tx-1", "text", {
      prompt: "写一首诗",
      system: "自定义系统提示",
      resultTitle: "诗一首",
    });
    const row = await getBridgeJob(db, "tx-1");
    const { ctx, calls } = makeFakeCtx(db);
    await executeSyncJob(ctx, db, fakeTransport(async () => new Uint8Array()), row!);
    expect(calls.inference.length).toBe(1);
    expect(calls.inference[0]?.prompt).toBe(
      "任务要求：写一首诗\n\n只输出正文，不要解释你的写作过程。",
    );
    expect(calls.inference[0]?.opts.system).toBe("自定义系统提示");
    expect(calls.inference[0]?.opts.timeout_secs).toBe(120);
    const after = await getBridgeJob(db, "tx-1");
    expect(after?.status).toBe("done");
    expect(after?.resultType).toBe("text");
    expect(after?.resultText).toBe("生成正文");
    expect(after?.resultTitle).toBe("诗一首");
  });
});

describe("executor: task-image / task-video", () => {
  const parsedBase: ParsedTaskPayload = {
    prompt: "一只猫",
    targetSize: "1234x777",
    durationSeconds: null,
    refs: [],
  };

  test("spawn 报文含 jobId、从 message 抽出的像素串原样透传、参考路径与作业目录", async () => {
    const { db } = makeDb();
    await insertJob(db, "ti-1", "task-image", {
      message:
        "任务：为YoYo画布的一个节点生成一张图片。\n画幅比例：3:2，确切像素尺寸：1920x1280（宽x高，这是生成服务的真实出图尺寸，生成时请按这个尺寸出图，不要再缩放改尺寸）",
      parsed: {
        prompt: "一只猫",
        refs: [{ kind: "image", title: "参考猫", relPath: "p1/ref.png" }],
      },
    });
    const row = await getBridgeJob(db, "ti-1");
    const { ctx, calls } = makeFakeCtx(db);
    const transport = fakeTransport(async () => new Uint8Array([1, 2, 3]));
    const prepared = await prepareTaskJob(ctx, db, transport, row!);
    expect(prepared.message).toContain("jobId（原样回传，不要改动）：ti-1");
    expect(prepared.message).toContain("目标像素尺寸：1920x1280");
    expect(prepared.message).toContain("生成要求：一只猫");
    expect(prepared.message).toContain("参考图 1（参考猫）：");
    expect(prepared.message).toContain("ref-1.png");
    expect(prepared.message).toContain("作业目录（本任务专属");
    expect(prepared.message).toContain("completeBridgeJob");
    await spawnPreparedTask(ctx, db, row!, prepared.message);
    expect(calls.spawn.length).toBe(1);
    expect(calls.spawn[0]?.opts.expectsAction).toBe("completeBridgeJob");
    expect(calls.spawn[0]?.opts.dedupeKey).toBe("yoyo-bridge-task-image-ti-1");
    const after = await getBridgeJob(db, "ti-1");
    expect(after?.status).toBe("working");
  });

  test("message 无像素串 → 永久失败 payload_missing_target_size", async () => {
    expect(extractTargetSize("画幅比例：3:2，确切像素尺寸：1920x1280（宽x高）")).toBe("1920x1280");
    expect(extractTargetSize("画幅比例：auto（尺寸自适应）")).toBeNull();
    expect(extractTargetSize(undefined)).toBeNull();
    const { db } = makeDb();
    await insertJob(db, "ti-2", "task-image", {
      message: "任务：生成一张图片（报文里没有尺寸行）",
      parsed: { prompt: "x", refs: [] },
    });
    const row = await getBridgeJob(db, "ti-2");
    const check = parseTaskPayload(row!);
    expect("error" in check && check.error).toBe("payload_missing_target_size");
    const { ctx } = makeFakeCtx(db);
    await expect(
      prepareTaskJob(ctx, db, fakeTransport(async () => new Uint8Array()), row!),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  test("视频时长原样透传不钳制；缺失时不写时长行", () => {
    const row = {
      jobId: "tv-1",
      kind: "task-video",
    } as Parameters<typeof buildTaskMessage>[0];
    const withDuration = buildTaskMessage(
      row,
      { ...parsedBase, durationSeconds: 45 },
      "/tmp/jobs/job-tv-1",
      [],
    );
    expect(withDuration).toContain("目标时长：约 45 秒");
    expect(withDuration).toContain("视频提示词：一只猫");
    const without = buildTaskMessage(row, parsedBase, "/tmp/jobs/job-tv-1", []);
    expect(without).not.toContain("目标时长");
  });

  test("参考 relPath 为 null → 永久失败并点名文件", async () => {
    const { db } = makeDb();
    await insertJob(db, "ti-3", "task-image", {
      message: "确切像素尺寸：100x100",
      parsed: {
        prompt: "x",
        refs: [{ kind: "image", title: "断链图", relPath: null }],
      },
    });
    const row = await getBridgeJob(db, "ti-3");
    const { ctx } = makeFakeCtx(db);
    await expect(
      prepareTaskJob(ctx, db, fakeTransport(async () => new Uint8Array()), row!),
    ).rejects.toThrow("参考文件「断链图」缺少本地路径，无法取回");
  });
});

describe("executor: prompt-reverse", () => {
  test("relPath 提取：正斜杠/反斜杠可提取，截不到为 null 且校验判永久失败", async () => {
    expect(
      extractReverseRelPath("/home/u/yoyo-canvas-projects/p1/img.png"),
    ).toBe("p1/img.png");
    expect(
      extractReverseRelPath("C:\\x\\yoyo-canvas-projects\\p1\\img.png"),
    ).toBe("p1/img.png");
    expect(extractReverseRelPath("/somewhere/else/img.png")).toBeNull();
    const { db } = makeDb();
    await insertJob(db, "pr-bad", "prompt-reverse", {
      prompt: "逆推",
      imageFilePath: "/no/marker/here.png",
    });
    const row = await getBridgeJob(db, "pr-bad");
    expect(validateSyncPayload(row!)).toContain("无法从本地图片路径中提取相对路径");
  });

  test("全程：下载→入目录→inference 带图、prompt 原样、结果落行", async () => {
    const { db } = makeDb();
    await insertJob(db, "pr-1", "prompt-reverse", {
      prompt: "请逆推这张图",
      imageFilePath: "/home/u/yoyo-canvas-projects/p1/img.png",
      resultTitle: "逆推结果",
    });
    const row = await getBridgeJob(db, "pr-1");
    const { ctx, calls } = makeFakeCtx(db);
    let downloadedRel = "";
    const transport = fakeTransport(async (relPath) => {
      downloadedRel = relPath;
      return new Uint8Array([5, 5]);
    });
    await executeSyncJob(ctx, db, transport, row!);
    expect(downloadedRel).toBe("p1/img.png");
    expect(calls.inference.length).toBe(1);
    expect(calls.inference[0]?.prompt).toBe("请逆推这张图");
    const images = calls.inference[0]?.opts.images as { mimeType: string }[];
    expect(images[0]?.mimeType).toBe("image/png");
    const after = await getBridgeJob(db, "pr-1");
    expect(after?.status).toBe("done");
    expect(after?.resultType).toBe("text");
    expect(after?.resultTitle).toBe("逆推结果");
  });
});

describe("对账：本地已取消的 queued 孤儿行", () => {
  test("不在本地 pending 且超过宽限期 → 结算 failed 并写明原因；在列或宽限期内不动", async () => {
    const { db } = makeDb();
    await insertJob(db, "orphan-1", "task-video", { parsed: { prompt: "x" } });
    await insertJob(db, "still-offered", "text", { prompt: "x" });
    await insertJob(db, "fresh-orphan", "text", { prompt: "x" });
    const old = Date.now() - 120_000;
    await db
      .update(schema.bridgeJobs)
      .set({ updatedAt: old })
      .where(eq(schema.bridgeJobs.jobId, "orphan-1"));
    await db
      .update(schema.bridgeJobs)
      .set({ updatedAt: old })
      .where(eq(schema.bridgeJobs.jobId, "still-offered"));
    await reconcileOrphanedQueued(db, 1, new Set(["still-offered"]));
    const orphan = await getBridgeJob(db, "orphan-1");
    expect(orphan?.status).toBe("failed");
    expect(orphan?.error).toBe(ORPHANED_QUEUED_ERROR);
    expect((await getBridgeJob(db, "still-offered"))?.status).toBe("queued");
    expect((await getBridgeJob(db, "fresh-orphan"))?.status).toBe("queued");
    // 已结算的行不会被重复处理
    await reconcileOrphanedQueued(db, 1, new Set());
    expect((await getBridgeJob(db, "orphan-1"))?.status).toBe("failed");
  });

  test("跨槽位隔离：配对 1 的对账绝不结算配对 2 的 queued 行，反之亦然", async () => {
    const { db } = makeDb();
    await insertJob(db, "slot1-orphan", "text", { prompt: "x" }, 1);
    await insertJob(db, "slot2-orphan", "text", { prompt: "x" }, 2);
    const old = Date.now() - 120_000;
    await db
      .update(schema.bridgeJobs)
      .set({ updatedAt: old })
      .where(eq(schema.bridgeJobs.status, "queued"));
    // 配对 1 全量轮：本轮 pending 为空 → 只结算配对 1 自己的孤儿行
    await reconcileOrphanedQueued(db, 1, new Set());
    expect((await getBridgeJob(db, "slot1-orphan"))?.status).toBe("failed");
    expect((await getBridgeJob(db, "slot2-orphan"))?.status).toBe("queued");
    // 配对 2 全量轮才结算配对 2 的
    await reconcileOrphanedQueued(db, 2, new Set());
    expect((await getBridgeJob(db, "slot2-orphan"))?.status).toBe("failed");
  });

  test("全量同步端到端：孤儿行结算后经 fail 回送走到 cleaned", async () => {
    const { db } = makeDb();
    const failPosts: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/bridge/pending") {
          return jsonResponse({ jobs: [] });
        }
        if (url.pathname === "/bridge/fail") {
          const body = (await req.json()) as { jobId?: string };
          failPosts.push(body.jobId ?? "");
          return jsonResponse({ status: "ok" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await updateBridgeConfig(db, 1, {
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: "tok-e2e",
      });
      await insertJob(db, "orphan-e2e", "task-video", {
        parsed: { prompt: "x" },
      });
      await db
        .update(schema.bridgeJobs)
        .set({ updatedAt: Date.now() - 120_000 })
        .where(eq(schema.bridgeJobs.jobId, "orphan-e2e"));
      const { ctx } = makeFakeCtx(db);
      const res = await Actions.bridgeSync.handler(ctx, {});
      expect(res.status).toBe("ok");
      expect(res.failed).toBe(1);
      expect(res.delivered).toBe(1);
      expect(res.cleaned).toBe(1);
      expect(failPosts).toEqual(["orphan-e2e"]);
      const row = await getBridgeJob(db, "orphan-e2e");
      expect(row?.status).toBe("cleaned");
      expect(row?.error).toBe(ORPHANED_QUEUED_ERROR);
      expect(zeroCounts()).toEqual({
        claimed: 0, dispatched: 0, delivered: 0, cleaned: 0, failed: 0,
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("同步空转", () => {
  test("未配置时 bridgeSync / bridgeFastSync 回 skipped/not_configured 不抛错", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    const full = await Actions.bridgeSync.handler(ctx, {});
    expect(full).toEqual({
      status: "skipped",
      reason: "not_configured",
      claimed: 0,
      dispatched: 0,
      delivered: 0,
      cleaned: 0,
      failed: 0,
    });
    const fast = await Actions.bridgeFastSync.handler(ctx, {});
    expect(fast.status).toBe("skipped");
    expect(fast.reason).toBe("not_configured");
  });
});

// ---------------------------------------------------------------------------
// 双配对槽位：配置动作 / 状态 / 回送路由 / 单槽位故障隔离
// ---------------------------------------------------------------------------

describe("双配对：bridgeSetConfig 按槽位作用", () => {
  test("保存与清除只作用于目标槽位；缺省 slot 兼容旧调用走槽位 1", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    // 旧调用（无 slot）→ 槽位 1
    const saved1 = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
    });
    expect(saved1.slot).toBe(1);
    expect(saved1.configured).toBe(true);
    // 槽位 2 独立保存
    const saved2 = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://two.example",
      token: "tok-two-456",
      slot: 2,
    });
    expect(saved2.slot).toBe(2);
    expect(saved2.baseUrl).toBe("https://two.example");
    expect(saved2.tokenMasked).toBe("tok••••56");
    expect((await getBridgeConfig(db, 1)).baseUrl).toBe("https://one.example");
    expect((await getBridgeConfig(db, 1)).token).toBe("tok-one-123");
    expect((await getBridgeConfig(db, 2)).token).toBe("tok-two-456");
    // 令牌留空 = 不改该槽位令牌
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://two-b.example",
      slot: 2,
    });
    expect((await getBridgeConfig(db, 2)).baseUrl).toBe("https://two-b.example");
    expect((await getBridgeConfig(db, 2)).token).toBe("tok-two-456");
    // 清除槽位 2 不影响槽位 1
    const cleared = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "",
      clear: true,
      slot: 2,
    });
    expect(cleared.configured).toBe(false);
    expect((await getBridgeConfig(db, 2)).baseUrl).toBe("");
    expect((await getBridgeConfig(db, 2)).token).toBe("");
    expect((await getBridgeConfig(db, 1)).baseUrl).toBe("https://one.example");
    expect((await getBridgeConfig(db, 1)).token).toBe("tok-one-123");
  });

  test("bridgeStatus：pairings 两槽位齐全，顶层字段等同配对 1，recentJobs 带 pairing", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
    });
    await updateBridgeConfig(db, 2, {
      baseUrl: "https://two.example",
      token: "tok-two-456",
    });
    await insertJob(db, "job-slot2", "text", { prompt: "x" }, 2);
    await insertJob(db, "job-legacy", "text", { prompt: "x" }, 1);
    await db
      .update(schema.bridgeJobs)
      .set({ pairingId: null })
      .where(eq(schema.bridgeJobs.jobId, "job-legacy"));
    const status = await Actions.bridgeStatus.handler(ctx, {});
    expect(status.pairings.length).toBe(2);
    expect(status.pairings[0]?.slot).toBe(1);
    expect(status.pairings[0]?.baseUrl).toBe("https://one.example");
    expect(status.pairings[0]?.tokenMasked).toBe("tok••••23");
    expect(status.pairings[1]?.slot).toBe(2);
    expect(status.pairings[1]?.configured).toBe(true);
    expect(status.pairings[1]?.baseUrl).toBe("https://two.example");
    // 顶层兼容字段 = 配对 1
    expect(status.configured).toBe(true);
    expect(status.baseUrl).toBe("https://one.example");
    expect(status.tokenMasked).toBe("tok••••23");
    const byId = new Map(status.recentJobs.map((j) => [j.jobId, j.pairing]));
    expect(byId.get("job-slot2")).toBe(2);
    expect(byId.get("job-legacy")).toBe(1);
  });
});

/** 起一个假本地桥端：记录 fail 回送，可选在 pending 里挂一个任务。 */
function makeFakeLocalServer(opts: {
  pendingJobs?: unknown[];
  failPosts: string[];
}) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/bridge/pending") {
        return jsonResponse({ jobs: opts.pendingJobs ?? [] });
      }
      if (url.pathname === "/bridge/ack-claim") {
        return jsonResponse({ status: "ok" });
      }
      if (url.pathname === "/bridge/result") {
        return jsonResponse({ status: "done" });
      }
      if (url.pathname === "/bridge/fail") {
        const body = (await req.json()) as { jobId?: string };
        opts.failPosts.push(body.jobId ?? "");
        return jsonResponse({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("双配对：在途回送按所属槽位路由", () => {
  test("两槽位各有一个 failed 任务 → 各经自己槽位的端点回送并清理", async () => {
    const { db } = makeDb();
    const failA: string[] = [];
    const failB: string[] = [];
    const serverA = makeFakeLocalServer({ failPosts: failA });
    const serverB = makeFakeLocalServer({ failPosts: failB });
    try {
      await updateBridgeConfig(db, 1, {
        baseUrl: `http://127.0.0.1:${serverA.port}`,
        token: "tok-a",
      });
      await updateBridgeConfig(db, 2, {
        baseUrl: `http://127.0.0.1:${serverB.port}`,
        token: "tok-b",
      });
      await insertJob(db, "fail-slot1", "text", { prompt: "x" }, 1);
      await insertJob(db, "fail-slot2", "text", { prompt: "x" }, 2);
      await transitionBridgeJob(db, "fail-slot1", ["queued"], "failed", {
        error: "槽位1失败",
      });
      await transitionBridgeJob(db, "fail-slot2", ["queued"], "failed", {
        error: "槽位2失败",
      });
      const { ctx } = makeFakeCtx(db);
      const res = await Actions.bridgeFastSync.handler(ctx, {});
      expect(res.status).toBe("ok");
      expect(failA).toEqual(["fail-slot1"]);
      expect(failB).toEqual(["fail-slot2"]);
      expect((await getBridgeJob(db, "fail-slot1"))?.status).toBe("cleaned");
      expect((await getBridgeJob(db, "fail-slot2"))?.status).toBe("cleaned");
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  test("一槽位不可达：错误只记该槽位，另一槽位仍能领取、执行与回送", async () => {
    const { db } = makeDb();
    // 先占一个端口再释放，得到一个确定没人监听的地址当死槽位。
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = dead.port;
    dead.stop(true);
    const failB: string[] = [];
    const serverB = makeFakeLocalServer({
      failPosts: failB,
      pendingJobs: [
        {
          jobId: "s2-text-job",
          kind: "text",
          projectId: "p2",
          nodeId: "n2",
          payload: { prompt: "写一句槽位2的话" },
        },
      ],
    });
    try {
      await updateBridgeConfig(db, 1, {
        baseUrl: `http://127.0.0.1:${deadPort}`,
        token: "tok-dead",
      });
      await updateBridgeConfig(db, 2, {
        baseUrl: `http://127.0.0.1:${serverB.port}`,
        token: "tok-b",
      });
      const { ctx, calls } = makeFakeCtx(db);
      const res = await Actions.bridgeSync.handler(ctx, {});
      // 槽位 2 正常跑完 → 整轮 ok；槽位 1 的失败不拖垮它
      expect(res.status).toBe("ok");
      expect(res.claimed).toBe(1);
      expect(res.dispatched).toBe(1);
      expect(res.delivered).toBe(1);
      expect(res.cleaned).toBe(1);
      expect(calls.inference.length).toBe(1);
      const row = await getBridgeJob(db, "s2-text-job");
      expect(row?.pairingId).toBe("bridge-2");
      expect(row?.status).toBe("cleaned");
      // 错误只落在槽位 1 自己的 config 行；槽位 2 干净且在线时间已更新
      const cfg1 = await getBridgeConfig(db, 1);
      expect(cfg1.lastError).not.toBeNull();
      expect(cfg1.lastOnlineAt).toBeNull();
      const cfg2 = await getBridgeConfig(db, 2);
      expect(cfg2.lastError).toBeNull();
      expect(cfg2.lastOnlineAt).not.toBeNull();
    } finally {
      serverB.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 配对迁移：bridgeMovePairing
// ---------------------------------------------------------------------------

describe("配对迁移：bridgeMovePairing", () => {
  test("迁移后目标槽位配置与源原值一致、源槽位清空、响应不含令牌原文", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    // 源槽位带完整的在线/错误/租约状态，验证迁移时目标被重置、源被清零
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://home.example",
      token: "tok-move-secret-789",
      lastOnlineAt: 111_000,
      lastError: "旧错误",
      lastErrorAt: 112_000,
      syncLeaseUntil: Date.now() + 60_000,
      syncLeaseOwner: "owner-1",
    });
    // 目标槽位先放一个旧配对，验证被整体覆盖
    await updateBridgeConfig(db, 2, {
      baseUrl: "https://stale.example",
      token: "tok-stale-000",
      lastOnlineAt: 222_000,
      lastError: "目标旧错误",
      lastErrorAt: 223_000,
    });
    // 一条槽位 1 的任务记录：迁移不得改动任务归属
    await insertJob(db, "job-before-move", "text", { prompt: "x" }, 1);

    const res = await Actions.bridgeMovePairing.handler(ctx, {
      fromSlot: 1,
      toSlot: 2,
    });

    // 目标槽位：地址与令牌与源原值逐字一致（测试库内断言原文）
    const target = await getBridgeConfig(db, 2);
    expect(target.baseUrl).toBe("https://home.example");
    expect(target.token).toBe("tok-move-secret-789");
    // 目标的在线/错误/租约全部清零重置
    expect(target.lastOnlineAt).toBeNull();
    expect(target.lastError).toBeNull();
    expect(target.lastErrorAt).toBeNull();
    expect(target.syncLeaseUntil).toBeNull();
    expect(target.syncLeaseOwner).toBeNull();

    // 源槽位（clearFrom 缺省 true）：清回未配对，状态一并清零
    const source = await getBridgeConfig(db, 1);
    expect(source.baseUrl).toBe("");
    expect(source.token).toBe("");
    expect(source.lastOnlineAt).toBeNull();
    expect(source.lastError).toBeNull();
    expect(source.lastErrorAt).toBeNull();
    expect(source.syncLeaseUntil).toBeNull();
    expect(source.syncLeaseOwner).toBeNull();

    // 任务归属不动
    const job = await getBridgeJob(db, "job-before-move");
    expect(job?.pairingId).toBe("bridge-1");

    // 响应只带掩码，任何位置不出现令牌原文
    expect(res.from).toEqual({
      slot: 1,
      label: "",
      configured: false,
      baseUrl: "",
      tokenMasked: "",
    });
    expect(res.to).toEqual({
      slot: 2,
      label: "",
      configured: true,
      baseUrl: "https://home.example",
      tokenMasked: "tok••••89",
    });
    expect(JSON.stringify(res)).not.toContain("tok-move-secret-789");
    expect(JSON.stringify(res)).not.toContain("tok-stale-000");
  });

  test("clearFrom=false 时源槽位保留原配对", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await updateBridgeConfig(db, 2, {
      baseUrl: "https://two.example",
      token: "tok-two-keep",
    });
    const res = await Actions.bridgeMovePairing.handler(ctx, {
      fromSlot: 2,
      toSlot: 1,
      clearFrom: false,
    });
    expect(res.from.configured).toBe(true);
    expect(res.to.configured).toBe(true);
    expect((await getBridgeConfig(db, 2)).token).toBe("tok-two-keep");
    expect((await getBridgeConfig(db, 1)).baseUrl).toBe("https://two.example");
    expect((await getBridgeConfig(db, 1)).token).toBe("tok-two-keep");
  });

  test("源槽位未配对时拒绝；源与目标相同也拒绝", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await expect(
      Actions.bridgeMovePairing.handler(ctx, { fromSlot: 1, toSlot: 2 }),
    ).rejects.toThrow("未配对");
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
    });
    await expect(
      Actions.bridgeMovePairing.handler(ctx, { fromSlot: 1, toSlot: 1 }),
    ).rejects.toThrow("不能相同");
    // 拒绝后源配对原样保留
    expect((await getBridgeConfig(db, 1)).token).toBe("tok-one-123");
  });
});

// ---------------------------------------------------------------------------
// 配对改名：label 按槽位独立
// ---------------------------------------------------------------------------

describe("配对改名：label 按槽位独立", () => {
  test("两槽位分别改名互不影响；未配对槽位可只改名；状态带 label 原文", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    // 槽位 1：配对保存时一并改名，首尾空白保存时去掉
    const saved1 = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
      label: "  家里电脑  ",
    });
    expect(saved1.label).toBe("家里电脑");
    // 槽位 2：未配对，只改名（label-only 调用，不要求地址/令牌）
    const renamed2 = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "",
      label: "公司画布",
      slot: 2,
    });
    expect(renamed2.configured).toBe(false);
    expect(renamed2.label).toBe("公司画布");
    // 两槽位各存各的，互不影响
    expect((await getBridgeConfig(db, 1)).label).toBe("家里电脑");
    expect((await getBridgeConfig(db, 2)).label).toBe("公司画布");
    expect((await getBridgeConfig(db, 2)).baseUrl).toBe("");
    // bridgeStatus 的 pairings 带出 label 原文
    const status = await Actions.bridgeStatus.handler(ctx, {});
    expect(status.pairings[0]?.label).toBe("家里电脑");
    expect(status.pairings[1]?.label).toBe("公司画布");
  });

  test("不带 label 的保存不动已有名字；传空 label 清掉名字恢复缺省", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
      label: "旧名字",
    });
    // 改地址不带 label → 名字保留
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one-b.example",
    });
    expect((await getBridgeConfig(db, 1)).baseUrl).toBe("https://one-b.example");
    expect((await getBridgeConfig(db, 1)).label).toBe("旧名字");
    // 传空字符串 label → 名字清掉（显示名回落缺省「配对 1」）
    const cleared = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one-b.example",
      label: "",
    });
    expect(cleared.label).toBe("");
    expect((await getBridgeConfig(db, 1)).label).toBe("");
    // 纯空白 label 同样清掉
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one-b.example",
      label: "临时名",
    });
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one-b.example",
      label: "   ",
    });
    expect((await getBridgeConfig(db, 1)).label).toBe("");
  });

  test("clear 清除配对时名字一并清掉，另一槽位的名字不受影响", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
      label: "名字一",
    });
    await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "https://two.example",
      token: "tok-two-456",
      label: "名字二",
      slot: 2,
    });
    const cleared = await Actions.bridgeSetConfig.handler(ctx, {
      baseUrl: "",
      clear: true,
      slot: 1,
    });
    expect(cleared.label).toBe("");
    const slot1 = await getBridgeConfig(db, 1);
    expect(slot1.label).toBe("");
    expect(slot1.baseUrl).toBe("");
    expect(slot1.token).toBe("");
    const slot2 = await getBridgeConfig(db, 2);
    expect(slot2.label).toBe("名字二");
    expect(slot2.baseUrl).toBe("https://two.example");
  });

  test("迁移时名字跟随配对：目标拿到源的名字，源名字清掉", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://home.example",
      token: "tok-move-label",
      label: "家里电脑",
    });
    await updateBridgeConfig(db, 2, { label: "目标旧名字" });
    const res = await Actions.bridgeMovePairing.handler(ctx, {
      fromSlot: 1,
      toSlot: 2,
    });
    expect(res.to.label).toBe("家里电脑");
    expect(res.from.label).toBe("");
    expect((await getBridgeConfig(db, 2)).label).toBe("家里电脑");
    expect((await getBridgeConfig(db, 1)).label).toBe("");
  });
});

describe("连接状态：pairingConnection 判定", () => {
  const NOW = 1_800_000_000_000;
  const paired = { baseUrl: "https://x.example", token: "tok-123456" };

  test("未配对：无地址或无令牌都是 unpaired（与在线时间无关）", () => {
    expect(
      pairingConnection({ baseUrl: "", token: "", lastOnlineAt: null }, NOW),
    ).toBe("unpaired");
    expect(
      pairingConnection(
        { baseUrl: "https://x.example", token: "", lastOnlineAt: NOW },
        NOW,
      ),
    ).toBe("unpaired");
    expect(
      pairingConnection({ baseUrl: "", token: "tok-123456", lastOnlineAt: NOW }, NOW),
    ).toBe("unpaired");
  });

  test("已配对且刚在线 → connected", () => {
    expect(pairingConnection({ ...paired, lastOnlineAt: NOW }, NOW)).toBe(
      "connected",
    );
    expect(
      pairingConnection({ ...paired, lastOnlineAt: NOW - 5_000 }, NOW),
    ).toBe("connected");
  });

  test("已配对但从未在线（lastOnlineAt 为空）→ disconnected", () => {
    expect(pairingConnection({ ...paired, lastOnlineAt: null }, NOW)).toBe(
      "disconnected",
    );
  });

  test("已配对但超过 30 秒未在线 → disconnected", () => {
    expect(
      pairingConnection(
        { ...paired, lastOnlineAt: NOW - CONNECTION_ONLINE_WINDOW_MS - 1 },
        NOW,
      ),
    ).toBe("disconnected");
    expect(
      pairingConnection({ ...paired, lastOnlineAt: NOW - 3_600_000 }, NOW),
    ).toBe("disconnected");
  });

  test("阈值边界：恰好 30 秒整算 connected，30 秒 +1ms 算 disconnected", () => {
    expect(CONNECTION_ONLINE_WINDOW_MS).toBe(30_000);
    expect(
      pairingConnection(
        { ...paired, lastOnlineAt: NOW - CONNECTION_ONLINE_WINDOW_MS },
        NOW,
      ),
    ).toBe("connected");
    expect(
      pairingConnection(
        { ...paired, lastOnlineAt: NOW - CONNECTION_ONLINE_WINDOW_MS - 1 },
        NOW,
      ),
    ).toBe("disconnected");
  });

  test("bridgeStatus 的 pairings 带 connection，两槽位各自独立判定", async () => {
    const { db } = makeDb();
    const { ctx } = makeFakeCtx(db);
    // 槽位 1：已配对且刚刚在线 → connected
    await updateBridgeConfig(db, 1, {
      baseUrl: "https://one.example",
      token: "tok-one-123",
      lastOnlineAt: Date.now(),
    });
    // 槽位 2：已配对但最后在线在一分钟前 → disconnected
    await updateBridgeConfig(db, 2, {
      baseUrl: "https://two.example",
      token: "tok-two-456",
      lastOnlineAt: Date.now() - 60_000,
    });
    const status = await Actions.bridgeStatus.handler(ctx, {});
    expect(status.pairings[0]?.connection).toBe("connected");
    expect(status.pairings[1]?.connection).toBe("disconnected");
    // 清掉槽位 2 的配对 → unpaired
    await updateBridgeConfig(db, 2, { baseUrl: "", token: "" });
    const status2 = await Actions.bridgeStatus.handler(ctx, {});
    expect(status2.pairings[1]?.connection).toBe("unpaired");
  });
});
