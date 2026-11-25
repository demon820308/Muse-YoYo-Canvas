# YoYo画布 · 本地版（YoYoCanvas Local）

本地优先的多模态 AI 创作工作流画布，由云端 YoYo画布 Space 源码独立演进而来。界面与交互保持一致，所有项目、媒体资产、生成记录与配置均保存在本地 `./data/` 目录，并支持 **Muse「YoYo桥」**、**本地 AGY 引擎（Nano Banana / 本地推理）** 与 **Gemini 网页版（Pro 会员无头生图）** 三路生成通道按节点自由切换。

---

## 核心特性

- **无限画布与 13 类节点**
  - **内容与生成节点**：文本（`text`）、图片（`image`，8 档比例 `16:9` ~ `21:9`）、视频（`video`，1–30s）、音频（`audio`）、多模式生成配置（`config`，支持生图/文本/视频/音频与提示词组装）。
  - **工具节点**：视频抽帧（`video-frames`，首帧/尾帧/自动与宫格抽帧表）、视频接力（`video-relay`）、提取音频（`audio-extract`）、视频配乐（`video-compose`）、提示词逆推（`prompt-reverse`，5 种模式）、绘制蒙版（`image-mask`，内置蒙版画板与局部编辑）。
  - **组织与辅助**：分组（`group`）、便签（`sticky-note`），以及图像悬浮快捷工具（裁剪、宫格切分、放大、换角度、复制/逆推提示词等）。
- **三路 AI 生成引擎（按节点切换）**
  - **Muse「YoYo桥」**：本地队列 + Cloudflare 隧道 + 云端独立 Space「YoYo桥」，支持多 Muse 账号档案手动切换，在途任务不丢单。
  - **AGY 本地引擎**：一键部署与登录本地 `agy` CLI，支持本地推理、提示词逆推、画布 Agent 与 Nano Banana 生图。
  - **Gemini 网页版**：直接复用本机 Chrome / Edge 与独立档案目录登录 `gemini.google.com`，免 API Key 按需无头串行生图。
- **画布 AI Agent 与 Skills**
  - 支持 Muse Agent、AGY CLI、OpenAI 兼容接口、Anthropic 四类模型配置；支持 `@` 引用画布节点、自动执行增删改连线/触发生成/分组/存提示词等操作。
  - 内置多会话历史管理与 Skills 沉淀（支持从当前画布或对话一键提取 Skill）。
- **本地媒体处理与整包迁移**
  - 集成 `ffmpeg` / `ffprobe`：本地完成抽帧、提音频、配乐合成、裁剪切分、放大、视频海报与播放代理转码，以及成片尺寸实测。
  - 支持 `.yoyo-canvas.zip` 项目整包导出与导入迁移，支持自定义和迁移项目工作目录。

---

## 快速开始

### Windows（推荐，一键启动）

1. 将整个目录放到本机磁盘（如 `D:\yoyo-local`）。
2. 双击 [`start.bat`](file:///g:/YoYo-Local-For-Muse/start.bat)：
   - 优先使用随包 `runtime/` 下的运行时，缺失时自动检测或通过 `winget` 安装 **Bun**、**ffmpeg**、**cloudflared**。
   - 首次运行自动执行 `bun install` 与 `bun run build:client`。
   - 启动本地服务并自动打开浏览器访问 `http://127.0.0.1:3737`。
3. 辅助批处理脚本：
   - [`stop.bat`](file:///g:/YoYo-Local-For-Muse/stop.bat)：停止占用本地端口（默认 `3737`）的服务进程。
   - [`backup.bat`](file:///g:/YoYo-Local-For-Muse/backup.bat)：将 `./data/` 完整备份到 `backup/data-<时间戳>/`。
   - [`diagnose.bat`](file:///g:/YoYo-Local-For-Muse/diagnose.bat)：运行诊断脚本生成脱敏排查报告。

### Linux / macOS 与开发命令

```bash
./start.sh              # 首次自动安装依赖并构建前端，随后启动服务
```

常用 npm/bun 脚本（见 [`package.json`](file:///g:/YoYo-Local-For-Muse/package.json)）：

```bash
bun install
bun run build:client    # 构建前端静态资源 → client/dist（改动 client/src 后需执行）
bun run local:start     # 直接启动本地服务（http://127.0.0.1:3737）
bun run local:dev       # 构建前端并启动本地服务
bun run local:diagnose  # 生成脱敏诊断报告（scripts/diagnose.ts）
bun run typecheck       # 类型检查（client + server）
bun run test            # 运行全部测试（server + local + client）
```

### 随包运行时（Windows 可选目录）

| 运行时 | 放置路径 | 说明 |
| --- | --- | --- |
| Bun | `runtime/bun/bun.exe` | 优先使用，缺失时回退系统 `PATH` 或自动安装 |
| ffmpeg / ffprobe | `runtime/ffmpeg/ffmpeg.exe` + `ffprobe.exe` | 缺失时视频工具节点、海报/代理生成及尺寸实测不可用，其余功能正常 |
| cloudflared | `runtime/cloudflared/cloudflared.exe` | 用于 `/bridge-admin` 隧道向导建立公网转发 |

---

## 三大生成引擎配置说明

### 1. Muse「YoYo桥」（多账号与隧道）

本地生成任务写入本地队列后，由独立云端 Space「YoYo桥」（`YoYo桥/`）通过 Cloudflare Named Tunnel 主动拉取并回传结果。

- **管理入口**：启动后点击顶部「YoYo桥设置」或直接访问 `http://127.0.0.1:3737/bridge-admin`。
- **多账号档案**：`data/bridge.json` 最多保存 **8 个** Muse 账号档案（或通过 `YOYO_BRIDGE_TOKEN` 环境变量临时单档案覆盖）。手动切换「当前账号」后，仅当前账号可认领新任务；切换前的在途任务仍允许原桥回送完成。
- **配对流程**：
  1. 在 `/bridge-admin` 点击「生成新档案」，当场复制仅显示一次的令牌。
  2. 使用同页下半区「隧道向导」一键完成 `cloudflared` 安装、授权、建隧道、绑定子域名（如 `yoyo-bridge.<域名>`）、生成 `config.yml`（仅放行 `/bridge/*`，其余 404）并启动服务。
  3. 在对应 Muse 账号打开「YoYo桥」Space 设置页，填入隧道地址与该档案令牌保存。
  4. 回到本地管理页将该档案「设为当前」，发起一次 16:9 生图验收即可。

### 2. AGY 本地引擎（Nano Banana 与本地推理）

- 点击画布顶部「**AGY 引擎**」打开配置弹窗（[`AgySetupModal.tsx`](file:///g:/YoYo-Local-For-Muse/client/src/components/AgySetupModal.tsx)）：
  1. 一键部署本机 `agy` CLI 并自动配置工作区信任。
  2. 一键完成 Google 账号授权登录。
  3. 选择默认推理模型、测试连接并点击「保存并启用」。
- 启用后可在节点上切换使用 AGY（Nano Banana 生图、配置节点文本、提示词逆推）或作为画布 Agent 后端。

### 3. Gemini 网页版（Pro 会员无头生图）

- 点击画布顶部「**Gemini 网页**」打开配置弹窗（[`GeminiWebSetupModal.tsx`](file:///g:/YoYo-Local-For-Muse/client/src/components/GeminiWebSetupModal.tsx)）：
  - 复用本机已安装的 Chrome / Edge 与独立浏览器档案目录（`data/gemini-web-profile/`），不干扰日常浏览器。
  - 登录 `gemini.google.com` 并开启开关后，可在生图节点切换使用「Gemini 网页」通道，按需在后台无头拉起浏览器串行完成生图并下载高清原图。

---

## 数据目录（`./data/`，首次启动自动创建）

| 路径 | 用途 |
| --- | --- |
| `data/app.db` | SQLite 主数据库（启动按序执行 `drizzle/0001–0015` 迁移） |
| `data/blobs/` | 内容寻址 Blob 存储（`objects/<sha256前2位>/<sha256>` + `.meta.json`） |
| `data/yoyo-canvas-projects/` | 各项目默认工作目录（上传参考、生成成片、工具产物） |
| `data/bridge.json` | YoYo桥多账号档案与当前激活档案 ID |
| `data/agy-config.json` | AGY 启用开关、默认模型及各节点选定引擎（`nodeEngines`） |
| `data/gemini-web-config.json` | Gemini 网页版生图启用开关 |
| `data/gemini-web-profile/` | Gemini 网页版独立浏览器用户数据目录 |
| `data/agent-config.json` | 画布 Agent 模型配置与激活配置（API Key 仅脱敏下发给前端） |
| `data/agent-history/` | 画布 Agent 对话历史与 Skills 存储 |
| `data/tunnel.json` / `data/custom-project-dirs.json` | 隧道向导状态 / 自定义项目目录登记 |
| `data/exports/`、`data/imports/` | `.yoyo-canvas.zip` 项目包导出与导入暂存 |

---

## 存量项目迁移

1. 在云端或另一套 YoYo画布中打开项目菜单 →「导出项目包」（`.yoyo-canvas.zip`）。
2. 在本地画布直接通过左上角菜单「导入项目包」，或使用命令行脚本迁移到 `./data`：
   ```bash
   bun scripts/migrate-package.ts <项目包路径.zip>
   ```

---

## 目录结构

| 路径 | 说明 |
| --- | --- |
| [`client/`](file:///g:/YoYo-Local-For-Muse/client) | React 19 前端与本地打包脚本 `build-local.mjs` |
| [`server/`](file:///g:/YoYo-Local-For-Muse/server) | 画布核心 Actions（projects / graph / assets / prompts / generation / generation-records / media-edit / package）与特权实现 |
| [`local/`](file:///g:/YoYo-Local-For-Muse/local) | 本地 HTTP 服务（`app.ts` / `server.ts`）、SDK 垫片上下文（`ctx.ts`）、SQLite/Blob、桥管理与隧道、AGY、Gemini Web、Agent 后端 |
| [`packages/local-sdk/`](file:///g:/YoYo-Local-For-Muse/packages/local-sdk) | `@hatch/space-sdk` 本地适配垫片 |
| [`YoYo桥/`](file:///g:/YoYo-Local-For-Muse/YoYo桥) | 配套云端 Muse Space「YoYo桥」源码与部署文档 |
| [`drizzle/`](file:///g:/YoYo-Local-For-Muse/drizzle) | 数据库迁移脚本 `0001–0015` |
| [`scripts/`](file:///g:/YoYo-Local-For-Muse/scripts) | `diagnose.ts`、`smoke-local.ts`、`migrate-package.ts`、`make-fixture-package.ts` |

---

## 环境变量与安全边界

- `YOYO_LOCAL_HOST`（默认 `127.0.0.1`）：⚠️ 画布接口、`/agy/*`、`/gemini-web/*`、`/agent/*` 与 `/bridge-admin` 均**无登录口令**，切勿在未做隔离的情况下绑定到 `0.0.0.0` 暴露给局域网或公网。
- `YOYO_LOCAL_PORT`（默认 `3737`）：修改本地服务监听端口。
- `YOYO_LOCAL_ROOT`：指定数据根目录（默认项目下的 `./data`）。
- `YOYO_BRIDGE_TOKEN`：临时桥令牌覆盖（存在时接管 `data/bridge.json`）。
- `FFMPEG_PATH` / `FFPROBE_PATH`：覆盖随包或系统 `ffmpeg` / `ffprobe` 可执行文件路径。
- 本地视频比例 `auto` 统一按 `16:9`（`1280x720`）组装生成报文，确保桥侧按确切尺寸执行不退单。
- 本地服务 `ctx.invalidateQueries` 为空实现，多浏览器标签页同时打开时需等待各页自身轮询或手动刷新同步。
