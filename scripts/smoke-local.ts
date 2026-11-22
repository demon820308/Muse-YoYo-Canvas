// [yoyo-local] 本机实测脚本：对已启动的本地服务（默认 127.0.0.1:3737）
// 走完整用户流并逐项断言，输出 PASS/FAIL 证据行。
// 用法：bun scripts/smoke-local.ts [baseUrl]
// 覆盖：建项目 → 上传媒体（blob+落盘+实测尺寸）→ 存图（编号）→
// 提示词库/资产 → 生成入队 → processQueue 认领 → 桥端点（未配对
// 503 / 无令牌 401 / pending / ack-claim 幂等）→ result 媒体落地
// （含重复投递幂等）→ result 文本落地 → fail 落地 → 视频 auto 组装
// （Wei 2026-11-22 定版：本地 auto 即 16:9，报文必带 1280x720）→
// 工具节点本地抽帧 → 项目包导出/导入一致 → 导入带入的存量 auto
// 视频节点同路径组装 → 多账号档案与手动切换（Wei 2026-11-22 定版）
// → 删项目（batch 路径）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:3737";
const TOKEN = "smoke-bridge-token";
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function action<T = any>(name: string, args: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: name, args }),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    throw new Error(`${name} → HTTP ${res.status}: ${body?.error ?? "unknown"}`);
  }
  return body as T;
}

async function bridge(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (init.token !== null) {
    headers.set("x-bridge-token", init.token ?? TOKEN);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dir, "fixtures", name)).toString("base64");
const fixtureBytes = (name: string) =>
  readFileSync(resolve(import.meta.dir, "fixtures", name));

function nodeInput(n: any, overrides: Record<string, unknown> = {}) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    content: n.content ?? "",
    prompt: n.prompt ?? "",
    status: n.status ?? "idle",
    hidden: n.hidden ?? false,
    groupId: n.groupId ?? null,
    color: n.color ?? null,
    freeResize: n.freeResize ?? false,
    fontSize: n.fontSize ?? null,
    genRatio: n.genRatio ?? null,
    genDuration: n.genDuration ?? null,
    genMode: n.genMode ?? null,
    seq: n.seq ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 健康与桥未配对
const health = await fetch(`${BASE}/healthz`).then((r) => r.json() as any);
check("healthz", health.ok === true);

const unpaired = await bridge("/bridge/pending", { token: null });
check("桥未配对时 pending 回 503", unpaired.status === 503, JSON.stringify(unpaired.body));

// ---------------------------------------------------------------- 建项目 + 上传
const project = await action<{ id: string; workspaceDir: string }>("createProject", {
  name: "冒烟项目",
});
const pid = project.id;
check(
  "createProject 工作目录在 data/yoyo-canvas-projects 下",
  project.workspaceDir.includes("/data/yoyo-canvas-projects/") &&
    existsSync(project.workspaceDir),
  project.workspaceDir,
);

const pngUp = await action<any>("uploadMedia", {
  projectId: pid,
  kind: "image",
  fileName: "fixture.png",
  mimeType: "image/png",
  dataBase64: fixture("still.png"),
  x: 600, y: 300, width: 320, height: 240,
});
check("uploadMedia 图片 genSize 实测 64x48", pngUp.node.genSize === "64x48", String(pngUp.node.genSize));
check(
  "uploadMedia 图片落盘到项目目录",
  !!pngUp.filePath && pngUp.filePath.startsWith(project.workspaceDir) && existsSync(pngUp.filePath),
  String(pngUp.filePath),
);
const blobRes = await fetch(`${BASE}${pngUp.node.mediaUrl}`);
const blobBytes = Buffer.from(await blobRes.arrayBuffer());
check(
  "blob URL 可取回且字节一致",
  blobRes.status === 200 && blobBytes.equals(fixtureBytes("still.png")),
  `HTTP ${blobRes.status}, ${blobBytes.byteLength} bytes`,
);

const mp4Up = await action<any>("uploadMedia", {
  projectId: pid,
  kind: "video",
  fileName: "fixture.mp4",
  mimeType: "video/mp4",
  dataBase64: fixture("clip.mp4"),
  x: 600, y: 600, width: 420, height: 300,
});
check("uploadMedia 视频 genSize 实测 160x120", mp4Up.node.genSize === "160x120", String(mp4Up.node.genSize));

// ---------------------------------------------------------------- 整图保存（编号/边）
const T = crypto.randomUUID();
const I = crypto.randomUUID();
const I2 = crypto.randomUUID();
const C = crypto.randomUUID();
const F = crypto.randomUUID();
const V = crypto.randomUUID();
const blank = (id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  nodeInput(
    { id, type, title, x: 0, y: 0, width: 320, height: 240, content: "", prompt: "", status: "idle" },
    extra,
  );
const saved = await action<{ ok: boolean; seqs: { id: string; seq: number | null }[] }>(
  "saveGraph",
  {
    projectId: pid,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      blank(T, "text", "文本", { content: "一只猫在月亮上钓鱼" }),
      blank(I, "image", "生图", { prompt: "月亮上的猫", genRatio: "3:2" }),
      blank(I2, "image", "生图二", { prompt: "海边的灯塔", genRatio: "16:9" }),
      blank(C, "config", "生成配置", { prompt: "写一句晚安", genMode: "text" }),
      blank(F, "video-frames", "视频抽帧"),
      blank(V, "video", "生视频", { prompt: "海浪拍打礁石", genRatio: "auto" }),
      nodeInput(pngUp.node),
      nodeInput(mp4Up.node),
    ],
    edges: [
      { id: crypto.randomUUID(), fromNodeId: T, toNodeId: I },
      { id: crypto.randomUUID(), fromNodeId: mp4Up.node.id, toNodeId: F },
    ],
  },
);
const seqOf = new Map(saved.seqs.map((s) => [s.id, s.seq]));
check(
  "saveGraph 新节点编号从 1 起连续发放",
  seqOf.get(T) === 3 && seqOf.get(I) === 4 && seqOf.get(I2) === 5,
  JSON.stringify(saved.seqs),
);

const got = await action<any>("getProject", { id: pid });
check(
  "getProject 数据一致（8 节点 2 边）",
  got.nodes.length === 8 && got.edges.length === 2,
  `nodes=${got.nodes.length} edges=${got.edges.length}`,
);

const nodeById = new Map<string, any>(got.nodes.map((n: any) => [n.id, n]));
check("文本节点内容原样", nodeById.get(T)?.content === "一只猫在月亮上钓鱼");
check(
  "视频节点 genRatio=auto 原样存入（归一在组装层，不改存储）",
  nodeById.get(V)?.genRatio === "auto",
  `genRatio=${nodeById.get(V)?.genRatio}`,
);

// ---------------------------------------------------------------- 提示词库 / 资产
await action("addPrompt", { title: "冒烟提示词", content: "月亮上的猫，吉卜力风" });
const prompts = await action<any>("listPrompts");
check("提示词库写入可读", prompts.prompts.some((p: any) => p.title === "冒烟提示词"));
await action("addAsset", {
  projectId: pid, kind: "text", title: "冒烟资产", content: "资产正文", prompt: "",
});
const assets = await action<any>("listAssets", { projectId: pid });
check(
  "资产库写入可读（上传不自动登记，与源版 uploadMedia 口径一致）",
  assets.assets.some((a: any) => a.title === "冒烟资产") && assets.assets.length === 1,
  `assets=${assets.assets.length}`,
);

// ---------------------------------------------------------------- 生成入队 → 队列认领
await action("enqueueGeneration", { projectId: pid, nodeId: I });
const queuedProj = await action<any>("getProject", { id: pid });
check(
  "enqueueGeneration 后节点 queued",
  queuedProj.nodes.find((n: any) => n.id === I)?.genStatus === "queued",
);
const pq = await action<any>("processQueue", {});
check("processQueue 认领 1 个", pq.processed === 1, JSON.stringify(pq));
const workingProj = await action<any>("getProject", { id: pid });
const iNode = workingProj.nodes.find((n: any) => n.id === I);
check(
  "认领后节点 working（等待桥）",
  iNode?.genStatus === "working",
  `genStatus=${iNode?.genStatus}`,
);

// 直出图与配置文本：同步入口在本地同样转等待
const genImg = await action<any>("generateImage", { projectId: pid, nodeId: I2 });
check("generateImage 直出比例本地回 working", genImg.status === "working", JSON.stringify(genImg));
const genCfg = await action<any>("runConfigNode", { projectId: pid, nodeId: C });
check("runConfigNode 文本模式本地回 working", genCfg.status === "working", JSON.stringify(genCfg));

// ---------------------------------------------------------------- 桥：配对后全流程
writeFileSync(
  resolve(import.meta.dir, "../data/bridge.json"),
  JSON.stringify({ token: TOKEN }),
);
const noToken = await bridge("/bridge/pending", { token: null });
check("桥无令牌回 401", noToken.status === 401);
const pending = await bridge("/bridge/pending");
check("pending 拉到 3 条任务", pending.body.jobs?.length === 3, `jobs=${pending.body.jobs?.length}`);
const jobs: any[] = pending.body.jobs ?? [];
const taskJob = jobs.find((j) => j.kind === "task-image");
const directJob = jobs.find((j) => j.kind === "direct-image");
const textJob = jobs.find((j) => j.kind === "text");
check(
  "三类任务齐全（task-image / direct-image / text）",
  !!taskJob && !!directJob && !!textJob,
  jobs.map((j) => j.kind).join(","),
);
check(
  "task-image 任务带完整派发全文与 nodeId",
  taskJob?.nodeId === I && String(taskJob?.payload?.message ?? "").includes("completeImageGeneration"),
);
check(
  "direct-image 任务带组装提示词与方向",
  String(directJob?.payload?.prompt ?? "").includes("海边的灯塔") &&
    directJob?.payload?.orientation === "landscape",
);

const claim1 = await bridge("/bridge/ack-claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: taskJob.jobId }),
});
const claim2 = await bridge("/bridge/ack-claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: taskJob.jobId }),
});
check(
  "ack-claim 认领且幂等",
  claim1.body.status === "claimed" && claim2.body.status === "claimed",
);

// 参考文件经桥取走
const relFile = String(pngUp.filePath).split("/yoyo-canvas-projects/")[1];
const fileRes = await fetch(`${BASE}/bridge/files/${encodeURIComponent(relFile!)}`, {
  headers: { "x-bridge-token": TOKEN },
});
check("bridge/files 可取回项目文件", fileRes.status === 200 && (await fileRes.arrayBuffer()).byteLength === fixtureBytes("still.png").byteLength);

// 媒体结果落地 + 重复投递幂等
const resultBytes = fixtureBytes("result.png");
const res1 = await fetch(`${BASE}/bridge/result`, {
  method: "POST",
  headers: {
    "x-bridge-token": TOKEN,
    "x-job-id": taskJob.jobId,
    "x-file-name": "bridge-result.png",
    "x-title": encodeURIComponent("生图 · 生成图"),
    "content-type": "application/octet-stream",
  },
  body: resultBytes,
});
const res1Body = (await res1.json()) as any;
check("bridge/result 媒体落地 done", res1.status === 200 && res1Body.status === "done", JSON.stringify(res1Body));
const res2 = await fetch(`${BASE}/bridge/result`, {
  method: "POST",
  headers: {
    "x-bridge-token": TOKEN,
    "x-job-id": taskJob.jobId,
    "x-file-name": "bridge-result.png",
    "content-type": "application/octet-stream",
  },
  body: resultBytes,
});
const res2Body = (await res2.json()) as any;
check("bridge/result 重复投递幂等", res2Body.duplicate === true && res2Body.status === "done");
const landedProj = await action<any>("getProject", { id: pid });
const landed = landedProj.nodes.find((n: any) => n.id === I);
check(
  "落地节点 done 且 genSize 为实测 320x240",
  landed?.genStatus === "done" && landed?.genSize === "320x240",
  `genStatus=${landed?.genStatus} genSize=${landed?.genSize}`,
);
check(
  "落地文件在项目目录内",
  !!landed?.filePath && landed.filePath.startsWith(project.workspaceDir) && existsSync(landed.filePath),
  String(landed?.filePath),
);

// 文本结果落地
const textRes = await bridge("/bridge/result", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: textJob.jobId, text: "晚安，月亮，晚安，猫。" }),
});
check("bridge/result 文本落地 done", textRes.body.status === "done", JSON.stringify(textRes.body));
const afterText = await action<any>("getProject", { id: pid });
const textNode = afterText.nodes.find(
  (n: any) => n.type === "text" && n.content === "晚安，月亮，晚安，猫。",
);
check("文本结果节点已生成", !!textNode, textNode?.title ?? "");

// 失败回送
const failRes = await bridge("/bridge/fail", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: directJob.jobId, error: "云端测试失败（冒烟）" }),
});
check("bridge/fail 结算 failed", failRes.body.status === "failed");
const afterFail = await action<any>("getProject", { id: pid });
const i2Node = afterFail.nodes.find((n: any) => n.id === I2);
check(
  "失败落到节点（genStatus=failed + 人话错误）",
  i2Node?.genStatus === "failed" && String(i2Node?.genError ?? "").includes("云端测试失败"),
  `genError=${i2Node?.genError}`,
);

// ---------------------------------------------------------------- 视频 auto 组装（新选 auto）
// Wei 2026-11-22 定版：本地 auto 即 16:9。V 节点 genRatio 存的就是
// "auto"（等同用户选了「自动」），组装出的桥任务报文必须按 16:9
// 带确切像素串——1280x720 来自 ratios.ts computeVideoSize 的 720p
// 短边口径（720 * 16/9 = 1280），不是另设的数值。
await action("enqueueGeneration", { projectId: pid, nodeId: V });
const pqV = await action<any>("processQueue", {});
check("processQueue 认领 auto 视频节点 1 个", pqV.processed === 1, JSON.stringify(pqV));
const pendingV = await bridge("/bridge/pending");
const vJob = (pendingV.body.jobs ?? []).find((j: any) => j.nodeId === V);
check(
  "auto 视频任务入桥队列（task-video）",
  !!vJob && vJob.kind === "task-video",
  (pendingV.body.jobs ?? []).map((j: any) => j.kind).join(","),
);
check(
  "auto 报文按 16:9 组装且带确切像素串 1280x720",
  String(vJob?.payload?.message ?? "").includes("画幅比例：16:9，确切像素尺寸：1280x720") &&
    vJob?.payload?.parsed?.ratio === "16:9",
  `parsed.ratio=${vJob?.payload?.parsed?.ratio}`,
);
const vFail = await bridge("/bridge/fail", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: vJob.jobId, error: "冒烟结算（auto 视频）" }),
});
check("auto 视频任务可经 fail 结算", vFail.body.status === "failed");

// ---------------------------------------------------------------- 工具节点本地执行（抽帧）
const toolRes = await action<any>("runToolNode", {
  projectId: pid,
  nodeId: F,
  options: { framesAction: "first" },
});
check("runToolNode 抽帧本地 done", toolRes.status === "done", JSON.stringify(toolRes));
const afterTool = await action<any>("getProject", { id: pid });
const frameNode = afterTool.nodes.find(
  (n: any) => n.type === "image" && String(n.title).includes("首帧"),
);
check(
  "抽帧产物节点生成且实测 160x120",
  !!frameNode && frameNode.genSize === "160x120",
  frameNode ? `${frameNode.title} ${frameNode.genSize}` : "未找到",
);

const assetsAfter = await action<any>("listAssets", { projectId: pid });
check(
  "生成/工具落地后资产库含生成图与首帧",
  assetsAfter.assets.length >= 3,
  `assets=${assetsAfter.assets.length}: ${assetsAfter.assets.map((a: any) => a.title).join(" | ")}`,
);

// ---------------------------------------------------------------- 项目包导出 → 导入
const exported = await action<any>("exportProjectPackage", { projectId: pid });
check(
  "exportProjectPackage 成功且无缺失",
  exported.sizeBytes > 0 && exported.missing.length === 0,
  `size=${exported.sizeBytes} media=${exported.mediaCount} missing=${exported.missing.length}`,
);
const zipRes = await fetch(`${BASE}${exported.url}`);
const zipB64 = Buffer.from(await zipRes.arrayBuffer()).toString("base64");
check("包文件可下载", zipRes.status === 200 && zipB64.length > 100);
const imported = await action<any>("importProjectPackage", {
  fileName: exported.fileName,
  dataBase64: zipB64,
});
const srcCount = (await action<any>("getProject", { id: pid })).nodes.length;
check(
  "importProjectPackage 节点数一致且无媒体缺失",
  imported.nodeCount === srcCount && imported.mediaMissing.length === 0,
  `imported=${imported.nodeCount} source=${srcCount} missing=${imported.mediaMissing.length}`,
);
const importedProj = await action<any>("getProject", { id: imported.projectId });
const importedMedia = importedProj.nodes.find((n: any) => n.id !== undefined && n.filePath);
check(
  "导入项目媒体指向新项目目录",
  !!importedMedia && String(importedMedia.filePath).startsWith(importedProj.project.workspaceDir),
  String(importedMedia?.filePath),
);

// ---------------------------------------------------------------- 存量 auto（导入带入）同路径组装
// 导入项目里的 V 副本就是存量节点：genRatio="auto" 由项目包带入、
// 从未在本地 UI 选过。它与新选 auto 走同一条归一路径，报文断言同上。
const importedV = importedProj.nodes.find(
  (n: any) => n.type === "video" && n.genRatio === "auto",
);
check(
  "导入项目含存量 auto 视频节点（genRatio 原样带入）",
  !!importedV,
  importedV ? `${importedV.title} genRatio=${importedV.genRatio}` : "未找到",
);
await action("enqueueGeneration", { projectId: imported.projectId, nodeId: importedV.id });
const pqIV = await action<any>("processQueue", {});
check("processQueue 认领存量 auto 节点 1 个", pqIV.processed === 1, JSON.stringify(pqIV));
const pendingIV = await bridge("/bridge/pending");
const ivJob = (pendingIV.body.jobs ?? []).find((j: any) => j.nodeId === importedV.id);
check(
  "存量 auto 报文同样按 16:9 带确切像素串 1280x720",
  !!ivJob &&
    ivJob.kind === "task-video" &&
    String(ivJob.payload?.message ?? "").includes("画幅比例：16:9，确切像素尺寸：1280x720"),
  `kind=${ivJob?.kind}`,
);
const ivFail = await bridge("/bridge/fail", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: ivJob.jobId, error: "冒烟结算（存量 auto）" }),
});
check("存量 auto 任务可经 fail 结算", ivFail.body.status === "failed");

// ---------------------------------------------------------------- 多账号档案与手动切换
// Wei 2026-11-22 08:40 定版：本地存多套桥档案，手动选当前，只有
// 当前档案的桥能领新任务；切换时在途任务的原桥仍可回送结果。
// 此刻 bridge.json 已被服务端从旧格式 { token } 迁移为档案格式：
// TOKEN 即 1 号档案（主账号、当前）。下面用管理页新增档案 B 模拟
// 第二个账号的桥（桥侧零改动，非当前桥的空转是其既有行为）。
async function adminPost(
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text() };
}
async function adminGet(): Promise<string> {
  const res = await fetch(`${BASE}/bridge-admin`);
  return res.text();
}
function profileIdByLabel(html: string, label: string): string | null {
  for (const chunk of html.split('<tr data-profile-id="').slice(1)) {
    if (chunk.includes(label)) return chunk.split('"')[0] ?? null;
  }
  return null;
}

const adminPage1 = await adminGet();
check(
  "管理页列出迁移后的主账号档案（掩码 + 当前标记）",
  adminPage1.includes("主账号") && adminPage1.includes("smok••••oken") && adminPage1.includes("当前账号"),
);
const profileAId = profileIdByLabel(adminPage1, "主账号");
check("管理页可解析主账号档案 id", !!profileAId);

const createdB = await adminPost("/bridge-admin/add", { label: "备用账号" });
const tokenB = createdB.text.match(/[0-9a-f]{48}/)?.[0] ?? "";
check(
  "新增档案 B 后令牌全文只在生成页出现一次",
  createdB.status === 200 && createdB.text.includes("只显示这一次") && tokenB.length === 48,
);
const adminPage2 = await adminGet();
const profileBId = profileIdByLabel(adminPage2, "备用账号");
check(
  "管理页列出档案 B 且只显示掩码",
  !!profileBId && adminPage2.includes(tokenB.slice(0, 4)) && !adminPage2.includes(tokenB),
);

// B 非当前：拉不到任务、认领被拒（inactive），桥侧据此安静空转
const bPending = await bridge("/bridge/pending", { token: tokenB });
check(
  "非当前档案 B 拉 pending 得空列表 + inactive",
  bPending.status === 200 && bPending.body.inactive === true && bPending.body.jobs?.length === 0,
  JSON.stringify(bPending.body),
);
const bClaim = await bridge("/bridge/ack-claim", {
  method: "POST",
  token: tokenB,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: "whatever" }),
});
check("非当前档案 B ack-claim 回 inactive 不认领", bClaim.body.status === "inactive");

// A（当前）正常领一单并认领在途
const genA = await action<any>("generateImage", { projectId: pid, nodeId: I2 });
check("切换前 A 侧 generateImage 回 working", genA.status === "working");
const aPending = await bridge("/bridge/pending");
const jobA = (aPending.body.jobs ?? []).find((j: any) => j.nodeId === I2);
check("当前档案 A 拉到新任务", !!jobA && jobA.kind === "direct-image", jobA?.kind ?? "无");
const aClaim = await bridge("/bridge/ack-claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: jobA.jobId }),
});
check("当前档案 A ack-claim 认领成功", aClaim.body.status === "claimed");

// 切到 B：A 立刻失去领活资格，但 A 在途那单的结果仍可回送落地
await adminPost("/bridge-admin/activate", { id: profileBId! });
const aPendingAfter = await bridge("/bridge/pending");
check(
  "切换后 A 拉 pending 得空 + inactive",
  aPendingAfter.body.inactive === true && aPendingAfter.body.jobs?.length === 0,
);
const aResult = await fetch(`${BASE}/bridge/result`, {
  method: "POST",
  headers: {
    "x-bridge-token": TOKEN,
    "x-job-id": jobA.jobId,
    "x-file-name": "bridge-result-a.png",
    "content-type": "application/octet-stream",
  },
  body: resultBytes,
});
const aResultBody = (await aResult.json()) as any;
check(
  "切换后原桥 A 仍可回送在途结果并落地",
  aResult.status === 200 && aResultBody.status === "done",
  JSON.stringify(aResultBody),
);
const afterSwitchProj = await action<any>("getProject", { id: pid });
check(
  "在途结果落地到节点（genStatus=done）",
  afterSwitchProj.nodes.find((n: any) => n.id === I2)?.genStatus === "done",
);

// B 现在是当前：能领下一单
const genB = await action<any>("generateImage", { projectId: pid, nodeId: I2 });
check("切换后新任务照常入队", genB.status === "working");
const bPending2 = await bridge("/bridge/pending", { token: tokenB });
const jobB = (bPending2.body.jobs ?? []).find((j: any) => j.nodeId === I2);
check("当前档案 B 拉到下一单", !!jobB, (bPending2.body.jobs ?? []).length + " jobs");
const bClaim2 = await bridge("/bridge/ack-claim", {
  method: "POST",
  token: tokenB,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: jobB.jobId }),
});
check("当前档案 B ack-claim 认领成功", bClaim2.body.status === "claimed");
const bFail = await bridge("/bridge/fail", {
  method: "POST",
  token: tokenB,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: jobB.jobId, error: "冒烟结算（档案 B）" }),
});
check("档案 B 可经 fail 结算自己的任务", bFail.body.status === "failed");

// 未知令牌仍 401；管理页记录 B 的最近在线；改备注生效
const unknown = await bridge("/bridge/pending", { token: "no-such-token" });
check("未知令牌回 401", unknown.status === 401);
await adminPost("/bridge-admin/rename", { id: profileBId!, label: "二号账号" });
const adminPage3 = await adminGet();
check(
  "改备注生效且 B 最近在线已记录（非「从未」行）",
  adminPage3.includes("二号账号") &&
    adminPage3.split('<tr data-profile-id="').some(
      (chunk) => chunk.includes("二号账号") && !chunk.slice(0, 2000).includes("从未"),
    ),
);

// 切回 A 并删除 B：B 的令牌随即失效
await adminPost("/bridge-admin/activate", { id: profileAId! });
await adminPost("/bridge-admin/delete", { id: profileBId! });
const bGone = await bridge("/bridge/pending", { token: tokenB });
check("删除档案 B 后其令牌回 401", bGone.status === 401);
const aBack = await bridge("/bridge/pending");
check(
  "切回 A 后 pending 恢复正常（200、无 inactive）",
  aBack.status === 200 && aBack.body.inactive === undefined && Array.isArray(aBack.body.jobs),
);
const onDisk = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../data/bridge.json"), "utf8"),
) as any;
check(
  "bridge.json 已是多档案格式（profiles + activeProfileId）",
  Array.isArray(onDisk.profiles) && onDisk.profiles.length === 1 &&
    onDisk.profiles[0].token === TOKEN && typeof onDisk.activeProfileId === "string",
);

// ---------------------------------------------------------------- 删项目（batch 路径）
await action("deleteProject", { id: imported.projectId });
const afterDelete = await action<any>("listProjects");
check(
  "deleteProject 后列表只剩冒烟项目",
  afterDelete.projects.length === 1 && afterDelete.projects[0].id === pid,
  `projects=${afterDelete.projects.length}`,
);

console.log(`\n冒烟结果：${passed} pass / ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
