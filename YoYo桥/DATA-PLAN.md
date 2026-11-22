# Data Plan

## Context provenance
- `新建一个独立的桥 Space「YoYo桥」…桥任务是自包含记录，没有影子项目/影子节点` (verbatim build request; defines the whole scope: standalone bridge, no canvas tables/UI)
- `本地契约（不可变，本地端已上线）` five endpoints + chunk protocol + x-bridge-token (verbatim build request; transport layer must match byte-for-byte semantics)
- `第三步桥域已完成…全链探针在正式环境真跑通了` (parent conversation; the canvas-space bridge implementation in yoyohua-bu is the proven reference to port from, minus shadow project/nodes)
- Local endpoint implementation at ~/workspace/yoyo-local/local/bridge.ts (429 lines, read during planning) confirms the peer side: Range 206 + Content-Range downloads, chunked result upload with duplicate/409 handling, 503 bridge_not_configured when unpaired, 401 on token mismatch.

## Tested sources
### Canvas-space bridge implementation (port source, same machine)
**Used by**: bridgeSync / bridgeFastSync / bridgeSetConfig / bridgeStatus / completeBridgeJob / failBridgeJob
**Test command**: `wc -l + read of ~/workspace/ts-spaces/yoyohua-bu/server/src/actions/bridge-store.ts, bridge-transport.ts, bridge.ts, bridge-deliver.ts, ratios.ts, generation-dispatch.ts, privileged.ts and drizzle/0015_bridge_domain.sql`
**Sample output**: bridge-store 301 lines (guarded state machine queued→working/done/failed, working→done/failed/delivered, done→failed/delivered, failed→delivered, delivered→cleaned; DB lease TTL 300s; maskBridgeToken 3 forms); bridge-transport 318 lines (normalizeBridgeBaseUrl, 60s timeout, BridgeUnreachableError/BridgeAuthError classification, Range download with Content-Range validation + 256MB cap + 2 retries, chunked postResultMedia); ratios.ts eight tiers 16:9=2048x1152, 9:16=1152x2048, 1:1=1600x1600, 3:2=1920x1280, 2:3=1280x1920, 4:3=1792x1344, 3:4=1344x1792, 21:9=2352x1008 with log-distance normalization; generation-dispatch spawn message templates for image/video/audio.
**Processing**: Port store+transport nearly verbatim; drop shadowProjectId/shadowNodeId and all canvas graph code; jobs become self-contained rows carrying payload + result fields per the work order's 0001 schema; executor dispatches per kind (generate_media direct, inference for text/prompt-reverse, spawnTask with completeBridgeJob/failBridgeJob callbacks for task-*); follow-up delivers from the job row's own result fields and cleans the per-job directory instead of a shadow graph.

### Local bridge peer (~/workspace/yoyo-local/local/bridge.ts)
**Used by**: transport contract verification
**Test command**: `head -n 120 ~/workspace/yoyo-local/local/bridge.ts`
**Sample output**: Five endpoints documented in header; token via timingSafeEqual; unpaired → 503 {error: bridge_not_configured}; Range support returns 206 + Content-Range; chunked result: intermediate chunks {status: chunk_received}, resend → duplicate, out-of-order → 409, final chunk triggers landing or 422 {status: failed}.
**Processing**: No code copied; used only to confirm the cloud-side transport semantics match the already-deployed local side.

### Privileged handlers (canvas space)
**Used by**: new space's server/src/privileged.ts (job-dir handlers rooted at ~/workspace/yoyo-bridge-jobs)
**Test command**: `read ~/workspace/ts-spaces/yoyohua-bu/server/src/privileged.ts (361 lines) + privileged/files.ts, media-image.ts, media-common.ts`
**Sample output**: Contracts readMediaFile/writeProjectFile/probeMediaFile/mirrorBlobToFile/convertImageToPng/shrinkImageForInference/deleteProjectFile with fs.read/fs.write/process.exec capabilities; handlers enforce root-containment and reject escapes.
**Processing**: Port only the nine job-dir contracts named in the work order (ensureJobDir, writeJobFile, readJobFile, probeJobFile, deleteJobFile, deleteJobDir, mirrorBlobToJobFile, convertImageToPng, shrinkImageForInference), changing the root constant to ~/workspace/yoyo-bridge-jobs and dir addressing from project dirs to per-job dirName; every path validated inside the root.

## Generation channel lock (2026-11-22 edit)
- `不要用我minimax token plan里的啊。我服了。直接把这条线永久掐了` (verbatim user request, 2026-11-22): a bridge task-video job's spawned task had burned the user's MiniMax Token Plan daily video quota (2056 cap; MiniMax-H3 separately 2068 plan-excluded) because the spawn brief named no generation channel, leaving the background task free to pick the custom.minimax-cn connector.
- Fix in `server/src/bridge-executor.ts`: `buildTaskMessage` now hard-locks the channel in every task-image/task-video/task-audio brief — Muse built-in generation pipeline only (media.generate_image / media.generate_video); MiniMax Token Plan permanently forbidden (custom.minimax-cn connector, api.minimaxi.com generation endpoints, Hailuo/MiniMax-H3/image-01 models, minimax_*.py helpers); when the built-in pipeline cannot do the job the task must call failBridgeJob instead of falling back to any user-quota channel. direct-image already used the built-in `ctx.tool.generate_media` and is unchanged. The matching ban is also recorded at the top of `~/workspace/custom-connectors/custom.minimax-cn/CONNECTOR.md` (done by the main agent).

## Clear failed records (2026-11-22 edit)
- `把yoyo桥失败的记录清除` (verbatim user request, 2026-11-22): the failed generation record the user pasted (task-video, status 已清理, carrying the long MiniMax-quota failure error) stays visible because cleanup slimming keeps the `error` column as a ledger fact.
- Definition used by `bridgeClearFailed` / `bridgeStatus.clearableFailed` (in `server/src/bridge-store.ts`): a record is clearable when `status='failed'`, or `status IN ('cleaned','delivered') AND error IS NOT NULL`. Successful cleaned rows (error null) and in-flight rows (queued/working/done) are never touched.
- Action hard-deletes those rows and best-effort deletes each job directory via `Contracts.deleteJobDir`; the settings page exposes it behind an in-page confirm, and the same action is declared as the post-submit action so the records already in the production ledger are cleared once on deploy.

## Orphan queued reconciliation (2026-11-22 edit)
- `不止要清。你还要修复这个问题。` (verbatim user request, 2026-11-22): job a383ee06 (task-video) was stopped in the local canvas after the bridge had inserted it as `queued` but before it was ever acked/dispatched. It vanished from the local `/bridge/pending` list, and no bridge code path ever touched it again — `claimAndDispatch` only iterates jobs the local side currently returns, `followUpInFlight` only handles working/done/failed — so the row froze in 待处理 with `updatedAt` stuck at the local stop time. The row itself was settled manually by the main agent before this fix; this edit fixes the mechanism.
- Fix in `server/src/bridge-deliver.ts` (`reconcileOrphanedQueued`), wired into the full sync round in `server/src/actions.ts` right after `claimAndDispatch`: using THIS round's successful `/bridge/pending` fetch as the authoritative local pending set, any `queued` row absent from that set and untouched for ≥60s (`ORPHANED_QUEUED_GRACE_MS`, so rows merely waiting behind the per-round claim cap or mid-retry are never settled) transitions `queued → failed` with error `本地已取消该任务：桥侧对账时本地待处理列表已无此任务，自动结算（未执行）`. The same round's follow-up then delivers that failure via the normal `/bridge/fail` path and walks the row to `cleaned`, identical to the manual settles the user already accepted. Cap: 10 reconciliations per round.
- Safety properties: reconciliation only runs in full rounds after a successful pending fetch — when the local side is unreachable/auth-failing the round returns `skipped` before reconciling, so absence is never inferred from a failed fetch; fast rounds never reconcile (they fetch no pending list). Covered by unit + end-to-end tests in `server/src/__tests__/bridge.test.ts` (fake local bridge via Bun.serve: empty pending → orphan settles failed → fail posted → cleaned).

## Long-term data behavior
- **Refresh policy**: No cron in this build (none requested in refresh_triggers); bridgeSync/bridgeFastSync are invoked by the platform scheduler configured outside this artifact / manually (both set to 5s intervals on 2026-11-22). The settings page refetches bridgeStatus on load, after every save, and polls it every 5 seconds while visible (2026-11-22 edit: user could not see short-lived 待处理/执行中/待回送 states because the page only fetched once on load; `refetchInterval: 5000`, paused in background tabs).
- **Growth**: bridge_jobs rows are slimmed on cleanup (payload → '{}', result_text/result_file_path cleared) and kept as an audit ledger; bridge_config is a single row (id='bridge').
- **Ordering**: Follow-up processes working/done/failed rows by created_at ascending, max 10 per round; claims max 3 new jobs per full round; recentJobs in bridgeStatus are the newest 10.
- **Time semantics**: Timestamps stored as integer ms in DB per the work-order schema; bridgeStatus converts to ISO strings for display; lease TTL 300s compared against Date.now().

## Imagery
Imagery not needed: the only page is a utilitarian pairing/status console specified as '极简单页…使用平台默认组件口径即可'; it renders no photos or illustrations, and bridge media payloads are cargo files in job directories, never displayed.

## Rejected approaches
- **Tried**: Reusing the canvas space's shadow-project execution model
  **Why rejected**: The work order explicitly forbids shadow projects/nodes in this space; jobs are self-contained records, so task-* execution goes through spawnTask briefs pointing at the per-job directory with completeBridgeJob/failBridgeJob as the return actions.
- **Tried**: Declaring the tunnel host in declared_hosts
  **Why rejected**: The peer base URL is user-configured at pairing time (a Cloudflare tunnel hostname that does not exist yet); there is no fixed host to declare. All outbound fetch goes through the single bridge-transport module to that configured URL only.
