# YoYo画布本地版 · 施工进度（第二步：脱壳 MVP）

开工：2026-11-22。依据：S1 方案第五节（本地画布）与第四/七节（桥端点）。
源工程 `~/workspace/ts-spaces/yoyohua-bu/` 全程只读，未改动、未对其 app.db 跑任何脚本。

## 阶段清单

- [x] 阶段 0 · 必读与盘点：S1 第四/五/七节、ENGINEERING 开工速查、源码结构、SDK 类型面（Ctx / SpaceDb / BlobClient / PrivilegedExecutor / defineAction / generate_media 签名）已审读。
- [x] 阶段 1 · 独立工程拷贝 + 平台触点盘点（PLATFORM-TOUCHPOINTS.md）。
- [x] 阶段 2 · 本地 SDK 垫片（packages/local-sdk）+ 依赖安装（bun install 59+20 包成功）。
- [x] 阶段 3 · 本地运行时（local/：config / db / blobs / ctx / bridge / app / server）+ 五个桥端点。
- [x] 阶段 4 · 源码定点适配（清单 A1–A10，见 PLATFORM-TOUCHPOINTS.md 第五节）。
- [x] 阶段 5 · 客户端本地构建脚本 + start.sh / start.bat（start.sh 实测起服成功）。
- [x] 阶段 6 · 回归门全绿（证据见下）。
- [x] 阶段 7 · 迁移演练三态全过 + README + 交付报告。

## 阶段 6/7 证据（2026-11-22 本机实测）

- typecheck：client + server 双 tsconfig 均 exit 0。
- 特征测试：`bun test server/src/actions/__tests__` → **66 pass / 0 fail**（218 个 expect，
  5 个文件，测试文件逐字未改、零适配）。
- 客户端构建：`bun run build:client` 成功（dist/assets js 459KB + css + logo）。
- 本机实测（scripts/smoke-local.ts，对真实 HTTP 服务逐项断言）：**40 pass / 0 fail**。
  覆盖：healthz；桥未配对 503；建项目（目录落 data/yoyo-canvas-projects 且真实存在）；
  uploadMedia 图/视频（genSize 实测 64x48 / 160x120、落盘、blob 字节一致取回）；
  saveGraph 编号（上传先得 1、2，新节点续 3–7）；getProject 一致（7 节点 2 边）；
  提示词库、资产库读写；enqueue → queued；processQueue 认领 1 → working；
  generateImage（直出 16:9）与 runConfigNode（文本）本地均回 working；
  配对后 pending 拉到 task-image / direct-image / text 三类任务且载荷完整；
  无令牌 401；ack-claim 幂等；bridge/files 取回项目文件；
  result 媒体落地（节点 done、genSize 实测 320x240、文件落项目目录、重复投递 duplicate 幂等）；
  result 文本落地（新文本节点生成）；fail 落地（节点 failed + 人话错误）；
  runToolNode 抽帧本地真跑（产物 160x120);生成/工具落地后资产库 ≥3；
  exportProjectPackage（28KB、媒体 5、missing 0）→ importProjectPackage（节点 9=9、
  mediaMissing 0、媒体指向新项目目录）；deleteProject（batch 路径）后列表剩 1。
  过程中修正一条脚本断言：uploadMedia 在源版就不登记资产（只有生成/工具落地登记），
  本地行为与源版一致，非缺陷。
- 重启持久化：杀服务重启后 listProjects 仍见冒烟项目（9 节点），首页与 JS 资产 200。
- 迁移演练（scripts/make-fixture-package.ts 造包 → scripts/migrate-package.ts
  --data-root /tmp/yoyo-drill-data）：迁前校验 4 项、迁移 2 项、迁后校验 5 项全 PASS；
  fixture 包与云端导出同格式（同一套代码产出，14313 bytes，3 节点 1 边 3 媒体条目）。
- 冒烟数据已清理：交付时 data/ 不存在（首次启动自动建），.fixture-tmp 已删；
  fixture 包保留在 scripts/fixtures/ 供复演。

## 施工中定下的实现事实（与设计决策的偏差/补充）

- 桥任务表与入队逻辑落在新文件 `server/src/actions/bridge-jobs.ts`（drizzle 表定义 +
  ensure/create/claim/settle + BridgeQueuedError），local/ 与 actions 三个调用点共用。
- bun-sqlite 驱动没有平台 SpaceDb 的 `batch`：local/db.ts 以「事务内顺序执行 +
  失败整批回滚」补齐（调用点仅 saveGraph 批量删除与 deleteProject 三表删除，
  已被冒烟覆盖验证）。
- 特权契约 `@space/privileged` 本地直指 server/src/privileged.ts 本体（无抽取步骤，
  Contracts 与 Handlers 同源）；server/.generated 保留作对照、不再被引用。
- 测试新增 devDependency `@libsql/client@0.14.0`（两支特征测试的 db 夹具用，
  与云端 node_modules 中版本一致）。

## 本地适配的设计决策（先记后行）

1. **垫片包**：新建 `packages/local-sdk`，包名仍为 `@hatch/space-sdk`（含 `./client` 子路径），
   只实现源码实际用到的表面：`z`（转出 zod）、`defineAction`、`definePrivilegedContracts/Handlers`、
   `createPrivilegedExecutor`、`InferenceSchemaError` 与全部类型（Ctx/SpaceDb/BlobClient 等）。
   源码的 import 语句因此零改动（api.ts 按工单要求单独重写为例外）。
2. **ctx.db**：`bun:sqlite` + `drizzle-orm/bun-sqlite`（与源工程特征测试同一组合，已被测试验证）。
   启动时按文件名序执行 `drizzle/0001–0014`，用 `_local_migrations` 表记录已执行文件，重启不重跑。
3. **Blob**：本地目录 `./data/blobs/`，对象布局与平台一致：`objects/<sha256(key)[:2]>/<sha256(key)>`，
   另存同名 `.meta.json`（contentType/size）。`mirrorBlobToFile` 特权实现按
   `HATCH_SPACE_BLOB_DIR` 环境变量定位 blob 根——本地服务启动时把该变量设为 `./data/blobs`，
   特权实现零改动即可读到本地对象。`getUrl` 返回 `/blobs/<key>`，由本地 HTTP 服务出字节。
4. **ctx.spaceDir**：本地取 `./data/`（于是特权层 package 域的 `<spaceDir>/exports|imports`
   落到 `data/exports`、`data/imports`，与数据统一目录口径一致）。
5. **特权层**：`executePrivileged` 本地直调 `server/src/privileged.ts` 的 Handlers 实现
   （本来就是 node:fs / node:child_process 的普通代码），调用前按契约 zod 校验入参、出参。
   路径单点适配只动两处：`privileged/files.ts` 的 WORKSPACE/PROJECTS 根（改由本地根推导）、
   `privileged/media-common.ts` 的 ffmpeg/ffprobe 名字（允许 FFMPEG_PATH/FFPROBE_PATH 覆盖）。
6. **项目目录单点**：`actions/project-dirs.ts` 的 `homeDir()/projectWorkspaceDir()/expandHome()`
   为本地版改道：新项目目录落在 `./data/yoyo-canvas-projects/`；`expandHome` 对
   `~/workspace/yoyo-canvas-projects/<rest>` 前缀映射到本地项目根，存量绝对路径经迁移脚本改写。
7. **生成三通道本地语义**（不实际生成，只组装 + 入队 + 状态可查）：
   - `ctx.agent.spawnTask`：把任务全文（message + expectsAction + dedupeKey）写入本地桥任务表
     `local_bridge_jobs`（status=queued），返回 `{ ok:true, taskId: jobId }`；同 dedupeKey 有未结
     任务时返回既有 jobId（沿用平台单飞语义）。分发代码随后把节点置 working 并写入
     genTaskId=jobId——节点带 genTaskId 即被 `recoverStaleWorking` 豁免，稳定停在等待态。
   - `ctx.tool.generate_media` / `ctx.inference.complete`：本地抛专用 `BridgeQueuedError`
     （携带已组装的 prompt / 方向 / 模式等载荷）；三个调用点（generation-dispatch 的直出图与
     配置文本、tool-dispatch 的提示词逆推）在本地版定点捕获：落桥任务 + 节点置 working +
     genTaskId=jobId + 返回 working。改动点各一处、带 `[yoyo-local]` 标记，其余分发逻辑逐字不变。
   - 桥未配对时任务同样入队（桥端点返回未启用只是对云端拉取而言），前端显示等待状态，
     与 S1「桥启用前，点生成写入本地队列并显示等待状态」一致。
8. **桥端点**（S1 第七节，挂在本地后端、与画布接口分开）：
   `GET /bridge/pending`、`GET /bridge/files/*`、`POST /bridge/ack-claim`、
   `POST /bridge/result`、`POST /bridge/fail`。令牌存 `./data/bridge.json`（或环境变量
   YOYO_BRIDGE_TOKEN），常量时间比较；未配对时五端点统一返回 503 `{ error: "bridge_not_configured" }`。
   result 落地复用既有 complete*Generation 动作 handler（媒体类）与 attachResultNode（文本类），
   落盘后由 complete 链内的 probeMediaFile 复测尺寸（与 S1「ffprobe 复测再 ACK」同口径）。
   jobId 幂等：result/fail 对已结任务重复投递只回当前状态、不重复落地。
9. **HTTP 契约**：`POST /actions`，请求体 `{ action, args }`，成功回动作返回值本身，
   失败回 400/500 + `{ error: 人话消息 }`；api.ts 的 fetch 客户端据此抛错，与云端
   createActionClient 的「失败即 throw」口径一致。请求/响应均过动作自带 zod schema 校验。

## 待决 / 风险（滚动记录）

- ctx.invalidateQueries 本地 no-op 的影响面：服务端状态流转已被冒烟逐项验证；
  浏览器端靠 react-query 自身 mutation 失效 + use-generation 的 processQueue 轮询
  （与云端同一套客户端代码）。未做真机浏览器联调（本任务环境无 Windows 真机），
  多标签页场景下另一页的变更需等其自身轮询/刷新——已写入 README「已知边界」，
  第三步联调时在 Wei 的 Windows 机上确认一次即可。
- ffmpeg/ffprobe 在 Windows 侧以「随包目录 runtime/ffmpeg」组织（start.bat 把它加进 PATH
  并设 FFMPEG_PATH/FFPROBE_PATH），本机（Linux VM）用系统 ffmpeg 8.1.2 验证了同一代码路径；
  Windows 侧静态构建的 ffmpeg 未在本机验过，属第三步真机验收范围。
- start.bat 只在本机做了静态审读（无 Windows 环境可跑），逻辑与 start.sh 等价，
  start.sh 已实测；start.bat 列入第三步真机验收清单。

---

## 第三步施工记录（Space 桥域，2026-11-22）

### 本地侧配套（先行完成，证据等级：本机实测）
- `local/ctx.ts`：spawnTask 报文结构化解析 `parseSpawnMessage`——任务通道任务
  payload 由 `{ message }` 扩展为 `{ message, parsed: { prompt, ratio,
  durationSeconds, refs: [{ kind, title, path, relPath }] } }`（第三步契约扩展，
  与 Space 桥域同步）。解析器自测：多行提示词完整保留、3:2/16:9 比例、视频
  时长、图片/音频参考行与 relPath 全部正确。本地 typecheck 通过、特征测试
  66/66（需带 YOYO_LOCAL_ROOT 运行，与第二步口径一致）。
- `local/bridge.ts`：契约扩展两处——`GET /bridge/files/*` 支持 Range
  （206 + Content-Range，实测分段拼装与整文件逐字节一致）；
  `POST /bridge/result` 支持分块协议（x-chunk-index / x-chunk-total，
  中间块回 chunk_received、已收块重发回 duplicate、乱序 409、末块触发
  原有 complete* 落地；实测 3 段拼装落地成功、结算后重发回 duplicate）。
  不带分块头的旧行为不变。
- `runtime/cloudflared/config.example.yml`：Named Tunnel 模板（ingress
  只放 ^/bridge/.* → localhost:3737，其余 http_status:404）。
- README 新增「桥配对全流程」节，与 Space 桥设置面步骤一一对齐
  （本地令牌 → 隧道 → Space 填地址+令牌 → 验收 → 换令牌/清除）。
- 探针环境：本机以 YOYO_LOCAL_ROOT=/tmp/yoyo-probe-data 起本地服务
  （令牌 probe-*），备好 direct-image / text / task-image（带参考图，
  parsed 完整）三条待拉任务待云端联调。

### Space 桥域（构建通道交付 + 发布后联调探针，证据等级：测试全绿 + 沙箱实测 + 正式环境探针实测）
- 构建（artifact 通道）：迁移 0015 新增 bridge_jobs / bridge_config；服务端新增
  bridge-store（配置/守卫状态机/DB 租约/影子项目）、bridge-transport（Range 分段
  下载 + ≤10MB 分块回送、错误三分类）、bridge.ts 四动作与 bridge-deliver（跟进/回送/
  清理）；特权层新增 deleteProjectFile；recordMediaAsset 对影子项目跳过（唯一既有
  行为改动）；客户端项目菜单加「桥设置」+ BridgeSettingsDialog（令牌只显掩码）。
  typecheck 双配置全绿；特征测试 83/83（原 66 逐字未改 + 新增 bridge 17 条：迁移
  三态/状态机/租约/掩码/分块上下行/影子资产跳过/未配置 skipped/令牌不入响应）。
  构建同时完成平台 v29 表单字段升级（构建方处理，非桥域口径变化）。
- 正式环境全链探针（本机 yoyo-local 起服于回环地址模拟隧道可达，项目
  「桥探针项目」三条任务）：
  · bridgeSync 一轮：claimed 3 / dispatched 3 / delivered 2 / cleaned 2——
    direct-image（16:9）云端直出后同轮回送，本地节点 done、genSize 实测
    2048x1152、成片 webp 落本地项目目录；text 同轮回送，本地生成文本节点
    （秋日短诗）并写生成记录。
  · task-image（3:2 + 参考图）：影子项目内参考图经 /bridge/files 下载落盘
    （bridge-ref-*.png + blob + 连边），派发 spawnTask 后节点 working；
    后台任务完成经 completeImageGeneration 落影子节点，bridgeFastSync 一轮
    delivered 1 / cleaned 1，本地节点 done、genSize 实测 1920x1280（3:2 档
    精确）、成片落本地、资产与生成记录齐全。
  · 幂等与清理：影子项目回送后节点/边清零（0 节点 0 边）；bridge_jobs 留
    3 行 cleaned 瘦身审计；影子目录内桥自有文件（参考图、成片）已删，
    仅剩后台生成工具自己的两个 scratch json（非桥所有，不在清理口径内）。
  · 不可达：baseUrl 改到无监听端口后 bridgeSync 回 skipped/local_unreachable
    不抛错、lastError 落库；探针毕 bridgeSetConfig clear → configured=false。
- 调度：cron yoyo-bridge-sync（interval 30s）与 yoyo-bridge-fast（interval 10s）
  均以 space_action 建成并实测准点触发、未配置下静默成功空转；平台支持亚分钟
  间隔，S1 的 30/10 延迟口径按原设计达成，无需降级补法。yoyo-processqueue 未动。
- 已知小项（不阻塞第三步验收）：①任务通道结果在本地资产库的标题带影子节点
  「桥 · 」前缀（回送 title 取自影子承载节点），本地节点本身标题不受影响；
  ②prompt-reverse 桥路径已实现并有单元覆盖，未做真链路探针，留第四步补验；
  ③视频级大文件回送走 readMediaFile base64 整读，第四步压测时评估。
- 待 Wei：指定 Cloudflare 域名并在 Windows 本机完成 cloudflared 授权/建隧道/
  装服务（模板 runtime/cloudflared/config.example.yml、README 配对节已备），
  本地生成真实令牌后在 Space「桥设置」粘贴保存即完成真实配对。

## 第四步前置 · 桥独立成 Space（2026-11-22，Wei 08:05 拍板拆分，08:10/08:16 两次口径修正）

### 决定与口径
- 桥从 yoyohua-bu 画布 Space 拆出，独立成新 Space「YoYo桥」（slug: yoyo-bridge），
  唯一服务对象是本地画布，与云端画布零关系：不调用其动作、不读其数据、不依赖其派发代码。
- 桥为纯执行器（照单执行）：派发口径的唯一事实源在画布侧的报文组装代码。桥不保存
  八档像素表、不做比例归一/尺寸推导/时长钳制；targetSize 由桥从载荷自带的原始报文
  payload.message 中按「确切像素尺寸：」前缀机械抽取后原样填入 spawn 报文，抽不到
  即 task-image/task-video 永久失败 payload_missing_target_size；direct-image 的
  orientation 只按 payload.ratio 宽高机械映射。桥保留的机械纪律：成片必须落在
  本 Space 作业目录内、probe 实测尺寸如实回填、量不到留空。
- 本地画布零改动：中途一度落地的 local/ctx.ts 解析器扩展（targetSize 字段）已按
  08:16 口径全量撤销，复验 grep targetSize 零命中、typecheck 双配置通过、特征测试
  66/66，与第三步交付状态一致。本地契约与五端点形状未动。

### 新桥 Space（证据等级：测试全绿 + 沙箱实调 + 正式环境探针实测）
- 数据：bridge_config 单行 + bridge_jobs（自包含记录：载荷、结果信息、genSize、
  状态机），无影子项目/影子节点概念。状态机守卫与 DB 租约（两同步动作共用）
  沿用第三步已验证口径；认领上限 3、跟进上限 10。
- 执行器：direct-image 走 ctx.tool.generate_media 同步直出（结果经 mirrorBlob 拷入
  作业目录后 probe 实测）；task-* 先经桥下载参考文件落本 Space 作业目录
  （~/workspace/yoyo-bridge-jobs/<jobDir>），再 ctx.agent.spawnTask 派发，后台任务
  以 completeBridgeJob（校验文件在作业目录内、probe 回填）/ failBridgeJob 回调交付；
  text 与 prompt-reverse 走 ctx.inference.complete（逆推先取回参考图、非 PNG/JPEG
  转码、超限 shrink 后送 inference，口径同画布）。结果经既有传输回送本地
  /bridge/result（媒体分块协议、文本 JSON），本地 ACK 后删作业目录并瘦身行。
- 动作：bridgeSync / bridgeFastSync / bridgeSetConfig / bridgeStatus（+ 交付回调
  completeBridgeJob / failBridgeJob），设置页为极简单页（配对状态/计数/最近错误/
  最近任务/配对表单，令牌只显掩码）。显示名已定为「YoYo桥」。
- 验证：特征测试 20/20（迁移/状态机/租约/掩码/传输分段与分块/执行器分类/报文抽取/
  未配置空转）；typecheck 双端全绿；沙箱实调 bridgeSetConfig 保存与 clear、令牌只以
  掩码出现、不可达回 skipped 并记 lastError。纯执行器检查证据：对桥 server/src
  （排除 __tests__）grep 八档像素串与 IMAGE_RATIO_SIZES / normalizeImageRatio /
  computeVideoSize / clampVideoSeconds / sizeBrief 符号，全部零命中（测试夹具中
  3 处 1920x1280 为抽取用例的输入与期望值，按裁定不计）。

### 画布拆除（证据等级：测试全绿 + 沙箱探针 + 动作清单复核）
- 迁移 0016 drop bridge_jobs / bridge_config，schema 删除两表定义；服务端桥域四文件
  （bridge / bridge-store / bridge-transport / bridge-deliver）删除，actions.ts 移除
  BridgeActions 注册；客户端删除 BridgeSettingsDialog 与项目菜单「桥设置」；
  recordMediaAsset 移除影子项目跳过特例；deleteProjectFile 经全仓检索确认仅桥域
  消费，契约与 handler 整链删除；桥域测试 bridge.test.ts 删除，特征测试 83 → 66/66
  基线全绿（其余 5 个测试文件逐字未动），typecheck 双配置全绿。
- 沙箱探针（沙箱项目「沙箱探针-桥拆除-20261122」，探后删除）：processQueue 一轮
  正常；直出图一例 done 落地并登记资产；任务通道一例（3:2）genSize 实测 1920x1280
  落盘。一处观察：沙箱直出图节点 genSize 为 null，不在本次拆除触及的代码路径内
  （分发与 complete 链未改），构建方判断为沙箱调用环境差异，未作回归处理。
- 影子项目 e385da5e-df38-4563-b3d3-d21e9fa43f51 已经画布 deleteproject 动作删除，
  listprojects 复核只剩 yoyo-01 / yoyo-02；其工作目录已删（内仅两个后台生成工具
  scratch json）。拆除后动作清单复核：桥四动作均不在列。

### 调度归属
- 旧 cron yoyo-bridge-sync / yoyo-bridge-fast（原指向 yoyohua-bu、owner 为
  goal:yoyo-deployment-and-iteration）已删除。
- 新 cron 由新桥 Space 构建时随 Space 装入（owner: space:yoyo-bridge，同名）：
  yoyo-bridge-sync interval 30s 直调 yoyo-bridge.bridgeSync、yoyo-bridge-fast
  interval 10s 直调 bridgeFastSync。运行记录实测准点触发（08:19:20/08:19:50/
  08:20:20 与每 10 秒整点），未配置期间全部 succeeded 静默空转。

### 正式环境全链探针（本机 yoyo-local 回环模拟隧道，与第三步同法）
- 本地以 YOYO_LOCAL_ROOT=/tmp/yoyo-bridge-probe 起服，探针项目
  2aeb6fb7-f0b8-44db-a9f9-f8797cc71835 备三条任务（本地 processQueue 已派发入桥
  队列；实测载荷 parsed 无 targetSize 字段，原始 message 内含像素串）。
- 新桥 bridgesetconfig 配对回环地址后，bridgesync 一轮：claimed 3 / dispatched 3 /
  delivered 2 / cleaned 2——direct-image 本地节点 done、genSize 实测 2048x1152；
  text 同轮回送，本地生成文本节点（秋日短诗两行）。
- task-image（3:2 + 参考图）：参考图经桥下载入作业目录、spawnTask 派发、后台任务
  经 completeBridgeJob 交付、fast 轮回送，本地节点 done、genSize 实测 1920x1280；
  本地成片文件、资产与生成记录齐全。桥侧 bridgestatus：3 行全 cleaned、桥侧
  genSize 记录 2048x1152 / 1920x1280，~/workspace/yoyo-bridge-jobs 作业目录已清空。
- 不可达：baseUrl 改到无监听端口后 bridgesync 回 skipped / local_unreachable，
  lastError 落库、租约已释放。探针毕 bridgesetconfig clear，交付状态为未配置空转
  （bridge_jobs 留 3 行 cleaned 审计）。探针数据归档于 goal 的
  hidden_files/bridge-split-probe-data。

### 待 Wei（不变）
- 指定 Cloudflare 子域名（如 yoyo-bridge.<域名>），在 Windows 本机按 README 配对节
  完成 cloudflared login / create / route / service 四步，本地生成真实令牌后在
  新桥 Space「YoYo桥」设置页粘贴保存，即完成真实配对；随后进入第四步（视频/音频
  全链、prompt-reverse 真链路、令牌轮换、掉线恢复、大文件回送压测）。
- 已知后果（新口径直接结果）：本地视频节点 ratio 为 auto 时，其报文 sizeBrief 无
  确切像素串，新桥将以 payload_missing_target_size 拒绝该任务（桥不推导像素）。

## 第四步前置（二）· 本地视频 auto 即 16:9（2026-11-22，Wei 08:25 拍板、08:27 定版）

口径：不取消「自动」选项，统一规则为「本地画布里 auto 就是 16:9」。
本节结论覆盖第四节末尾「已知后果（本地视频 ratio=auto 将被新桥以
payload_missing_target_size 拒绝）」一条——该后果自本次起消除。

### auto 盘点（全工程）
- 前端：`client/src/types.ts` 的 IMAGE_RATIOS 只有八档、RatioSelect
  菜单只渲染八档（GenerationPanel 视频内联/参数区、ConfigNodeBody
  卡片与详情、DetailEditor 经 GenerationPanel 共用同一组件），**本地
  UI 本来就没有 auto 选项可点**；新建节点默认 16:9。auto 值只来自
  存量/导入数据（saveGraph 与项目包导入均原样存 genRatio，contracts
  不做枚举校验）。无关的 auto（抽帧 grid "auto"、模型行「平台通道 ·
  自动」、CSS）不动。
- 服务端组装层（唯一问题面）：`ratios.ts` 的 `computeVideoSize`
  对 auto/不可解析返回 "auto"，`sizeBrief("video")` 据此输出
  「（尺寸自适应）」无像素串报文——桥据此退单。
- `cardSizeForRatio` 的 auto→1:1 只是无实测尺寸时的卡片定框兜底，
  不产报文；`graph-helpers` 落地时 video 的 genRatio 原样存
  （`source.genRatio ?? "16:9"`），存储层不改写 auto。

### 改法（只动 ratios.ts 单一入口 + 测试 + 冒烟 + 文档）
- 新增 `normalizeVideoRatio`：auto / 空 / 不可解析 → "16:9"，
  可解析比例原样透传。`computeVideoSize` 与 `sizeBrief("video")`
  都经它取值——视频比例归一的单一入口。
- `computeVideoSize` 不再返回 "auto"（16:9 → 1280x720，720p 短边
  口径，数值来源与既有测试一致）；`sizeBrief` 删除「尺寸自适应」
  分支，恒输出「画幅比例：<归一值>，确切像素尺寸：<WxH>」。
- `cardSizeForRatio` 的 auto 定框由 1:1 改按 16:9（与统一口径
  一致）；null 仍按 1:1 不变。
- 前端零改动（选项本就不存在 auto，保留不动即满足定版）；
  存量 genRatio="auto" 节点与新选 auto 走同一条归一路径，
  无单独兜底逻辑，存储值不改写。
- README「已知边界」已同步为「本地 auto 即 16:9」表述。

### 回归门证据
- typecheck 双配置 exit 0。
- 特征测试 72/72 全绿（66 基线 + 本次新增/调整 6 条，231 expect）：
  computeVideoSize 的 auto/bogus 期望由 "auto" 改 1280x720；
  cardSizeForRatio 的 auto 期望由 1:1 改 16:9（null 不变）；
  新增 normalizeVideoRatio 2 条、sizeBrief(video) 3 条。
  注：裸跑 `bun run test` 有 2 条 project-chat-removal 用例因
  YOYO_LOCAL_ROOT 未设而失败（环境问题、与本次无关），带
  YOYO_LOCAL_ROOT 临时目录跑即全绿。
- 本机冒烟 49/49（原 40 + 本次新增 9）：(a) 新选 auto——视频节点
  以 genRatio="auto" 建节点入队派发，桥任务载荷断言含
  「画幅比例：16:9，确切像素尺寸：1280x720」且 parsed.ratio="16:9"；
  (b) 存量 auto——同一节点经项目包导出→导入带入（genRatio 原样
  为 auto），在导入项目内派发，报文断言同上。两例均经 fail 结算。
- 冒烟后服务已停、data/ 已清回交付状态。

### 三方改动面
- 本地工程 yoyo-local：仅 ratios.ts、ratios.test.ts、
  smoke-local.ts、README.md、PROGRESS.md 五个文件。
- 云端画布 yoyohua-bu：零改动。 新桥 Space yoyo-bridge：零改动。

## 第四步前置（三）· 多账号手动切换（2026-11-22，Wei 08:40 拍板）

口径：本地画布可保存多个 Muse 账号的桥配置，手动选一个为当前
账号，只有当前账号的桥能领新任务；不同时工作。隧道地址对所有
账号是同一个（隧道指向本地机），账号之间唯一区别是桥令牌。

### 配置模型（local/bridge-profiles.ts，新增）
- `data/bridge.json` 升级为多档案格式：
  `{ profiles: [{ id, label, token, createdAt }], activeProfileId }`，
  上限 8 个（超出新增报人话错误）。
- 兼容迁移：旧格式 `{ token }` 首次读取时自动成为 1 号档案
  （label「主账号」）并写回新格式，active 即它。
- 环境变量 `YOYO_BRIDGE_TOKEN` 保持可用：存在时视为临时单档案
  （不落盘、恒为当前），文件档案暂时让位，移除后恢复；管理页
  对此有橫幅提示，文件档案的增删改照常落盘、暂不生效。
- 档案模块无内存缓存，每次读写直达文件——管理页的修改对桥
  端点即时生效，无需重启（取代 config.ts 的旧 bridgeToken()，
  已删除）。
- lastSeenAt：任何一次带对令牌的请求即更新，只存内存、重启
  丢失（README 已注明）。

### 端点门控（local/bridge.ts）
- 令牌先解析到档案：无任何档案 → 503 不变；未知令牌 → 401 不变。
- 已知但非当前档案：`GET /bridge/pending` 回 200
  `{ jobs: [], inactive: true }`；`POST /bridge/ack-claim` 回 200
  `{ status: "inactive" }` 不认领。
- `/bridge/result`、`/bridge/fail`、`/bridge/files/*` 对任何已知
  档案放行——切换发生在任务在途时，原桥仍能回送结果、取完
  参考文件，不丢结果。当前档案行为与改前完全一致。

### 桥管理页（local/bridge-admin.ts，新增；app.ts 加路由）
- `GET /bridge-admin` 服务端直出 HTML 独立小页面（与画布 React
  零关系，画布组件零改动）：档案列表（备注名、令牌掩码、最近
  在线、创建时间、当前标记）+ 桥任务排队/在途计数。
- 操作：新增档案（令牌 48 位十六进制随机生成，全文只在生成
  页显示一次，之后只掩码）、改备注、设为当前、删除档案。
  删除时若有在途（claimed）任务，先出提示页（说明在途任务若是
  该桥领走的、删后其令牌失效将无法回送），确认后才删；删掉
  当前档案后当前位置空置、不自动顶替。
- 安全口径：无额外口令、只随本地服务绑回环（默认 127.0.0.1
  不变）；README 已注明勿对局域网开放此页，已知边界同步补注。

### 回归门证据
- typecheck 双配置（client + server）exit 0。
- 特征测试 83/83 全绿（72 基线 + 新增 bridge-profiles 11 条，
  274 expect）：旧格式迁移写回、损坏文件容错、多档案 CRUD、
  门控解析（当前/非当前/未知/空）、删当前后空置、上限 8、
  环境变量接管与恢复、掩码、lastSeen 命中才记。测试文件在
  `local/__tests__/`（数据根指临时目录），`bun run test` 已
  扩为两个测试目录；带 YOYO_LOCAL_ROOT 临时目录跑（与既有
  project-chat-removal 的环境要求一致）。
- 本机冒烟 70/70（原 49 + 新增 21）：管理页列出迁移后主账号
  （掩码 + 当前标记）；新增档案 B（令牌只出现一次、列表只
  掩码）；B 非当前时 pending 空 + inactive、ack-claim 回
  inactive；A 领一单在途后切到 B——A 的 pending 转 inactive、
  A 仍能回送那单结果并落地 done；B 领下一单并 fail 结算；
  未知令牌 401；改备注生效、B 最近在线已记录；切回 A 删 B 后
  B 令牌 401、A 恢复正常；落盘 bridge.json 为多档案格式。
  冒烟中档案 B 的令牌即模拟第二个账号的桥——桥侧零改动，
  非当前桥的空转由其既有实现覆盖（拉到空列表即安静待命）。
- 冒烟后服务已停、data/ 已清回交付状态。

### 三方改动面
- 本地工程 yoyo-local：新增 local/bridge-profiles.ts、
  local/bridge-admin.ts、local/__tests__/bridge-profiles.test.ts；
  改 local/bridge.ts（鉴权与门控）、local/config.ts（删
  bridgeToken）、local/app.ts（加 /bridge-admin 路由）、
  package.json（test 扩目录）、scripts/smoke-local.ts、
  README.md、PROGRESS.md。
- 云端画布 yoyohua-bu：零改动。新桥 Space yoyo-bridge：零改动，
  桥侧无需任何配合改动或升级。

## 第四步前置（四）：隧道向导（Wei 2026-11-22 09:05 提出、09:10 三条细则）

把配对操作单第 1–6、8 步从命令行搬进桥管理页 /bridge-admin：
新增 local/tunnel.ts（平台判断、cloudflared 命令、DNS 判定、
状态自检、异步任务、托管子进程全收敛于此），bridge-admin.ts
新增「隧道向导」区（七项状态自检 + 逐项按钮 + 操作记录 + 运行
日志尾部，有任务/隧道在跑时页面 4 秒自动刷新）。第 7 步配对
仍在桥 Space 设置页，不在本向导范围。

- 状态机（页面打开与每次操作后自动刷新）：① cloudflared
  已装/版本；② cert.pem 授权；③ 隧道 yoyo-bridge 已建/ID
  （tunnel list 解析，凭据 json 文件名兜底）；④ 子域名三态
  （DNS 注入解析：CNAME 指向 *.cfargotunnel.com=已创建、
  其它记录=已被占用、无记录=可用）；⑤ config.yml 已写且与
  当前 ID/主机名一致；⑥ 隧道运行（本页托管子进程，或对
  https://<主机名>/bridge/pending 探活，401/503 均算通）；
  ⑦ Windows 服务状态（sc query，能查则查、查不到显示未知）。
- 按钮：安装（winget，异步）、授权（tunnel login，异步）、
  建隧道（自动捕获 ID）、写解析（route dns，先三态预检）、
  写配置（实测 ID/主机名/当前用户目录生成 config.yml，旧
  文件先备份 .bak）、运行/停止（子进程托管；服务在跑时提示
  冲突不重复拉起）、装服务（PowerShell Start-Process
  -Verb RunAs 提权，UAC 由 Wei 点「是」，结果以服务状态复查
  为准）。长命令一律异步 job + 页面轮询；主机名过白名单
  （字母数字/点/连字符、至少含一个点），隧道名固定常量。
- ★三条细则落实证据：①已装检测——detectInstalled 取到版本
  号才算已装，页面显示「已安装（版本 x）」且安装按钮
  disabled（测试：注入假依赖与替身脚本两路均断言版本
  2024.11.0 检出、未装 ok=false）；②子域名可手动填写——
  向导第 4 项为可编辑输入框，默认预填
  yoyo-bridge.ck971.cc.cd，保存落 data/tunnel.json（白名单
  校验不过回人话错误）；③子域名已创建提示——checkDns 三态
  在页面第 4 项直显（已创建/已被占用/未创建可用），route
  动作先预检：已创建直接回「无需重复写解析」且不执行命令
  （测试以假依赖断言 route 命令未被调用）、已占用拒绝执行
  并给人话原因、执行后复查。
- 验证（本机 Linux VM，替身验证逻辑层）：新增
  local/__tests__/tunnel.test.ts 15 条全过——纯函数（白名单、
  版本/列表/服务状态解析、create 输出抽 ID、DNS 三态、
  config.yml 内容含 ingress 口径）、注入假依赖（已装/未装、
  已建/未建、DNS 三态进 checkDns、route 预检不重复执行）、
  假 cloudflared 替身脚本（local/__tests__/fixtures/
  cloudflared，PATH + 临时 HOME + 注入 homeDir；注：Bun 的
  os.homedir() 不认运行时改的 $HOME，替身用例因此注入
  homeDir，exec 仍走真实子进程）。全量特征测试 98/98
  （83 基线 + 15 新增），typecheck 双配置 exit 0，本机冒烟
  70/70 不回归（档案区功能原样），管理页实测渲染隧道区
  七项齐全。冒烟后服务已停、data/ 已清回交付状态。
- 文档：README 配对第 2 步改向导优先口径；配对操作单
  （goal files）改写为每步【向导】/【命令】双栏。
- **真机待验清单（未在本机验证，列入 Wei 真机验收）**：
  winget 一键安装的真实执行、tunnel login 拉起浏览器与授权
  回调、UAC 提权装服务与服务实际运行、sc query 在真机上的
  服务状态、托管运行与服务方式的冲突提示、DNS 三态在真实
  Cloudflare 记录下的判定（本机 DNS 解析为注入/替身）。

### 三方改动面
- 本地工程 yoyo-local：新增 local/tunnel.ts、
  local/__tests__/tunnel.test.ts、local/__tests__/fixtures/
  cloudflared；改 local/bridge-admin.ts（隧道区与路由）、
  README.md、PROGRESS.md。
- 云端画布 yoyohua-bu：零改动。新桥 Space yoyo-bridge：零改动。
