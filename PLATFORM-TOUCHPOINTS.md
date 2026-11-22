# 平台触点盘点（yoyohua-bu 源码 → 本地替代）

盘点范围：`client/src`、`server/src`、`server/.generated`、`client/build.mjs`（源工程 2026-11-22 快照）。
「本地替代」一列即本工程（~/workspace/yoyo-local）的落地方式；垫片包 = `packages/local-sdk`
（包名 `@hatch/space-sdk`，只实现源码实际用到的表面）。

## 一、服务端：@hatch/space-sdk 导入

| 触点 | 出现位置 | 本地替代 |
| --- | --- | --- |
| `defineAction` | actions/{projects,graph,assets,prompts,generation,media-edit,package,generation-records}.ts | 垫片实现：返回 `{ __brand, request, response, description, privileged, handler }` 定义对象；本地服务按名分发并做 zod 校验 |
| `z`（zod 转出） | contracts.ts、generation-dispatch.ts、tool-dispatch.ts、privileged.ts、.generated/privileged.contract.ts | 垫片转出 `zod` 的 `z`（同一版本 4.4.3） |
| `type Ctx` | contracts.ts、graph-helpers.ts、generation-dispatch.ts、generation.ts、queue-sweep.ts、tool-dispatch.ts、tests | 垫片类型：与平台 Ctx 同形（db/blobs/executePrivileged/spaceDir/slug/invocationId/agent/inference/tool/emit/invalidateQueries） |
| `type SpaceDb` | contracts.ts（`Db = SpaceDb<typeof schema>`） | 垫片类型映射到 `drizzle-orm/bun-sqlite` 的 BunSQLiteDatabase 同形子集（select/insert/update/delete/run/all/get/batch） |
| `type ActionsModule` | server/src/actions.ts | 垫片类型：动作定义记录表 |
| `definePrivilegedContracts` / `definePrivilegedHandlers` | server/src/privileged.ts | 垫片实现：生成带 name 的契约描述符与 handler 表（形状与平台一致） |
| `createPrivilegedExecutor` | 源码未直接用（平台运行时用） | 垫片提供同名实现，本地 ctx 内部用它装配 executePrivileged |

## 二、服务端：ctx 成员使用（按成员汇总）

| ctx 成员 | 使用量与位置 | 本地替代 |
| --- | --- | --- |
| `ctx.db<typeof schema>()` | 全部 actions（每 handler 一次） | 本地返回 `drizzle-orm/bun-sqlite` 实例（bun:sqlite 打开 `./data/app.db`，启动跑迁移 0001–0014） |
| `ctx.blobs.put` | generation.ts、queue-sweep.ts（海报/代理）、assets.ts、package.ts、media-edit.ts、tool-dispatch.ts、generation-dispatch 经 graph-helpers | 本地 Blob 实现：写 `./data/blobs/objects/<sha256(key)[:2]>/<sha256(key)>` + `.meta.json` |
| `ctx.blobs.getUrl` | contracts.ts `blobUrl()`（toNode 的 mediaUrl/posterUrl/proxyUrl）、package.ts | 返回 `/blobs/<key>`，本地 HTTP 服务按 key 出字节（带 contentType 与缓存头） |
| `ctx.blobs.delete/head/list` | 源码未直接使用（接口面存在） | 本地 Blob 一并实现，保持接口完整 |
| `ctx.executePrivileged(Contracts.*)` | tool-dispatch 11、media-edit 10、package 9、queue-sweep 6、projects 2、assets 2、generation 2、graph-helpers 1 | 本地直调 `server/src/privileged.ts` 的 Handlers（node:fs / child_process 原生实现），入参出参过契约 zod 校验；契约面共 21 个：ensureProjectDir / readMediaFile / writeProjectFile / makePoster / makePlaybackProxy / probeMediaFile / extractFrames / extractAudio / composeVideo / probeStreams / convertImageToPng / shrinkImageForInference / cropImage / splitImage / upscaleImage / mirrorBlobToFile / buildProjectPackage / readPackageFile / deleteStagingFile / extractProjectPackage / importMediaFile |
| `ctx.spaceDir` | package.ts 5、queue-sweep.ts 1、assets.ts 1（作特权入参 spaceDir） | 本地固定为 `./data/` 绝对路径：package 暂存落 `data/exports`、`data/imports`；mirrorBlobToFile 的 blob 根由环境变量 HATCH_SPACE_BLOB_DIR 指到 `data/blobs` |
| `ctx.agent.spawnTask` | generation-dispatch.ts 3 处（图 :82、视频 :270、音频 :327），options 恒为 `{ expectsAction: complete*Generation, dedupeKey: yoyo-*-gen-<nodeId> }` | 本地桥任务表入队：存 message/expectsAction/dedupeKey 与从 message 解析的 nodeId，返回 `{ ok:true, taskId: jobId, agentId:"local-bridge", messageId: jobId }`；同 dedupeKey 未结任务单飞返回旧 jobId |
| `ctx.tool.generate_media` | generation-dispatch.ts :190（直出图，仅 16:9/9:16/1:1 且无参考媒体时），签名 `(prompt, { orientation }) → { blobKey, url, contentType, bytes }`；ctx.tool 其余成员源码未用 | 本地抛 `BridgeQueuedError`（载荷：prompt + orientation）；调用点定点捕获后落桥任务（kind=direct-image）并把节点置 working 等待 |
| `ctx.inference.complete` | generation-dispatch.ts :365（配置节点文本模式）、tool-dispatch.ts :453（提示词逆推，带 images） | 本地抛 `BridgeQueuedError`（载荷：prompt/system/图片引用）；调用点定点捕获后落桥任务（kind=text / prompt-reverse）并把节点置 working 等待 |
| `ctx.invalidateQueries` | generation.ts 12、media-edit 5、assets 5、projects 4、prompts 2、package 1 | 本地 no-op（单机单客户端；客户端自身 mutation 失效 + use-generation 的 processQueue 轮询覆盖刷新）。留待决：阶段 6 实测确认 |
| `ctx.emit` / `ctx.viewer` / `ctx.slug` / `ctx.invocationId` | 源码未使用（slug/invocationId 仅类型面） | 垫片与本地 ctx 提供同形占位（slug="yoyo-local"，invocationId 每调用生成） |

## 三、客户端：@hatch/space-sdk/client 导入

| 触点 | 出现位置 | 本地替代 |
| --- | --- | --- |
| `createActionClient` + `ApiRequest`/`ApiResponse` 类型 | client/src/api.ts | **api.ts 按工单重写**为普通 fetch 客户端：`POST /actions { action, args }` 的 Proxy 实现，类型仍从 `../../server/src/actions` 的 Actions 推导，ApiRequest/ApiResponse 在 api.ts 内同形定义 |
| `spaceQueryClient` | client/src/main.tsx | 垫片 `./client` 导出一个 `@tanstack/react-query` 的 QueryClient（默认配置对齐：查询不自动重试失败多次、窗口聚焦刷新保持库默认） |
| `fileToBase64(file) → { dataBase64, mimeType }` | App.tsx、components/AssetsTab.tsx、hooks/use-package-io.ts、hooks/use-generation.ts | 垫片 `./client` 实现：FileReader/arrayBuffer → base64（浏览器原生），返回形状不变 |

## 四、构建与生成物

| 触点 | 位置 | 本地替代 |
| --- | --- | --- |
| `@hatch/space-sdk/build` 的 `buildClient()`（Bun.build + bun-plugin-tailwind，入口 client/index.html → client/dist） | client/build.mjs | 本地 `client/build-local.mjs`：同一 Bun.build 配置（entrypoints/outdir/minify/naming/tailwind 插件/NODE_ENV=production define），去掉平台发布守卫；`__HATCH_SPACE_PLATFORM_VERSION__` define 给 0（客户端源码未引用该常量，仅 globals.d.ts 的 css/png 模块声明被用到） |
| `@space/privileged` 别名 → `server/.generated/privileged.contract.ts`（构建期由 privileged.ts 抽取生成） | server/tsconfig.json、client/tsconfig.json paths；actions 多处 import { Contracts } | 本地 tsconfig paths 改指 `server/src/privileged.ts` 本体（本地无抽取步骤；privileged.ts 的 Contracts 与 Handlers 同文件导出，actions 只取 Contracts，运行时由本地 ctx 装配 Handlers，二者同源不漂移） |
| `server/.generated/privileged.contract.ts` 本体 | 随拷贝保留 | 本地不再被引用（保留作对照，README 注明） |
| 平台迁移执行（drizzle/*.sql 由宿主按序应用） | drizzle/0001–0014 | 本地启动时自跑：`local/db.ts` 按文件名序执行未记录的迁移并登记 `_local_migrations` |
| `process.env.HOME` 推导（actions/project-dirs.ts homeDir） | project-dirs.ts | 本地定点改道（见 PLATFORM 适配清单 A3） |

## 五、源码定点适配清单（本地版与源版的全部差异面，逐处带 `[yoyo-local]` 标记）

| # | 文件 | 适配 |
| --- | --- | --- |
| A1 | client/src/api.ts | 整体重写为 fetch 客户端（工单指定） |
| A2 | client/build.mjs → 新增 client/build-local.mjs | 本地构建脚本（原 build.mjs 保留不改，本地不用它） |
| A3 | server/src/actions/project-dirs.ts | homeDir/projectWorkspaceDir/expandHome 改由本地根推导（`local/` 注入的环境变量 YOYO_LOCAL_ROOT，缺省按可执行文件旁 data/ 推导） |
| A4 | server/src/privileged/files.ts | WORKSPACE_ROOT/PROJECTS_ROOT 改由同一本地根推导 |
| A5 | server/src/privileged/media-common.ts | FFMPEG_BIN/FFPROBE_BIN 允许 FFMPEG_PATH/FFPROBE_PATH 环境变量覆盖（Windows 随包 runtime 用） |
| A6 | server/src/actions/generation-dispatch.ts | generateImageInAction、dispatchConfigText 各加一处 BridgeQueuedError 捕获 → 落桥任务 + 节点 working |
| A7 | server/src/actions/tool-dispatch.ts | runPromptReverseTool 的 inference 捕获处加 BridgeQueuedError 分支 → 落桥任务 + 返回 working |
| A8 | server/tsconfig.json / client/tsconfig.json | paths 中 `@space/privileged` 改指 `server/src/privileged.ts` |
| A9 | package.json | 依赖 `@hatch/space-sdk` 改指 `file:./packages/local-sdk`；scripts 增加 local:start / local:build-client / test 保持 |
| A10 | 新增 local/、packages/local-sdk/、scripts/migrate-package.ts、start.sh、start.bat、README.md | 本地运行时与垫片（新增文件，不改源文件） |

除以上清单外，client 组件、hooks 与 server 业务文件与源版逐字一致。
