# YoYo画布 · 本地版

由云端 YoYo画布 Space（slug: yoyohua-bu）源码派生的独立本地工程：
界面与交互与云端版一致，平台依赖收敛到一个本地垫层（见
`PLATFORM-TOUCHPOINTS.md`），数据全部在本地 `./data/`，
生成走「本地队列 + 云端桥」口径（S1 方案）：点生成先写入本地
桥队列并显示等待状态，桥接通后由独立云端 Space「YoYo桥」生成
并把结果送回落地。本目录与云端画布 Space 互不影响。

## 启动

### Windows（日常使用）

1. 把整个目录放到本机（如 `D:\yoyo-local`）。
2. 准备随包运行时（见下「随包运行时」），或确保系统已装 Bun 与 ffmpeg。
3. 双击 `start.bat`：首次自动装依赖、构建前端，随后启动服务并打开
   浏览器 `http://127.0.0.1:3737`。关掉窗口即停服务。

### Linux / macOS（验证用）

```bash
./start.sh            # 首次自动 bun install + 构建前端，然后起服务
```

手动等价命令：

```bash
bun install
bun run build:client   # 前端构建（client/build-local.mjs）
bun run local:start    # 起服务（或 bun run local:dev 一步到位）
bun run local:diagnose # 一键生成脱敏诊断报告（scripts/diagnose.ts）
bun run typecheck      # 类型检查（client + server）
bun run test           # 全量测试（server + local + client）
```

## 随包运行时（Windows 放置方式）

| 运行时 | 放置位置 | 说明 |
| --- | --- | --- |
| Bun | `runtime/bun/bun.exe` | 官方 Windows x64 版（bun.sh）；start.bat 优先用它，缺失时回退系统 PATH 的 `bun` |
| ffmpeg | `runtime/ffmpeg/ffmpeg.exe` + `ffprobe.exe` | 静态构建；start.bat 把该目录加进 PATH 并设 FFMPEG_PATH/FFPROBE_PATH。缺失时视频工具节点（抽帧/提取音频/配乐/海报/播放代理）与尺寸实测不可用，其余功能正常 |

## 数据目录（./data/，首次启动自动创建）

| 路径 | 内容 |
| --- | --- |
| `data/app.db` | SQLite 主库（启动按序执行 `drizzle/0001–0014` 迁移，`_local_migrations` 记录进度） |
| `data/blobs/` | Blob 存储，布局与平台一致：`objects/<sha256(key) 前 2 位>/<sha256(key)>` + `.meta.json` |
| `data/yoyo-canvas-projects/<项目名-id8>/` | 各项目工作目录（生成参考文件、落地成片、工具产物） |
| `data/exports/`、`data/imports/` | 项目包导出/导入的暂存（用后自动清理） |
| `data/bridge.json` | 桥账号档案（多账号手动切换，见下） |

备份 = 运行 `backup.bat`（复制到 `backup/data-<时间戳>/`）或手动拷贝整个 `data/`。删掉 `data/` 等于恢复出厂（项目与资产全清）。

## 桥账号档案（多账号手动切换）

本地可保存多个 Muse 账号的桥配置，手动选一个为**当前账号**，
只有当前账号的桥能领新任务；不同时工作（Wei 2026-11-22 定版）。
隧道地址对所有账号是同一个（隧道指向本地机），账号之间唯一
区别是各自的桥令牌。

管理入口：本地服务起来后打开 **http://127.0.0.1:3737/bridge-admin**
（桥账号管理页，与画布分开的独立小页面）。页面可：

- 新增档案：点「生成新档案」→ 令牌全文**只在生成当下显示一次**，
  当场复制保存；之后列表里只显示掩码。
- 改备注、设为当前、删除档案（有任务在途时删除会先弹提示，
  确认后仍可删；删掉当前档案后当前位置空置，不自动顶替）。
- 每档案显示最近在线时间（内存记录，本地服务重启后清零）。

档案存 `data/bridge.json`：
`{ "profiles": [{ id, label, token, createdAt }], "activeProfileId" }`，
上限 8 个。旧格式 `{ "token": "..." }` 首次读取时自动迁移为
1 号档案（备注「主账号」）并写回新格式，无需手动处理。
环境变量 `YOYO_BRIDGE_TOKEN` 仍可用：存在时视为临时单档案
（不落盘、恒为当前），文件档案暂时让位，移除后恢复。

门控规则（桥端点按令牌解析到档案）：

- 未知令牌 → `401`；没有任何档案 → 五端点统一
  `503 bridge_not_configured`（画布本地功能不受影响，点生成
  照常入队等待）。令牌校验走 `x-bridge-token` 头
  （或 `Authorization: Bearer`），常量时间比较。
- 已知但**非当前**档案：拉 `/bridge/pending` 回空列表
  （`{ jobs: [], inactive: true }`）、`/bridge/ack-claim` 回
  `{ status: "inactive" }` 不认领——那个账号的桥据此安静空转，
  无需桥侧做任何改动。
- `/bridge/result`、`/bridge/fail`、`/bridge/files/*` 对**任何
  已知档案**放行：切换发生在任务在途时，原桥仍能把结果送回来、
  把参考文件取完，不丢结果。

⚠️ 管理页**无口令**，只应通过本机回环访问。本地服务默认绑
127.0.0.1；若改绑局域网（`YOYO_LOCAL_HOST`），等于把本页对
局域网开放，请勿这样做。

## 桥配对全流程（每加一个账号走一遍，与桥 Space 设置页一一对齐）

配对 = 隧道地址 + 该账号档案的令牌，两端各填一次。顺序：

1. **本地新增档案**：打开 http://127.0.0.1:3737/bridge-admin →
   「生成新档案」（可填备注名，如账号的称呼）→ 当场复制令牌。
2. **本地起隧道**（Wei 在 Windows 上操作，只需做一次，所有
   账号共用）：优先用桥管理页的「隧道向导」——打开
   http://127.0.0.1:3737/bridge-admin 下半区的隧道区，逐项点
   按钮即可：安装（已装会显示版本号并禁用按钮）→ 授权（按钮
   拉起浏览器，选中域名点授权）→ 建隧道（ID 自动捕获）→ 子
   域名（可手动填写；页面会检测该子域名是否已被创建——CNAME
   指向隧道即提示已创建且不再重复写、被其它记录占用会提示、
   无记录才是可用）→ 写配置（按实测 ID/主机名自动生成
   config.yml，已有文件先备份 .bak）→ 运行 → 装服务（弹 UAC
   点「是」）。命令行兜底口径不变（见
   `runtime/cloudflared/config.example.yml` 注释与配对操作单）：
   装 cloudflared → `cloudflared tunnel login` 浏览器授权 →
   建 Named Tunnel 并绑定子域名 `yoyo-bridge.<域名>` → 写好
   `config.yml`（ingress 只放 `/bridge/*` 到 `localhost:3737`，
   其余 404）→ `cloudflared service install` 注册开机自启。
   **真机待验**：向导的 winget 安装、UAC 提权装服务、真实
   login 授权与服务运行只在 Windows 真机上算数，本机
   （Linux VM）只验过逻辑层与页面/端点，列入真机验收清单。
3. **那个账号的桥 Space 侧填配置**：在**那个 Muse 账号**里
   打开独立桥 Space「YoYo桥」（slug: yoyo-bridge）的设置页
   （打开即是）：地址填 `https://yoyo-bridge.<域名>`
   （只填域名也可，自动补 https，与其它账号填的一样），
   令牌粘贴第 1 步该档案的令牌 → 保存。设置页会显示配对状态：
   最近在线时间、各状态任务计数、最近错误与最近任务列表；
   令牌只显示掩码，全文不出现在任何界面与日志里。桥自
   2026-11-22 起独立成 Space，与云端画布再无关系，画布里
   没有桥设置入口。
4. **切换当前账号**：回管理页把这个档案「设为当前」。从这一刻
   起只有这个账号的桥领新任务；之前账号的桥再来拉任务只会
   拿到空列表、安静空转（它在途的任务仍可回送完）。
5. **验收**：本地点一张 16:9 纯提示词生图 → 约 30 秒内当前
   账号开始生成 → 结果自动落回本地节点，本地生成记录与资产
   齐全。换某档案的令牌时：删掉旧档案、新增一个，再去那个
   账号的桥设置页粘贴新令牌保存（旧令牌即刻失效）。彻底断开
   某个账号：删掉它的档案即可；全部断开：删光所有档案，
   桥端点回到 503 未配置。

传输口径（探针定版）：Space 出站以 fetch 为主；参考文件下载与
结果回送都按 ≤10MB 分块（下载走 Range、回送走
`x-chunk-index/x-chunk-total` 分块协议，本地端点已支持），失败
段单独重试，整轮失败不丢数据、任务保持原状态等下一轮。

## 生成在本地的行为（桥接通前）

- 图片/视频/音频（任务通道与直出通道）、配置节点文本、提示词逆推：
  任务组装后写入本地桥任务表 `local_bridge_jobs`，节点显示
  「生成中（等待云端）」，不实际生成、不报错。
- 工具节点中的抽帧/提取音频/视频配乐：本地 ffmpeg 直接执行，当场出结果。
- 队列抽屉与生成记录与云端版同口径；停止/取消照常可用。

## 存量项目迁入（yoyo-01 / yoyo-02 正式迁移步骤）

包格式不携带绝对路径，迁移走项目包通道（已用 fixture 三态演练，
见 PROGRESS.md）：

1. 在云端 YoYo画布打开项目 → 导出项目包（.yoyo-canvas.zip），下载到本地。
2. 本地服务停不停均可，运行：
   `bun scripts/migrate-package.ts <包路径>`
   （向真实 `./data` 迁移；脚本依次做迁前校验 → 导入 → workspaceDir
   核对 → 迁后校验，任一失败退出码 1 且不写半成品断言）。
3. 打开本地画布确认项目、节点、媒体与生成记录无误后，按 S1 第十节
   口径把云端原项目转只读留档。
4. yoyo-02 同法再迁一次。两项目相互独立，顺序任意。

## 目录速览

| 路径 | 说明 |
| --- | --- |
| `client/` | React 前端（与云端同源；仅 `src/api.ts` 改为 fetch 客户端，另加 `build-local.mjs`） |
| `server/` | 服务端 actions 与特权层实现（与云端同源；定点适配清单见 PLATFORM-TOUCHPOINTS.md 第五节） |
| `local/` | 本地运行时：HTTP 服务、ctx 垫层、db、blobs、桥端点、桥账号档案、管理页与隧道向导 |
| `packages/local-sdk/` | `@hatch/space-sdk` 本地垫片（只实现源码用到的表面） |
| `YoYo桥/` | 独立云端桥 Space（`yoyo-bridge`）源码快照与部署/使用文档 |
| `drizzle/` | 云端原迁移 0001–0014（逐字保留） |
| `scripts/` | diagnose.ts（一键诊断）、smoke-local.ts（本机实测）、migrate-package.ts（迁移）、make-fixture-package.ts + fixtures/（演练素材） |
| `backup.bat` | Windows 一键备份 `data/` 到 `backup/data-<时间戳>/` |
| `.github/workflows/ci.yml` | GitHub Actions CI（typecheck / test / build:client） |
| `server/.generated/` | 云端构建的特权契约抽取物，本地不引用（本地 tsconfig 直指 `server/src/privileged.ts`），保留作对照 |

## 已知边界

- `ctx.invalidateQueries` 在本地为 no-op：单机单浏览器下靠客户端
  自身的查询失效与队列轮询刷新；多标签页同时打开时，另一页的
  变更要等其自身轮询/刷新才可见。
- 本地视频比例的「自动（auto）」即 16:9（Wei 2026-11-22 定版）：
  `server/src/actions/ratios.ts` 的 `normalizeVideoRatio` 是单一
  归一入口，auto / 空 / 不可解析一律按 16:9 组装报文，桥任务载荷
  必带确切像素串（16:9 → 1280x720，`computeVideoSize` 的 720p
  口径）；存量 `genRatio="auto"` 的节点（项目包导入等带入）走同一
  路径，存储值不改写。桥侧「不推导像素、无尺寸即退单」的口径不变，
  本地不再产出无尺寸的视频报文。
- 本地服务默认只绑 `127.0.0.1:3737`。要局域网访问设
  `YOYO_LOCAL_HOST=0.0.0.0` 并在防火墙放行（桥端点有令牌保护，
  但画布接口本身无鉴权、桥账号管理页 `/bridge-admin` 无口令，
  局域网内慎开）。
- 端口可经 `YOYO_LOCAL_PORT` 修改。
