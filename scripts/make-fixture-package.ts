// [yoyo-local] 生成迁移演练用的 fixture 项目包：格式与云端 Space 的
// exportProjectPackage 产物逐字一致（同一套代码产出），项目名与内容
// 模拟一个云端存量项目（2 媒体节点 + 1 文本节点 + 1 边）。
// 用法：bun scripts/make-fixture-package.ts [输出路径]
// 在临时数据根里自举本地运行时，不碰真实 data/。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const tmpRoot = resolve(appRoot, ".fixture-tmp");
process.env.YOYO_LOCAL_ROOT = resolve(tmpRoot, "data");
process.env.HATCH_SPACE_BLOB_DIR = resolve(tmpRoot, "data", "blobs");

const { openDb } = await import("../local/db");
const { createCtx } = await import("../local/ctx");
const { readBlobBytes } = await import("../local/blobs");
const { Actions } = await import("../server/src/actions");

const { db } = openDb();
const ctx = createCtx(db);
const call = async (name: string, args: unknown = {}): Promise<any> => {
  const def = (Actions as Record<string, any>)[name];
  return def.handler(ctx, def.request.parse(args));
};

const fixtureB64 = (name: string) =>
  readFileSync(resolve(import.meta.dir, "fixtures", name)).toString("base64");

const project = await call("createProject", { name: "云端样例项目" });
const pid = project.id as string;
const img = await call("uploadMedia", {
  projectId: pid, kind: "image", fileName: "样例图.png", mimeType: "image/png",
  dataBase64: fixtureB64("still.png"), x: 0, y: 0, width: 320, height: 240,
});
const vid = await call("uploadMedia", {
  projectId: pid, kind: "video", fileName: "样例片.mp4", mimeType: "video/mp4",
  dataBase64: fixtureB64("clip.mp4"), x: 400, y: 0, width: 420, height: 300,
});
const textId = crypto.randomUUID();
await call("saveGraph", {
  projectId: pid,
  viewport: { x: 10, y: 20, zoom: 1.25 },
  nodes: [
    {
      id: textId, type: "text", title: "说明", x: 0, y: 400, width: 320, height: 120,
      content: "这是云端样例项目的说明文本", prompt: "", status: "idle",
      hidden: false, groupId: null, color: null, freeResize: false,
      fontSize: null, genRatio: null, genDuration: null, genMode: null, seq: null,
    },
    ...[img.node, vid.node].map((n: any) => ({
      id: n.id, type: n.type, title: n.title, x: n.x, y: n.y,
      width: n.width, height: n.height, content: n.content ?? "",
      prompt: n.prompt ?? "", status: n.status ?? "idle",
      hidden: n.hidden ?? false, groupId: n.groupId ?? null,
      color: n.color ?? null, freeResize: n.freeResize ?? false,
      fontSize: n.fontSize ?? null, genRatio: n.genRatio ?? null,
      genDuration: n.genDuration ?? null, genMode: n.genMode ?? null,
      seq: n.seq ?? null,
    })),
  ],
  edges: [{ id: crypto.randomUUID(), fromNodeId: textId, toNodeId: img.node.id }],
});

const exported = await call("exportProjectPackage", { projectId: pid });
if (exported.missing.length > 0) {
  throw new Error(`fixture 导出有缺失：${exported.missing.join(", ")}`);
}
const key = exported.url.replace(/^\/blobs\//, "").split("/").map(decodeURIComponent).join("/");
const found = readBlobBytes(key);
if (!found) throw new Error("fixture 包字节读取失败");
const outPath =
  process.argv[2] ?? resolve(import.meta.dir, "fixtures", "cloud-export.yoyo-canvas.zip");
mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, found.bytes);
console.log(`fixture 项目包已生成：${outPath}（${found.bytes.byteLength} bytes，媒体 ${exported.mediaCount} 个）`);
