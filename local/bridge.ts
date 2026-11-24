// [yoyo-local] 本地桥端点（S1 第四/七节）：挂在本地后端上，与画布自身接口分开。五个端点：
//   GET  /bridge/pending    待拉任务（status=queued 的桥任务）
//   GET  /bridge/files/*    参考文件（项目目录内，路径穿越拒绝）
//   POST /bridge/ack-claim  认领确认（queued → claimed，幂等）
//   POST /bridge/result     结果接收：媒体走原始字节流落盘后复用既有
//                           complete*Generation 落地（其中 ffprobe
//                           复测尺寸）；文本走 JSON 并经 attachResultNode
//                           落地。同一 jobId 重复投递只处理一次。
//   POST /bridge/fail       失败接收：经 failGeneration 同口径把节点
//                           标失败，任务结算为 failed。
// 鉴权：桥令牌解析到账号档案（local/bridge-profiles.ts，多账号
// 手动切换，Wei 2026-11-22 08:40 定版），常量时间比较；无任何
// 档案时五端点统一 503 bridge_not_configured，未知令牌 401。
// 门控：只有「当前档案」的桥能领新任务——非当前档案调 pending
// 回 200 { jobs: [], inactive: true }、ack-claim 回 200
// { status: "inactive" } 不认领；result / fail / files 对任意已知档案放行（切换发生在任务在途时，原桥要能把结果送回来、
// 把参考文件取完，不许丢结果）。
//
// [第三步契约扩展 · 2026-11-22 · 与 Space 桥域 bridge-transport 同步]
// 探针结论要求大文件一律 ≤10MB 分块、失败段可重试，两处扩展：//   1. GET /bridge/files/* 支持 Range（bytes=start-end）分段下载，
//      回 206 + Content-Range；无 Range 时行为与原来一致（整文件）。
//   2. POST /bridge/result 媒体投递支持分块：请求带 x-chunk-index（0 起）和 x-chunk-total 两个头即进入分块模式：
//      每块 ≤10MB 顺序到达；中间块只落 .part 并回
//      { status: "chunk_received", index }，最后一块触发原有落地。
//      已收到的块重发回 duplicate 标记不重复写入；乱序回 409。
//      不带分块头的投递行为与原来完全一致

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Ctx } from "@hatch/space-sdk";
import { Actions } from "../server/src/actions";
import {
  claimBridgeJob,
  getBridgeJob,
  listPendingBridgeJobs,
  settleBridgeJob,
  type BridgeJobRow,
} from "../server/src/actions/bridge-jobs";
import type { Db } from "../server/src/actions/contracts";
import {
  attachResultNode,
  getNodeRow,
  getProjectRow,
} from "../server/src/actions/graph-helpers";
import { expandHome } from "../server/src/actions/project-dirs";
import {
  authenticateBridge,
  recordInactiveVisit,
  recordInvalidToken,
} from "./bridge-profiles";
import { PROJECTS_DIR } from "./config";
import { settleAgentBridgeTurn } from "./agent";
import type { LocalDb } from "./db";

const MAX_RESULT_BYTES = 256 * 1024 * 1024;
const MEDIA_EXTS = new Set([
  ".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".mp3", ".m4a", ".wav", ".aac", ".ogg",
]);
const COMPLETE_ACTION_BY_KIND: Record<string, string> = {
  "task-image": "completeImageGeneration",
  "direct-image": "completeImageGeneration",
  "task-video": "completeVideoGeneration",
  "task-audio": "completeAudioGeneration",
};

type Deps = { db: LocalDb; ctx: Ctx };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function presentedToken(req: Request): string | null {
  return (
    req.headers.get("x-bridge-token") ??
    (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null)
  );
}

function isInsideDir(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function virtualBridgeFilePath(projectId: string, absPath: string): string {
  const base = (PROJECTS_DIR ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/_bridge/${projectId}/${basename(absPath)}`;
}

function jobWire(job: BridgeJobRow) {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(job.payload);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const projectsRoot = PROJECTS_DIR ?? "";
  const pid = job.projectId ?? "";
  if (
    typeof payload.imageFilePath === "string" &&
    (!projectsRoot || !isInsideDir(projectsRoot, payload.imageFilePath))
  ) {
    payload = {
      ...payload,
      imageFilePath: virtualBridgeFilePath(pid, payload.imageFilePath),
    };
  }
  if (payload.parsed && typeof payload.parsed === "object") {
    const parsedObj = payload.parsed as { refs?: Array<{ path?: string; relPath?: string | null }> };
    if (Array.isArray(parsedObj.refs)) {
      payload = {
        ...payload,
        parsed: {
          ...parsedObj,
          refs: parsedObj.refs.map((ref) => {
            if (!ref.relPath && typeof ref.path === "string" && ref.path.trim()) {
              return {
                ...ref,
                relPath: `_bridge/${pid}/${basename(ref.path)}`,
                path: virtualBridgeFilePath(pid, ref.path),
              };
            }
            return ref;
          }),
        },
      };
    }
  }
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    projectId: job.projectId,
    nodeId: job.nodeId,
    expectsAction: job.expectsAction,
    payload,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function handleBridge(
  req: Request,
  url: URL,
  deps: Deps,
): Promise<Response> {
  const auth = authenticateBridge(presentedToken(req));
  if (auth.state === "unconfigured") {
    return json({ error: "bridge_not_configured" }, 503);
  }
  if (auth.state === "invalid") {
    recordInvalidToken();
    return json({ error: "invalid_bridge_token" }, 401);
  }
  const isActive = auth.isActive;
  const db = deps.db as unknown as Db;
  const path = url.pathname;

  if (req.method === "GET" && path === "/bridge/pending") {
    if (!isActive) {
      recordInactiveVisit(auth.profile);
      return json({ jobs: [], inactive: true });
    }
    const jobs = await listPendingBridgeJobs(db);
    return json({ jobs: jobs.map(jobWire) });
  }

  if (req.method === "GET" && path.startsWith("/bridge/files/")) {
    const rel = decodeURIComponent(path.slice("/bridge/files/".length));
    let full: string;
    const bridgeMatch = rel.match(/^_bridge\/([^/]+)\/(.+)$/);
    if (bridgeMatch) {
      const [, projectId, subPath] = bridgeMatch;
      const project = projectId ? await getProjectRow(db, projectId) : null;
      if (!project) return json({ error: "project_not_found" }, 404);
      const projectRoot = resolve(expandHome(project.workspaceDir));
      full = resolve(projectRoot, subPath ?? "");
      if (!isInsideDir(projectRoot, full)) {
        return json({ error: "path_outside_project" }, 400);
      }
    } else {
      full = resolve(PROJECTS_DIR, rel);
      if (full !== PROJECTS_DIR && !full.startsWith(PROJECTS_DIR + sep)) {
        return json({ error: "path_outside_projects" }, 400);
      }
    }
    const file = Bun.file(full);
    if (!(await file.exists())) return json({ error: "file_not_found" }, 404);
    const headers: Record<string, string> = {
      "content-type": file.type || "application/octet-stream",
      "accept-ranges": "bytes",
    };
    // Range 分段下载（第三步契约扩展）：bytes=start-end / bytes=start-
    const range = req.headers.get("range");
    const rangeMatch = range?.match(/^bytes=(\d+)-(\d*)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] ? Number(rangeMatch[2]) : file.size - 1;
      if (start >= file.size || end < start) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${file.size}` },
        });
      }
      const clampedEnd = Math.min(end, file.size - 1);
      headers["content-range"] = `bytes ${start}-${clampedEnd}/${file.size}`;
      headers["content-length"] = String(clampedEnd - start + 1);
      return new Response(file.slice(start, clampedEnd + 1), {
        status: 206,
        headers,
      });
    }
    headers["content-length"] = String(file.size);
    return new Response(file, { headers });
  }

  if (req.method === "POST" && path === "/bridge/ack-claim") {
    const body = (await req.json().catch(() => null)) as { jobId?: string } | null;
    if (!isActive) {
      // 非当前档案不许认领：桥侧据此安静空转，任务留给当前桥
      return json({ jobId: body?.jobId ?? null, status: "inactive" });
    }
    if (!body?.jobId) return json({ error: "jobId_required" }, 400);
    const existing = await getBridgeJob(db, body.jobId);
    if (!existing) return json({ error: "job_not_found" }, 404);
    const claimed = await claimBridgeJob(db, body.jobId);
    return json({
      jobId: body.jobId,
      status: claimed?.status ?? existing.status,
    });
  }

  if (req.method === "POST" && path === "/bridge/fail") {
    const body = (await req.json().catch(() => null)) as
      | { jobId?: string; error?: string }
      | null;
    if (!body?.jobId) return json({ error: "jobId_required" }, 400);
    const job = await getBridgeJob(db, body.jobId);
    if (!job) return json({ error: "job_not_found" }, 404);
    if (job.status === "done" || job.status === "failed") {
      return json({ jobId: job.jobId, status: job.status, duplicate: true });
    }
    const error = (body.error ?? "云端生成失败").slice(0, 1000);
    if (job.nodeId) {
      const node = await getNodeRow(db, job.nodeId);
      if (node) {
        await Actions.failGeneration.handler(deps.ctx, {
          projectId: job.projectId ?? node.projectId,
          nodeId: job.nodeId,
          error,
        });
      }
    }
    const settled = await settleBridgeJob(db, job.jobId, "failed", error);
    try {
      const payload = JSON.parse(job.payload) as { agentTurnId?: string };
      if (payload.agentTurnId) {
        settleAgentBridgeTurn(payload.agentTurnId, { ok: false, error });
      }
    } catch {
      // ignore invalid payload
    }
    return json({ jobId: job.jobId, status: settled?.status ?? "failed" });
  }

  if (req.method === "POST" && path === "/bridge/result") {
    return handleResult(req, deps, db);
  }

  return json({ error: "unknown_bridge_route" }, 404);
}

async function handleResult(req: Request, deps: Deps, db: Db): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let jobId = req.headers.get("x-job-id") ?? "";
  let text: string | null = null;
  if (isJson) {
    const body = (await req.json().catch(() => null)) as
      | { jobId?: string; text?: string }
      | null;
    if (!body?.jobId) return json({ error: "jobId_required" }, 400);
    jobId = body.jobId;
    text = typeof body.text === "string" ? body.text : null;
  }
  if (!jobId) return json({ error: "jobId_required" }, 400);
  const job = await getBridgeJob(db, jobId);
  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.status === "done") {
    return json({ jobId, status: "done", duplicate: true });
  }
  if (job.status === "failed") {
    return json({ jobId, status: "failed", duplicate: true });
  }

  if (text !== null) {
    if (job.kind !== "text" && job.kind !== "prompt-reverse") {
      return json({ error: "job_kind_not_text" }, 422);
    }
    let payload: { resultTitle?: string; agentTurnId?: string } = {};
    try {
      payload = JSON.parse(job.payload) as { resultTitle?: string; agentTurnId?: string };
    } catch {
      payload = {};
    }
    if (payload.agentTurnId) {
      await settleBridgeJob(db, jobId, "done");
      settleAgentBridgeTurn(payload.agentTurnId, { ok: true, text });
      return json({ jobId, status: "done", agentTurnId: payload.agentTurnId });
    }
    if (!job.nodeId) return json({ error: "job_has_no_node" }, 422);
    const node = await getNodeRow(db, job.nodeId);
    if (!node) return json({ error: "node_not_found" }, 404);
    const landedId = await attachResultNode(db, node, {
      type: "text",
      mediaBlobKey: null,
      mimeType: null,
      filePath: null,
      title: payload.resultTitle ?? (node.title ? `${node.title} · 文本` : "生成文本"),
      content: text,
      prompt: text,
    });
    await settleBridgeJob(db, jobId, "done");
    return json({ jobId, status: "done", resultNodeId: landedId });
  }

  if (!job.nodeId) return json({ error: "job_has_no_node" }, 422);
  const node = await getNodeRow(db, job.nodeId);
  if (!node) return json({ error: "node_not_found" }, 404);

  const actionName = COMPLETE_ACTION_BY_KIND[job.kind];
  if (!actionName) return json({ error: "job_kind_not_media" }, 422);
  const project = await getProjectRow(db, node.projectId);
  if (!project) return json({ error: "project_not_found" }, 404);
  const rawName = req.headers.get("x-file-name") ?? `bridge-${jobId}.bin`;
  const fileName = basename(decodeURIComponent(rawName));
  if (!MEDIA_EXTS.has(extname(fileName).toLowerCase())) {
    return json({ error: "unsupported_media_extension" }, 400);
  }
  const dir = resolve(project.workspaceDir);
  await mkdir(dir, { recursive: true });
  const tmpPath = resolve(dir, `.bridge-${jobId}.part`);
  const finalPath = resolve(dir, fileName);
  const titleHeader = req.headers.get("x-title");
  const title = titleHeader ? decodeURIComponent(titleHeader) : undefined;

  const expectedSha = parseExpectedSha256(req);
  if (expectedSha === "invalid") {
    return json({ error: "invalid_checksum_header" }, 400);
  }

  // 分块模式（第三步契约扩展）：带 x-chunk-index / x-chunk-total 头
  const chunkIndex = req.headers.get("x-chunk-index");
  const chunkTotal = req.headers.get("x-chunk-total");
  if (chunkIndex !== null || chunkTotal !== null) {
    return handleChunkedResult(req, deps, db, {
      job,
      node,
      actionName,
      tmpPath,
      finalPath,
      title,
      expectedSha,
      chunkIndex: Number(chunkIndex),
      chunkTotal: Number(chunkTotal),
    });
  }

  const written = await streamBodyToFile(req, tmpPath);
  if (written.error) {
    await rm(tmpPath, { force: true });
    return json({ error: written.error }, written.status);
  }
  return verifyAndLandResult(deps, db, {
    job,
    actionName,
    tmpPath,
    finalPath,
    title,
    expectedSha,
  });
}

function parseExpectedSha256(req: Request): string | null | "invalid" {
  const raw = req.headers.get("x-content-sha256")?.trim().toLowerCase();
  if (!raw) return null;
  return /^[0-9a-f]{64}$/.test(raw) ? raw : "invalid";
}

function fileSha256(filePath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => res(hash.digest("hex")));
    stream.on("error", rej);
  });
}

async function verifyAndLandResult(
  deps: Deps,
  db: Db,
  opts: {
    job: BridgeJobRow;
    actionName: string;
    tmpPath: string;
    finalPath: string;
    title: string | undefined;
    expectedSha: string | null;
  },
): Promise<Response> {
  if (opts.expectedSha) {
    const actual = await fileSha256(opts.tmpPath);
    if (actual !== opts.expectedSha) {
      await rm(opts.tmpPath, { force: true });
      return json({ error: "checksum_mismatch" }, 422);
    }
  }
  await rename(opts.tmpPath, opts.finalPath);
  return landMediaResultFile(
    deps,
    db,
    opts.job,
    opts.actionName,
    opts.finalPath,
    opts.title,
  );
}

/** 文件已完整落盘后的落地：复用既有 complete*Generation（其
 * ffprobe 复测尺寸），并按结果结算本地桥任务。整流与分块两条路径
 * 共用，保证落地口径只有一份。*/
async function landMediaResultFile(
  deps: Deps,
  db: Db,
  job: BridgeJobRow,
  actionName: string,
  finalPath: string,
  title: string | undefined,
): Promise<Response> {
  const complete = Actions[actionName as keyof typeof Actions] as {
    handler: (ctx: Ctx, args: unknown) => Promise<{
      status: string;
      resultNodeId: string | null;
      error: string | null;
    }>;
  };
  const result = await complete.handler(deps.ctx, {
    nodeId: job.nodeId,
    filePath: finalPath,
    ...(title ? { title } : {}),
  });
  if (result.status === "done") {
    await settleBridgeJob(db, job.jobId, "done");
    return json({ jobId: job.jobId, status: "done", resultNodeId: result.resultNodeId });
  }
  await settleBridgeJob(db, job.jobId, "failed", result.error ?? "落地失败");
  return json({ jobId: job.jobId, status: "failed", error: result.error }, 422);
}

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/** 分块接收：块按 index 顺序追加到 .part，已收块数记
 * .chunks 边车文件里。重发已收块回 duplicate 不重复写；乱序回 409 带 expected；最后一块 rename 后走统一落地。*/
async function handleChunkedResult(
  req: Request,
  deps: Deps,
  db: Db,
  args: {
    job: BridgeJobRow;
    node: unknown;
    actionName: string;
    tmpPath: string;
    finalPath: string;
    title: string | undefined;
    expectedSha: string | null;
    chunkIndex: number;
    chunkTotal: number;
  },
): Promise<Response> {
  const { job, tmpPath, finalPath } = args;
  const index = args.chunkIndex;
  const total = args.chunkTotal;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 0 ||
    index >= total
  ) {
    return json({ error: "invalid_chunk_headers" }, 400);
  }
  const countPath = `${tmpPath}.chunks`;
  let received = 0;
  try {
    received = Number.parseInt((await readFile(countPath, "utf8")).trim(), 10) || 0;
  } catch {
    received = 0;
  }
  if (index < received) {
    return json({ jobId: job.jobId, status: "chunk_received", index, duplicate: true });
  }
  if (index > received) {
    return json({ error: "chunk_out_of_order", expected: received }, 409);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return json({ error: "empty_chunk" }, 400);
  if (bytes.byteLength > MAX_CHUNK_BYTES) {
    return json({ error: "chunk_too_large" }, 413);
  }
  if (index === 0) {
    await writeFile(tmpPath, bytes);
  } else {
    await appendFile(tmpPath, bytes);
  }
  const info = await stat(tmpPath);
  if (info.size > MAX_RESULT_BYTES) {
    await rm(tmpPath, { force: true });
    await rm(countPath, { force: true });
    return json({ error: "result_too_large" }, 413);
  }
  received += 1;
  await writeFile(countPath, String(received));
  if (index < total - 1) {
    return json({ jobId: job.jobId, status: "chunk_received", index });
  }
  // 最后一块：.part 校验转正并落地，边车文件清掉
  await rm(countPath, { force: true });
  return verifyAndLandResult(deps, db, {
    job,
    actionName: args.actionName,
    tmpPath,
    finalPath,
    title: args.title,
    expectedSha: args.expectedSha,
  });
}

async function streamBodyToFile(
  req: Request,
  target: string,
): Promise<{ bytes: number; error?: string; status: number }> {
  if (!req.body) return { bytes: 0, error: "empty_body", status: 400 };
  const out = createWriteStream(target);
  const reader = req.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESULT_BYTES) {
        await reader.cancel().catch(() => {});
        out.destroy();
        return { bytes, error: "result_too_large", status: 413 };
      }
      await new Promise<void>((resolveWrite, rejectWrite) => {
        out.write(value, (err) => (err ? rejectWrite(err) : resolveWrite()));
      });
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.end(() => resolveEnd());
      out.on("error", rejectEnd);
    });
    const info = await stat(target);
    if (info.size === 0) return { bytes: 0, error: "empty_body", status: 400 };
    return { bytes, status: 200 };
  } catch (err) {
    out.destroy();
    return {
      bytes,
      error: err instanceof Error ? err.message : String(err),
      status: 500,
    };
  }
}
