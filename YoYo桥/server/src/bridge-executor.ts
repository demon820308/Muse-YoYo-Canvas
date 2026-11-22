// bridge-executor.ts — 桥的执行器：按 kind 把一条桥任务真正跑完。
//
// 桥是纯执行器（照单执行）：生成派发口径的唯一事实源
// 在画布侧（云端画布与本地画布同源代码）。本文件不保存任何像素
// 档位表、不做比例归一/尺寸推导/时长钳制——task-* 报文里的目标
// 尺寸只来自对载荷原始报文 payload.message 的机械抽取（原样填入），时长只来自
// parsed.durationSeconds（原样填入）；direct-image 的 orientation
// 只按 payload.ratio 的宽高机械判断。桥保留的机械纪律只有：成片
// 必须落在作业目录内、probe 实测尺寸如实回填 genSize。
//
// 失败分类：PermanentJobError（载荷本身不可执行 → 行置 failed，
// 同轮回送 fail）；RetryableJobError（参考下载等瞬时失败 → 行留
// queued、清掉本任务已写文件、下一轮续派）。
//
// 生成通道永久锁定（2026-11-22 用户拍板）：桥的全部生成只走
// Muse 内置管线——direct-image 走 ctx.tool.generate_media，
// task-* 的派发报文写死只许后台任务用内置生成工具。MiniMax
// Token Plan 这条线永久掐断：不许经 custom.minimax-cn 连接器
// 或 api.minimaxi.com 的任何生成端点出图/出视频/出音频，
// 内置管线做不到就失败回送，绝不许改走该通道兜底。

import { z, type Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import type { BridgeTransport } from "./bridge-transport";
import {
patchBridgeJob,
transitionBridgeJob,
type BridgeJobRow,
type Db,
} from "./bridge-store";

export class PermanentJobError extends Error {}
export class RetryableJobError extends Error {}

export const SYNC_KINDS = new Set(["direct-image", "text", "prompt-reverse"]);
export const TASK_KINDS = new Set(["task-image", "task-video", "task-audio"]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
return value && typeof value === "object" &&!Array.isArray(value)
? (value as JsonRecord)
: null;
}

function strField(record: JsonRecord | null, key: string): string {
const value = record?.[key];
return typeof value === "string"? value: "";
}

export function errMsg(err: unknown): string {
return err instanceof Error? err.message: String(err);
}

export function parseJobPayload(row: BridgeJobRow): JsonRecord | null {
try {
return asRecord(JSON.parse(row.payload));
} catch {
return null;
}
}

/** The one working directory a job owns under the jobs root. */
export function jobDirName(jobId: string): string {
const safe = jobId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
return `job-${safe || "unknown"}`;
}

const EXT_BY_MIME: Record<string, string> = {
"image/webp": ".webp",
"image/png": ".png",
"image/jpeg": ".jpg",
"image/gif": ".gif",
"video/mp4": ".mp4",
"video/webm": ".webm",
"video/quicktime": ".mov",
"audio/mpeg": ".mp3",
"audio/mp4": ".m4a",
"audio/wav": ".wav",
"audio/x-wav": ".wav",
"audio/aac": ".aac",
"audio/ogg": ".ogg",
};

export function extForMime(mime: string | null | undefined): string {
const ext = mime ? EXT_BY_MIME[mime] : undefined;
return ext ?? ".bin";
}

const ALLOWED_EXTS = new Set([
".png", ".jpg", ".jpeg", ".webp", ".gif",
".mp4", ".webm", ".mov",
".mp3", ".m4a", ".wav", ".aac", ".ogg",
]);

function extFromPath(path: string, kind: string): string {
const match = /\.([a-z0-9]+)$/i.exec(path);
const rawExt = match?.[1];
const ext = rawExt? `.${rawExt.toLowerCase()}`: "";
if (ALLOWED_EXTS.has(ext)) return ext;
return kind === "video"? ".mp4": kind === "audio"? ".mp3": ".png";
}

/** direct-image orientation: a purely mechanical read of
* payload.ratio — wider than tall → landscape, taller → portrait,
* equal or unparseable → square. No tier table, no normalization. */
export function mechanicalOrientation(
ratio: unknown,
): "landscape" | "portrait" | "square" {
if (typeof ratio!== "string") return "square";
const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
if (!match) return "square";
const w = Number(match[1]);
const h = Number(match[2]);
if (!(w > 0) ||!(h > 0)) return "square";
if (w > h) return "landscape";
if (h > w) return "portrait";
return "square";
}

/** Extracts the local-relative path of a prompt-reverse source
* image from its local absolute path. Null when the marker is
* absent — a permanent failure, the bridge never guesses a path. */
export function extractReverseRelPath(imageFilePath: string): string | null {
const normalized = imageFilePath.replace(/\\/g, "/");
const marker = "yoyo-canvas-projects/";
const at = normalized.indexOf(marker);
if (at < 0) return null;
const rel = normalized.slice(at + marker.length);
return rel? rel: null;
}

/** Payload validation for the synchronous kinds, run before the
* claim is acked. Returns the permanent-failure message, or null
* when the payload is executable. */
export function validateSyncPayload(row: BridgeJobRow): string | null {
const payload = parseJobPayload(row);
if (row.kind === "direct-image" || row.kind === "text") {
if (!strField(payload, "prompt").trim()) {
return "本地任务提示词为空，无法生成";
}
return null;
}
if (row.kind === "prompt-reverse") {
if (!extractReverseRelPath(strField(payload, "imageFilePath"))) {
return "无法从本地图片路径中提取相对路径，逆推任务无法执行";
}
return null;
}
return `未知任务类型：${row.kind || "(空)"}`;
}

// ---------------------------------------------------------------------------
// Synchronous kinds (run to done/failed inside the sync round)
// ---------------------------------------------------------------------------

async function failSyncJob(db: Db, jobId: string, error: string): Promise<void> {
await transitionBridgeJob(db, jobId, ["queued"], "failed", { error});
}

async function executeDirectImage(
ctx: Ctx,
db: Db,
row: BridgeJobRow,
payload: JsonRecord,
): Promise<void> {
const prompt = strField(payload, "prompt");
// ctx.tool.generate_media 是平台内置生成管线，不走 MiniMax
// Token Plan——符合 2026-11-22 的永久通道锁定。
const generated = await ctx.tool.generate_media(prompt, {
orientation: mechanicalOrientation(payload.ratio),
});
const dirName = row.jobDir?? jobDirName(row.jobId);
const ensured = await ctx.executePrivileged(Contracts.ensureJobDir, {
dirName,
});
void ensured;
const fileName = `result${extForMime(generated.contentType)}`;
const mirrored = await ctx.executePrivileged(
Contracts.mirrorBlobToJobFile,
{
spaceDir: ctx.spaceDir,
blobKey: generated.blobKey,
dirName,
fileName,
},
);
const probe = await ctx.executePrivileged(Contracts.probeJobFile, {
path: mirrored.path,
});
await transitionBridgeJob(db, row.jobId, ["queued"], "done", {
jobDir: dirName,
resultType: "media",
resultFilePath: mirrored.path,
resultFileName: fileName,
resultContentType: generated.contentType,
resultTitle: null,
genSize:
probe.width!= null && probe.height!= null
? `${probe.width}x${probe.height}`
: null,
error: null,
});
}

async function executeText(
ctx: Ctx,
db: Db,
row: BridgeJobRow,
payload: JsonRecord,
): Promise<void> {
const prompt = strField(payload, "prompt");
const result = await ctx.inference.complete(
`任务要求：${prompt}\n\n只输出正文，不要解释你的写作过程。`,
{
schema: z.object({ text: z.string().min(1).max(20000)}),
system:
strField(payload, "system") ||
"你是一位文字创作者，按用户的要求直接产出可用的文字成品。",
timeout_secs: 120,
},
);
await transitionBridgeJob(db, row.jobId, ["queued"], "done", {
resultType: "text",
resultText: result.text,
resultTitle: strField(payload, "resultTitle") || null,
error: null,
});
}

const INFERENCE_MAX_BYTES = 1 * 1024 * 1024;
const INFERENCE_MAX_EDGE = 1536;

async function executePromptReverse(
ctx: Ctx,
db: Db,
transport: BridgeTransport,
row: BridgeJobRow,
payload: JsonRecord,
): Promise<void> {
const relPath = extractReverseRelPath(strField(payload, "imageFilePath"));
if (!relPath) {
await failSyncJob(db, row.jobId, "无法从本地图片路径中提取相对路径，逆推任务无法执行");
return;
}
const dirName = row.jobDir?? jobDirName(row.jobId);
const dir = await ctx.executePrivileged(Contracts.ensureJobDir, { dirName});
await patchBridgeJob(db, row.jobId, { jobDir: dirName});
const bytes = await transport.downloadFile(relPath);
const sourceName = `source${extFromPath(relPath, "image")}`;
const written = await ctx.executePrivileged(Contracts.writeJobFile, {
dirName,
fileName: sourceName,
dataBase64: Buffer.from(bytes).toString("base64"),
});
let file = await ctx.executePrivileged(Contracts.readJobFile, {
path: written.path,
});
let currentPath = written.path;
if (file.contentType!== "image/png" && file.contentType!== "image/jpeg") {
const converted = await ctx.executePrivileged(
Contracts.convertImageToPng,
{ input: currentPath, outputDir: dir.path, fileName: "converted.png"},
);
currentPath = converted.path;
file = await ctx.executePrivileged(Contracts.readJobFile, {
path: currentPath,
});
if (file.contentType!== "image/png" && file.contentType!== "image/jpeg") {
await failSyncJob(db, row.jobId, "逆推原图格式无法转换为 PNG/JPEG，逆推任务无法执行");
return;
}
}
const probe = await ctx.executePrivileged(Contracts.probeJobFile, {
path: currentPath,
});
let width = probe.width?? 0;
let height = probe.height?? 0;
if (
file.sizeBytes > INFERENCE_MAX_BYTES ||
Math.max(width, height) > INFERENCE_MAX_EDGE
) {
const shrunk = await ctx.executePrivileged(
Contracts.shrinkImageForInference,
{
input: currentPath,
outputDir: dir.path,
fileName: "shrunk.jpg",
maxEdge: INFERENCE_MAX_EDGE,
maxBytes: INFERENCE_MAX_BYTES,
},
);
currentPath = shrunk.path;
width = shrunk.width;
height = shrunk.height;
file = await ctx.executePrivileged(Contracts.readJobFile, {
path: currentPath,
});
}
const mimeType = file.contentType === "image/png"? "image/png": "image/jpeg";
let result: { text: string};
try {
result = await ctx.inference.complete(strField(payload, "prompt"), {
schema: z.object({ text: z.string().min(1).max(12000)}),
system:
strField(payload, "system") ||
"你是一位图片分析师，擅长把图片逆推成生图提示词与详细画面描述。",
images: [{ dataBase64: file.dataBase64, mimeType, filename: "image"}],
timeout_secs: 120,
});
} catch (err) {
const sizeMB = (file.sizeBytes / 1024 / 1024).toFixed(2);
await failSyncJob(
db,
row.jobId,
`${errMsg(err)}（本次发送图片 ${width}x${height}，大小 ${sizeMB}MB）`,
);
return;
}
await transitionBridgeJob(db, row.jobId, ["queued"], "done", {
resultType: "text",
resultText: result.text,
resultTitle: strField(payload, "resultTitle") || null,
error: null,
});
}

/** Runs one synchronous kind to completion. Expected failures land
* on the row as failed; only infrastructure surprises throw. */
export async function executeSyncJob(
ctx: Ctx,
db: Db,
transport: BridgeTransport,
row: BridgeJobRow,
): Promise<void> {
const payload = parseJobPayload(row);
try {
if (row.kind === "direct-image") {
await executeDirectImage(ctx, db, row, payload?? {});
} else if (row.kind === "text") {
await executeText(ctx, db, row, payload?? {});
} else if (row.kind === "prompt-reverse") {
await executePromptReverse(ctx, db, transport, row, payload?? {});
} else {
await failSyncJob(db, row.jobId, `未知任务类型：${row.kind || "(空)"}`);
}
} catch (err) {
await failSyncJob(db, row.jobId, errMsg(err));
}
}

// ---------------------------------------------------------------------------
// Task kinds (task-image / task-video / task-audio via spawnTask)
// ---------------------------------------------------------------------------

export type ParsedTaskPayload = {
prompt: string;
targetSize: string | null;
durationSeconds: unknown;
refs: { kind: string; title: string; relPath: string | null}[];
};

/** Mechanically extracts the target pixel size from the payload's
* original canvas-assembled message: the canvas dispatch code writes
* a size line shaped '确切像素尺寸：<宽>x<高>' and the bridge lifts
* exactly the digit string after that prefix, verbatim. The pixel
* caliber's source of truth stays in the canvas-side message
* assembly; the bridge derives nothing. Null when the message
* carries no such string. */
export function extractTargetSize(message: unknown): string | null {
if (typeof message !== "string") return null;
const match = /确切像素尺寸：(\d+)x(\d+)/.exec(message);
const w = match?.[1];
const h = match?.[2];
return w && h ? `${w}x${h}` : null;
}

/** Validates a task-* payload. Pure — no I/O — so the claim phase
* can classify permanent failures before any download happens.
* The target size is extracted mechanically from the payload's
* original message (see extractTargetSize); the bridge never
* derives a size itself, so a missing one is permanent. */
export function parseTaskPayload(
row: BridgeJobRow,
): { parsed: ParsedTaskPayload} | { error: string} {
const payload = parseJobPayload(row);
const parsed = asRecord(payload?.parsed);
if (!parsed) return { error: "本地任务缺少 parsed 内容，无法执行"};
const prompt = strField(parsed, "prompt");
if (!prompt.trim()) return { error: "本地任务提示词为空，无法生成"};
let targetSize: string | null = null;
if (row.kind === "task-image" || row.kind === "task-video") {
targetSize = extractTargetSize(payload?.message);
if (!targetSize) return { error: "payload_missing_target_size"};
}
const refsRaw = Array.isArray(parsed.refs)? parsed.refs: [];
const refs = refsRaw
.map((r) => asRecord(r))
.filter((r): r is JsonRecord => r!= null)
.map((r) => ({
kind: strField(r, "kind") || "image",
title: strField(r, "title"),
relPath: typeof r.relPath === "string"? r.relPath: null,
}));
return {
parsed: {
prompt,
targetSize,
durationSeconds: parsed.durationSeconds?? null,
refs,
},
};
}

/** The spawn brief for a task-* job: a purely mechanical template.
* The prompt, target size and duration are the payload's own words,
* passed through verbatim; reference lines name the files the
* bridge downloaded into this job's own directory. */
export function buildTaskMessage(
row: BridgeJobRow,
parsed: ParsedTaskPayload,
jobDirPath: string,
refPaths: string[],
): string {
const kind = row.kind;
const lines: string[] = [];
if (kind === "task-video") {
lines.push(
"任务：为YoYo画布的一个节点生成一段视频，并把成片文件路径通过 completeBridgeJob 动作回传（runtime 会注入调用该动作的说明）。",
);
} else if (kind === "task-audio") {
lines.push(
"任务：为YoYo画布的一个节点生成一段音频，并把成片文件路径通过 completeBridgeJob 动作回传（runtime 会注入调用该动作的说明）。",
);
} else {
lines.push(
"任务：为YoYo画布的一个节点生成一张图片，并把成片文件路径通过 completeBridgeJob 动作回传（runtime 会注入调用该动作的说明）。",
);
}
lines.push(
"生成通道（永久锁定）：只能用 Muse 内置生成管线出片——即本任务自带的内置生成工具（media.generate_image / media.generate_video 等），不要调用任何外部生成 API 或连接器。",
);
lines.push(
"⛔ 永久禁用 MiniMax Token Plan：不许使用 custom.minimax-cn 连接器，不许调用 api.minimaxi.com 的任何生成端点（/v1/video_generation、/v2/video_generation、/v1/image_generation、/v1/t2a_v2、/v1/voice_clone 等），不许使用 Hailuo 系列、MiniMax-H3、image-01 等 MiniMax 模型，不许运行 minimax_chat.py / minimax_probe.py / minimax_get.py 等 MiniMax 助手脚本来做生成。内置管线做不到时，直接调用 failBridgeJob 写清失败原因，绝不许改走 MiniMax 或任何其他消耗用户订阅额度的通道兜底。",
);
lines.push(`jobId（原样回传，不要改动）：${row.jobId}`);
if (kind === "task-video") lines.push(`视频提示词：${parsed.prompt}`);
else if (kind === "task-audio") lines.push(`音频内容要求：${parsed.prompt}`);
else lines.push(`生成要求：${parsed.prompt}`);
if (parsed.targetSize) {
lines.push(
`目标像素尺寸：${parsed.targetSize}（宽x高，生成时请按这个尺寸出图，不要再缩放改尺寸）`,
);
}
if (
kind === "task-video" &&
parsed.durationSeconds!= null &&
parsed.durationSeconds!== ""
) {
lines.push(`目标时长：约 ${String(parsed.durationSeconds)} 秒`);
}
if (refPaths.length > 0) {
if (kind === "task-audio") {
const refLines = parsed.refs
.map((ref, i) => {
const label =
ref.kind === "audio"
? "参考音频"
: ref.kind === "video"
? "参考视频"
: "参考图片";
return `${label}（${ref.title || "未命名"}）：${refPaths[i]?? ""}`;
})
.join("\n");
lines.push(`可参考下面这些本地文件：\n${refLines}`);
} else {
const refLines = parsed.refs
.map(
(ref, i) =>
`参考图 ${i + 1}（${ref.title || "未命名"}）：${refPaths[i]?? ""}`,
)
.join("\n");
lines.push(
kind === "task-video"
? `必须使用下面这些本地图片文件作为参考图（人物长相/造型以参考图为准，把它们作为生成工具的参考图输入）：\n${refLines}`
: `必须使用下面这些本地图片文件作为参考图（人物长相/造型/构图以参考图为准，把它们作为生成工具的参考图输入，不要只看文字描述）：\n${refLines}`,
);
}
}
lines.push(
`作业目录（本任务专属，成片必须保存到这个目录里，文件名自定）：${jobDirPath}`,
);
if (kind === "task-video") {
lines.push(
"要求：只生成这一段视频；拿到成片的本地文件路径后调用 completeBridgeJob，jobId 同上，filePath 传绝对路径。如果生成失败，调用 failBridgeJob，jobId 同上，error 写清失败原因。",
);
} else if (kind === "task-audio") {
lines.push(
"要求：只生成这一段音频；拿到音频文件的本地文件路径后调用 completeBridgeJob，jobId 同上，filePath 传绝对路径。如果生成失败，调用 failBridgeJob，jobId 同上，error 写清失败原因。",
);
} else {
lines.push(
"要求：只生成这一张图片；拿到成片的本地文件路径后调用 completeBridgeJob，jobId 同上，filePath 传绝对路径。如果生成失败，调用 failBridgeJob，jobId 同上，error 写清失败原因。",
);
}
return lines.join("\n");
}

/** Prepares a task-* job for dispatch: ensures the job directory,
* downloads every reference file into it, and builds the spawn
* brief. Permanent problems throw PermanentJobError; a failed
* reference download throws RetryableJobError after cleaning the
* files this attempt already wrote (the row stays queued). */
export async function prepareTaskJob(
ctx: Ctx,
db: Db,
transport: BridgeTransport,
row: BridgeJobRow,
): Promise<{ message: string}> {
const check = parseTaskPayload(row);
if ("error" in check) throw new PermanentJobError(check.error);
const { parsed} = check;
const dirName = row.jobDir?? jobDirName(row.jobId);
const dir = await ctx.executePrivileged(Contracts.ensureJobDir, { dirName});
await patchBridgeJob(db, row.jobId, { jobDir: dirName});
const refPaths: string[] = [];
const writtenNames: string[] = [];
try {
for (let i = 0; i < parsed.refs.length; i += 1) {
const ref = parsed.refs[i];
if (!ref) continue;
if (!ref.relPath) {
throw new PermanentJobError(
`参考文件「${ref.title || "未命名"}」缺少本地路径，无法取回`,
);
}
let bytes: Uint8Array;
try {
bytes = await transport.downloadFile(ref.relPath);
} catch (err) {
throw new RetryableJobError(errMsg(err));
}
const fileName = `ref-${i + 1}${extFromPath(ref.relPath, ref.kind)}`;
const written = await ctx.executePrivileged(Contracts.writeJobFile, {
dirName,
fileName,
dataBase64: Buffer.from(bytes).toString("base64"),
});
writtenNames.push(fileName);
refPaths.push(written.path);
}
} catch (err) {
if (err instanceof RetryableJobError) {
for (const name of writtenNames) {
try {
await ctx.executePrivileged(Contracts.deleteJobFile, {
dirName,
fileName: name,
});
} catch {
// Best-effort cleanup; the retry rewrites the same names.
}
}
}
throw err;
}
return {
message: buildTaskMessage(row, parsed, dir.path, refPaths),
};
}

/** Spawns the background generation task for a prepared job. */
export async function spawnPreparedTask(
ctx: Ctx,
db: Db,
row: BridgeJobRow,
message: string,
): Promise<void> {
const spawned = await ctx.agent.spawnTask(message, {
expectsAction: "completeBridgeJob",
dedupeKey: `yoyo-bridge-${row.kind}-${row.jobId}`,
});
if (!spawned.ok) {
await transitionBridgeJob(db, row.jobId, ["queued"], "failed", {
error: spawned.error,
});
return;
}
await transitionBridgeJob(db, row.jobId, ["queued"], "working");
}
