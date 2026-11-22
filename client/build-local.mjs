// [yoyo-local] 本地客户端构建：复刻平台 SDK buildClient 的 Bun.build
// 配置（入口 client/index.html → client/dist、production、minify、
// assets/[name]-[hash] 命名、bun-plugin-tailwind），去掉平台发布守卫。
// 资产 URL 的 ./assets/ 重前缀处理与 SDK 同口径（见其注释）。

import { cp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";
const PDFJS_ASSET_ROOT = "./assets/pdfjs/";

if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
  throw new Error("build-local.mjs must run under Bun");
}

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __HATCH_SPACE_PLATFORM_VERSION__: JSON.stringify(0),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("build-local failed; see logged diagnostics");
}

const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));

let needsPdfjsAssets = false;
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  needsPdfjsAssets ||= text.includes(PDFJS_ASSET_ROOT);
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}

if (needsPdfjsAssets) {
  const sdkPdfjs = join(
    import.meta.dir,
    "../node_modules/@hatch/space-sdk/pdfjs-assets",
  );
  try {
    await cp(sdkPdfjs, join(OUTDIR, "assets", "pdfjs"), { recursive: true });
  } catch {
    console.warn("pdfjs assets not found in local SDK shim; skipped");
  }
}

console.log(`client built → ${OUTDIR}`);
