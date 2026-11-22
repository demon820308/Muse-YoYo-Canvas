// [yoyo-local] 本地后端 HTTP 服务（Bun.serve，端口 3737）：
//   POST /actions     画布动作分发：{ action, args } → 动作返回值；
//                     请求/响应过动作自带 zod schema，与云端口径一致
//   GET  /blobs/*     本地 blob 字节（ctx.blobs.getUrl 的落地）
//   *    /bridge/*    本地桥端点（local/bridge.ts，令牌鉴权）
//   GET  /bridge-admin 桥账号管理页（local/bridge-admin.ts，多账号切换）
//   GET  /*           前端静态文件（client/dist，SPA 回退 index.html）
// 本模块只由 local/server.ts 在注入环境变量后动态导入。

import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { ActionDefinition, Ctx } from "@hatch/space-sdk";
import { Actions } from "../server/src/actions";
import { ensureBridgeJobsTable } from "../server/src/actions/bridge-jobs";
import type { Db } from "../server/src/actions/contracts";
import { readBlobBytes } from "./blobs";
import { handleBridge } from "./bridge";
import { handleBridgeAdmin } from "./bridge-admin";
import { CLIENT_DIST, HOST, PORT } from "./config";
import { createCtx } from "./ctx";
import { openDb } from "./db";

const { db } = openDb();
await ensureBridgeJobsTable(db as unknown as Db);
const ctx: Ctx = createCtx(db);

const actionByName = Actions as unknown as Record<
  string,
  ActionDefinition | undefined
>;

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function errorMessage(err: unknown, action?: string): string {
  if (err && typeof err === "object" && "issues" in err) {
    const issues = (err as { issues: { message: string; path: PropertyKey[] }[] }).issues;
    const first = issues[0];
    if (first) {
      const at = first.path.length ? `（${first.path.join(".")}）` : "";
      return `参数不合要求${at}：${first.message}`;
    }
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (/^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EBUSY|SQLITE_)\b/.test(raw)) {
    return action ? `操作「${action}」读写本地文件或数据库失败，请查看服务端日志` : "本地读写失败，请查看服务端日志";
  }
  return raw;
}

async function handleAction(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { action?: string; args?: unknown }
    | null;
  if (!body?.action) {
    return Response.json({ error: "请求缺少 action" }, { status: 400 });
  }
  const def = actionByName[body.action];
  if (!def) {
    return Response.json({ error: `未知动作：${body.action}` }, { status: 404 });
  }
  try {
    const args = def.request.parse(body.args ?? {});
    const result = await def.handler(ctx, args as never);
    return Response.json(def.response.parse(result));
  } catch (err) {
    const isValidation =
      err && typeof err === "object" && "issues" in err;
    console.error(`[actions] ${body.action} 失败：`, err);
    return Response.json(
      { error: errorMessage(err, body.action) },
      { status: isValidation ? 400 : 500 },
    );
  }
}

function serveStatic(pathname: string): Response {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = resolve(CLIENT_DIST, rel);
  if (full !== CLIENT_DIST && !full.startsWith(CLIENT_DIST + sep)) {
    return new Response("forbidden", { status: 403 });
  }
  const target = existsSync(full) && statSync(full).isFile()
    ? full
    : resolve(CLIENT_DIST, "index.html");
  if (!existsSync(target)) {
    return new Response(
      "前端尚未构建：先运行 bun run build:client（或用 bun run local:dev 启动）",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(Bun.file(target), {
    headers: {
      "content-type":
        STATIC_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, app: "yoyo-local" });
    }
    if (url.pathname.startsWith("/bridge/")) {
      return handleBridge(req, url, { db, ctx });
    }
    if (
      url.pathname === "/bridge-admin" ||
      url.pathname.startsWith("/bridge-admin/")
    ) {
      return handleBridgeAdmin(req, url, { db });
    }
    if (url.pathname === "/actions" && req.method === "POST") {
      return handleAction(req);
    }
    if (url.pathname.startsWith("/blobs/") && req.method === "GET") {
      const key = url.pathname
        .slice("/blobs/".length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const found = readBlobBytes(key);
      if (!found) return new Response("blob not found", { status: 404 });
      return new Response(found.bytes, {
        headers: {
          "content-type": found.contentType,
          "content-length": String(found.bytes.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (req.method === "GET") return serveStatic(url.pathname);
    return new Response("not found", { status: 404 });
  },
});

console.log(`YoYo画布本地版已启动：http://${HOST}:${server.port}`);
console.log(`数据目录：${process.env.YOYO_LOCAL_ROOT}`);
