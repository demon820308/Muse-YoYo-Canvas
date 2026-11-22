// [yoyo-local] 启动引导：先注入路径环境变量，再动态导入服务本体。
// 顺序是硬要求——server/src/privileged/files.ts 与 actions/project-dirs.ts
// 在模块求值时按 YOYO_LOCAL_ROOT 推导根目录，环境变量必须先于它们的导入。

import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
process.env.YOYO_LOCAL_ROOT ??= resolve(appRoot, "data");
process.env.HATCH_SPACE_BLOB_DIR ??= resolve(
  process.env.YOYO_LOCAL_ROOT,
  "blobs",
);

// 保证本机回环地址不走系统代理，避免子进程或本地请求被 VPN/代理劫持。
for (const key of ["NO_PROXY", "no_proxy"] as const) {
  const cur = process.env[key] ?? "";
  const missing = ["127.0.0.1", "localhost", "::1"].filter(
    (h) => !cur.split(",").map((s) => s.trim()).includes(h),
  );
  if (missing.length) {
    process.env[key] = cur ? `${cur},${missing.join(",")}` : missing.join(",");
  }
}

await import("./app");
