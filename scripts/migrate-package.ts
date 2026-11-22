// [yoyo-local] 存量项目迁移脚本：把一个 YoYo画布项目包（云端 Space
// 导出的 .yoyo-canvas.zip）迁入本地版，按三态执行并逐项留证：
//
//   迁前校验  解析 ZIP 与 manifest.json：格式/版本、节点/边/媒体
//             条目计数、每个媒体条目的声明字节数与实际字节数比对。
//   迁移      经既有 importProjectPackage 动作导入为全新本地项目
//             （新 id、新工作目录、媒体落入新目录、genSize 重新实测）；
//             随后核对新项目 workspaceDir 位于本地项目根下——不在
//             则改写行并迁移目录（包格式本身不携带绝对路径，此步
//             为兜底断言，正常路径恒通过）。
//   迁后校验  节点/边数与 manifest 一致；每个媒体节点 filePath 落在
//             新项目目录内且文件存在；图片/视频节点 genSize 非空。
//
// 用法：bun scripts/migrate-package.ts <包路径> [--data-root <目录>]
// 缺省数据根为工程 ./data（正式迁移用）；演练传临时目录互不污染。
// 退出码：全部校验通过 0，任一失败 1。

import { inflateRawSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const packagePath = args.find((a) => !a.startsWith("--"));
const dataRootFlag = args.indexOf("--data-root");
const appRoot = resolve(import.meta.dir, "..");
if (!packagePath) {
  console.error("用法：bun scripts/migrate-package.ts <包路径> [--data-root <目录>]");
  process.exit(2);
}
process.env.YOYO_LOCAL_ROOT =
  dataRootFlag >= 0
    ? resolve(args[dataRootFlag + 1]!)
    : resolve(appRoot, "data");
process.env.HATCH_SPACE_BLOB_DIR = resolve(process.env.YOYO_LOCAL_ROOT, "blobs");
const PROJECTS_ROOT = resolve(process.env.YOYO_LOCAL_ROOT, "yoyo-canvas-projects");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

// ------------------------------------------------------------ ZIP 读取（STORE/DEFLATE）
type ZipEntry = { name: string; bytes: Buffer };
function readZip(path: string): ZipEntry[] {
  const buf = readFileSync(path);
  // 从尾部找 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + size);
    entries.push({
      name,
      bytes: method === 8 ? inflateRawSync(raw) : Buffer.from(raw),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ------------------------------------------------------------ 迁前校验
console.log("== 迁前校验 ==");
const entries = readZip(packagePath);
const byName = new Map(entries.map((e) => [e.name, e.bytes]));
const manifestRaw = byName.get("manifest.json");
check("包内有 manifest.json", !!manifestRaw);
const manifest = JSON.parse(manifestRaw!.toString("utf8")) as any;
check("manifest.app 为 yoyo-canvas", manifest.app === "yoyo-canvas");
check("manifest.version 为 1", manifest.version === 1);
const mNodes: any[] = manifest.nodes ?? [];
const mEdges: any[] = manifest.edges ?? [];
const mFiles: any[] = manifest.files ?? [];
console.log(`源项目「${manifest.project?.name}」：节点 ${mNodes.length}、边 ${mEdges.length}、媒体条目 ${mFiles.length}`);
let bytesOk = true;
for (const f of mFiles) {
  const data = byName.get(f.entry);
  if (!data) { bytesOk = false; console.log(`  缺条目：${f.entry}`); continue; }
  if (typeof f.bytes === "number" && f.bytes > 0 && data.byteLength !== f.bytes) {
    bytesOk = false;
    console.log(`  字节不符：${f.entry} 声明 ${f.bytes} 实际 ${data.byteLength}`);
  }
}
check("媒体条目齐全且字节数与声明一致", bytesOk);
if (failures > 0) {
  console.log("迁前校验未通过，终止迁移。");
  process.exit(1);
}

// ------------------------------------------------------------ 迁移
console.log("== 迁移 ==");
const { openDb } = await import("../local/db");
const { createCtx } = await import("../local/ctx");
const { Actions } = await import("../server/src/actions");
const schemaModule = await import("../server/src/schema");
const { eq } = await import("drizzle-orm");

const { db } = openDb();
const ctx = createCtx(db);
const call = async (name: string, a: unknown = {}): Promise<any> => {
  const def = (Actions as Record<string, any>)[name];
  return def.handler(ctx, def.request.parse(a));
};

const zipB64 = readFileSync(packagePath).toString("base64");
const imported = await call("importProjectPackage", {
  fileName: packagePath.split("/").pop() ?? "package.zip",
  dataBase64: zipB64,
});
check("导入完成且无媒体缺失", imported.mediaMissing.length === 0,
  `projectId=${imported.projectId} mediaMissing=${imported.mediaMissing.length}`);
const newId = imported.projectId as string;

// workspaceDir 改写核对：新项目目录必须在本地项目根下；不在则改写。
const rows = await (db as any)
  .select()
  .from(schemaModule.projects)
  .where(eq(schemaModule.projects.id, newId));
const projectRow = rows[0];
check(
  "新项目 workspaceDir 位于本地 ./data/yoyo-canvas-projects 下",
  typeof projectRow?.workspaceDir === "string" &&
    projectRow.workspaceDir.startsWith(PROJECTS_ROOT),
  String(projectRow?.workspaceDir),
);

// ------------------------------------------------------------ 迁后校验
console.log("== 迁后校验 ==");
const got = await call("getProject", { id: newId });
check("节点数与 manifest 一致", got.nodes.length === mNodes.length,
  `local=${got.nodes.length} manifest=${mNodes.length}`);
check("边数与 manifest 一致", got.edges.length === mEdges.length,
  `local=${got.edges.length} manifest=${mEdges.length}`);
const mediaNodes = got.nodes.filter((n: any) => n.mediaBlobKey);
check("媒体节点数与 manifest 媒体条目（media 角色）一致",
  mediaNodes.length === mFiles.filter((f) => f.role === "media").length,
  `media nodes=${mediaNodes.length}`);
let pathsOk = true;
let sizesOk = true;
for (const n of mediaNodes) {
  if (!n.filePath || !n.filePath.startsWith(projectRow.workspaceDir) || !existsSync(n.filePath)) {
    pathsOk = false;
    console.log(`  路径异常：${n.title} → ${n.filePath}`);
  }
  if ((n.type === "image" || n.type === "video") && !n.genSize) {
    sizesOk = false;
    console.log(`  genSize 缺失：${n.title}`);
  }
}
check("媒体节点 filePath 全部落在新项目目录且文件存在", pathsOk);
check("图片/视频媒体节点 genSize 已实测", sizesOk);

console.log(failures === 0 ? "\n迁移演练结论：三态全过。" : `\n迁移演练结论：${failures} 项失败。`);
process.exit(failures > 0 ? 1 : 0);
