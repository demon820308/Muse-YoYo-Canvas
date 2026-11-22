// [yoyo-local] 本地运行时配置：全部路径单点推导（规范「环境靠推导」）。
//
// 数据根 YOYO_LOCAL_ROOT 由 local/server.ts 在导入任何业务模块前注入
// （缺省 <工程根>/data）；server 侧的定点适配（project-dirs.ts、
// privileged/files.ts）读同一环境变量，保证两边根一致。

import { resolve } from "node:path";

export const APP_ROOT = resolve(import.meta.dir, "..");
export const DATA_DIR = resolve(
  process.env.YOYO_LOCAL_ROOT ?? resolve(APP_ROOT, "data"),
);
export const DB_PATH = resolve(DATA_DIR, "app.db");
export const BLOBS_DIR = resolve(DATA_DIR, "blobs");
export const PROJECTS_DIR = resolve(DATA_DIR, "yoyo-canvas-projects");
export const DRIZZLE_DIR = resolve(APP_ROOT, "drizzle");
export const CLIENT_DIST = resolve(APP_ROOT, "client", "dist");
export const PORT = Number(process.env.YOYO_LOCAL_PORT ?? 3737);
export const HOST = process.env.YOYO_LOCAL_HOST ?? "127.0.0.1";

// 桥令牌（多账号档案）不在这里解析：见 local/bridge-profiles.ts
// （data/bridge.json 的 profiles 档案 + activeProfileId，环境变量
// YOYO_BRIDGE_TOKEN 为临时单档案）。
