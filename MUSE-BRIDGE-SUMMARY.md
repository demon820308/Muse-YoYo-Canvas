# YoYo画布本地版连入 Muse 生成方案总结

本项目采用 **「本地画布队列 + Cloudflare 隧道 + Muse 云端独立桥 Space」** 的方式（S1 方案）连入 Muse 生成：本地只负责画布交互、数据存储与任务排队，云端负责调用 Muse 账号的生成能力，两边通过主动轮询 + HTTP 分块传输衔接。

## 1. 整体架构与分工

| 端 | 组件 | 职责 |
| --- | --- | --- |
| **本地端** (`127.0.0.1:3737`) | 本地画布 + `local/bridge.ts` | 所有项目、资产、记录存于 `./data/`；点击生成时写入 `local_bridge_jobs` 队列（节点显示「生成中（等待云端）」），仅抽帧/提取音频/视频配乐由本地 `ffmpeg` 直接完成。 |
| **穿透层** | Cloudflare Named Tunnel | 将公网子域名 `https://yoyo-bridge.<域名>` 的 `/bridge/*` 转发到本地 `localhost:3737`（其余路径返回 404），所有账号共用同一隧道地址。 |
| **云端** (Muse Space `yoyo-bridge`) | `YoYo桥/server/src/actions.ts` + `bridge-executor.ts` | 独立部署在 Muse 账号里的「YoYo桥」Space，靠平台托管定时任务（`yoyo-bridge-sync` / `yoyo-bridge-fast`）主动向本地拉取任务、调用当前 Muse 账号能力生成并送回结果。 |

## 2. 任务流转与生成方式

云端桥通过 `YoYo桥/server/src/bridge-transport.ts` 以 `fetch` 经隧道访问本地的 5 个 `/bridge/*` 端点：

1. **拉取与认领**：`GET /bridge/pending` 获取 `queued` 任务（每轮最多认领 3 个）→ 校验载荷/下载参考文件 → `POST /bridge/ack-claim` 确认认领（`queued → claimed`）。
2. **下载参考素材**：`task-*` 与 `prompt-reverse` 任务通过 `GET /bridge/files/*` 拉取参考图/音/视频，支持 `Range` 分段下载（≤10MB/段，失败自动重试）。
3. **两类 Muse 生成通道**（见 `YoYo桥/server/src/bridge-executor.ts`）：
   - **同步通道**（`direct-image`、`text`、`prompt-reverse`）：在同步轮内直接调用 Muse SDK 的 `ctx.tool.generate_media`（纯提示词生图）或 `ctx.inference.complete`（文案生成、图片逆推提示词；逆推前自动转 PNG/JPEG 并压缩至 ≤3MB、长边 ≤2048px）。
   - **异步任务通道**（`task-image`、`task-video`、`task-audio`）：把参考文件写入 `~/workspace/yoyo-bridge-jobs/job-<id>` 后，调用 `ctx.agent.spawnTask` 派发后台 Agent 生成，完成后回调 `completeBridgeJob` / `failBridgeJob`。
4. **回传与落地**：成片通过 `POST /bridge/result` 回传（媒体走原始字节流 + `x-chunk-index`/`x-chunk-total` ≤10MB 分块协议；文本走 JSON），本地落盘后用 `ffprobe` 复测尺寸并更新节点；失败走 `POST /bridge/fail`。
5. **纯执行口径**：桥不做比例推导或尺寸猜测，媒体目标像素尺寸由本地画布按 `确切像素尺寸：<宽>x<高>` 写入报文（本地视频 `auto` 统一按 `16:9` → `1280x720` 组装），桥原样采用。

## 3. 多账号管理与门控

- 本地 `data/bridge.json` 支持保存最多 8 个 Muse 账号档案（或用环境变量 `YOYO_BRIDGE_TOKEN` 临时覆盖），通过 `x-bridge-token` / `Authorization: Bearer` 常量时间校验。
- 在 `http://127.0.0.1:3737/bridge-admin` 手动切换**当前账号**：
  - **只有当前账号**能领新任务；非当前账号拉 `/bridge/pending` 会收到空列表（`inactive: true`）并安静空转。
  - **在途任务不丢单**：切换账号后，原账号的桥仍可通过 `/bridge/files/*`、`/bridge/result`、`/bridge/fail` 把已认领的任务做完并送回。

## 4. 接入配对步骤

1. **本地建档案**：启动本地服务，打开 `http://127.0.0.1:3737/bridge-admin` →「生成新档案」→ 当场复制令牌（只显示一次）。
2. **本地起隧道**（只需一次）：在同一页面下半区的「隧道向导」依次完成安装 `cloudflared`、授权、建隧道、绑定子域名 `yoyo-bridge.<域名>`、写 `config.yml` 并安装服务。
3. **Muse 侧填配置**：在对应 Muse 账号打开「YoYo桥」Space 设置页，填入隧道地址与该账号令牌并保存。
4. **设为当前并验收**：回本地管理页把该档案「设为当前」，在画布点一张 16:9 纯提示词生图，约 30 秒内云端开始生成并落回本地节点。
