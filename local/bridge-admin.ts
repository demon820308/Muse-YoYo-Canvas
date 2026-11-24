// [yoyo-local] 桥账号管理页（多账号手动切换，Wei 2026-11-22 08:40
// 定版）：GET /bridge-admin，服务端直出 HTML 的独立小页面，与画布
// React 应用分离。功能：列出桥账号档案（备注名、令牌掩码、最近在线、当前标记），新增档案（生成令牌（全文只在生成当下显示
// 一次）、改备注、设为当前、删除档案。
//
// 安全口径与本地服务既有口径一致：只绑回环（默认 127.0.0.1），
// 无额外口令。若把本地服务改绑局域网，此页将无口令暴露——README
// 已注明勿对局域网开放此页

import { localBridgeJobs } from "../server/src/actions/bridge-jobs";
import type { Db } from "../server/src/actions/contracts";
import {
  isValidHostname,
  tunnelWizard,
  type JobKind,
  type TunnelStatus,
} from "./tunnel";
import {
  activateProfile,
  addProfile,
  deleteProfile,
  effectiveProfiles,
  getBridgeTelemetry,
  maskToken,
  profileLastSeenAt,
  readProfilesFile,
  renameProfile,
  type BridgeProfile,
} from "./bridge-profiles";
import type { LocalDb } from "./db";

type Deps = { db: LocalDb };

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtTime(ts: number | null): string {
  if (!ts) return "从未";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

const PAGE_STYLE = `
  :root {
    color-scheme: light;
    --bg: #e9e6df;
    --board: #e3ded4;
    --dot: #c9c2b2;
    --surface: #faf8f3;
    --surface-2: #fffdf8;
    --surface-3: #e9e4d8;
    --text: #262319;
    --dim: #6f6a5c;
    --border: #d5cfc0;
    --accent: #b97a1e;
    --accent-ink: #fffaf0;
    --accent-soft: #f3e3c2;
    --teal: #22705e;
    --teal-soft: #d3e8e0;
    --danger: #b3372c;
    --danger-soft: rgba(179, 55, 44, 0.12);
    --ok: #2f9e5f;
    --hover: rgba(38, 35, 25, 0.06);
    --shadow: 0 10px 30px rgba(38, 35, 25, 0.10);
    --radius: 12px;
    --font: "Avenir Next", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #101114;
      --board: #17181c;
      --dot: #26272e;
      --surface: #202228;
      --surface-2: #23242b;
      --surface-3: #2e3038;
      --text: #eceef2;
      --dim: #9aa0ad;
      --border: #2e3038;
      --accent: #e8a33d;
      --accent-ink: #241a08;
      --accent-soft: #3d2f16;
      --teal: #3fa08c;
      --teal-soft: #17332c;
      --danger: #e0655a;
      --danger-soft: rgba(224, 101, 90, 0.14);
      --ok: #4ec97d;
      --hover: rgba(255, 255, 255, 0.06);
      --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font);
    margin: 0;
    padding: 28px 16px 48px;
    color: var(--text);
    background-color: var(--board);
    background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px;
    line-height: 1.55;
    font-size: 14px;
  }
  .shell {
    max-width: 960px;
    margin: 0 auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 22px 26px 26px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 14px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
  }
  .back-link:hover { background: var(--hover); }
  h1 { font-size: 18px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 26px 0 10px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }
  h3 { font-size: 13.5px; font-weight: 600; margin: 16px 0 8px; color: var(--dim); }
  p { margin: 8px 0; }
  a { color: var(--accent); }
  table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-2);
    margin: 10px 0;
  }
  th, td {
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 9px 12px;
    text-align: left;
    vertical-align: top;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  th:last-child, td:last-child { border-right: none; }
  tr:last-child td { border-bottom: none; }
  td:nth-child(2) { white-space: nowrap; }
  @media (max-width: 680px) {
    body { padding: 12px 8px 32px; }
    .shell { padding: 14px 12px 18px; }
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  }
  th {
    background: var(--surface-3);
    color: var(--dim);
    font-weight: 600;
    font-size: 12px;
  }
  .banner {
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--text);
    border-radius: 10px;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 13px;
  }
  .error {
    border: 1px solid var(--danger);
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: 10px;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 13px;
  }
  .token {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    word-break: break-all;
    margin: 10px 0;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    background: var(--surface-3);
    padding: 2px 6px;
    border-radius: 5px;
  }
  pre {
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
    overflow-x: auto;
    margin: 6px 0 0;
  }
  details { margin-top: 6px; }
  summary { cursor: pointer; color: var(--dim); font-size: 12px; }
  form.inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  input[type="text"] {
    height: 30px;
    max-width: 100%;
    min-width: 0;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--accent); }
  button {
    height: 30px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-3);
    color: var(--text);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  button:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .muted { color: var(--dim); font-size: 12.5px; }
  .current { color: var(--ok); font-weight: 600; font-size: 12.5px; }
`;

function page(title: string, body: string, headExtra = ""): Response {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_STYLE}</style>${headExtra}</head>
<body><main class="shell">
  <div class="topbar">
    <a class="back-link" href="/">← 返回画布</a>
    <span class="muted">YoYo画布 · 本地桥控制台</span>
  </div>
  ${body}
</main></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function jobCounts(db: LocalDb): Promise<{ queued: number; claimed: number }> {
  const rows = await (db as unknown as Db)
    .select({ status: localBridgeJobs.status })
    .from(localBridgeJobs);
  return {
    queued: rows.filter((r) => r.status === "queued").length,
    claimed: rows.filter((r) => r.status === "claimed").length,
  };
}

function profileRow(
  profile: BridgeProfile,
  isActive: boolean,
): string {
  const lastSeen = fmtTime(profileLastSeenAt(profile.id));
  return `<tr data-profile-id="${esc(profile.id)}">
  <td>
    <form class="inline" method="post" action="/bridge-admin/rename">
      <input type="hidden" name="id" value="${esc(profile.id)}">
      <input type="text" name="label" value="${esc(profile.label)}" size="14">
      <button type="submit">改备注</button>
    </form>
    ${isActive ? '<div class="current">● 当前账号</div>' : ""}
  </td>
  <td><code>${esc(maskToken(profile.token))}</code></td>
  <td>${esc(lastSeen)}</td>
  <td>${esc(fmtTime(profile.createdAt || null))}</td>
  <td>
    ${isActive ? "" : `<form class="inline" method="post" action="/bridge-admin/activate">
      <input type="hidden" name="id" value="${esc(profile.id)}">
      <button type="submit">设为当前</button>
    </form>`}
    <form class="inline" method="post" action="/bridge-admin/delete">
      <input type="hidden" name="id" value="${esc(profile.id)}">
      <button type="submit">删除</button>
    </form>
  </td>
</tr>`;
}

const JOB_LABELS: Record<JobKind, string> = {
  install: "安装 cloudflared",
  login: "授权（tunnel login）",
  create: "建隧道",
  route: "写子域名解析",
  config: "写 config.yml",
  service: "装 Windows 服务（开机自启）",
  auto: "一键自动配置（4–8 步）",
};

function badge(ok: boolean | null, okText = "已完", noText = "未完"): string {
  if (ok === null) return `<span class="muted">未知</span>`;
  return ok ? `<span class="current">✓ ${okText}</span>` : `<span class="muted">✗ ${noText}</span>`;
}

function tunnelSection(
  status: TunnelStatus,
  hostname: string,
  activeLabel: string | null,
): string {
  const jobs = tunnelWizard.listJobs();
  const jobRows = jobs
    .map(
      (j) => `<tr><td>${esc(JOB_LABELS[j.kind])}</td>
  <td>${j.status === "running" ? "进行中…" : j.status === "done" ? "完成" : "失败"}</td>
  <td>${esc(j.message || "")}${j.output ? `<details><summary>输出</summary><pre>${esc(j.output)}</pre></details>` : ""}</td></tr>`,
    )
    .join("\n");
  const logTail = tunnelWizard.tunnelLogTail(20);
  const dis = (cond: boolean) => (cond ? " disabled" : "");
  const anyRunning = tunnelWizard.anyJobRunning();
  const remoteNoCred = status.tunnel.existsRemote && !status.tunnel.hasCredentials;
  const needOverwrite =
    status.dns.state === "mismatch" || status.e2e.needsDnsOverwrite;
  const tunnelDetail = status.tunnel.ok
    ? `已就绪，ID：<code>${esc(status.tunnel.id ?? "")}</code>（本地凭据 .json 已就位）`
    : remoteNoCred
      ? `<strong>云端已存在同名隧道（ID：<code>${esc(status.tunnel.id ?? "")}</code>），但本机缺少凭据 .json！</strong>请回第 3 步换一个新的子域名（例如加 <code>-pc2</code>）再建隧道。`
      : "尚未创建";
  const publicUrl = `https://${hostname}`;
  const hostnameLocked = status.tunnel.ok;
  const hostnameCell = hostnameLocked
    ? `<form class="inline" method="post" action="/bridge-admin/tunnel/hostname" id="hostname-form" onsubmit="return confirm('确认修改子域名？修改后需重新执行第 4–7 步（建隧道、写解析、写配置、重启服务），并同步更新云端 YoYo 桥里的隧道地址。')">
      <input type="text" id="hostname-input" name="hostname" value="${esc(hostname)}" data-orig="${esc(hostname)}" size="30" readonly style="opacity:0.75;cursor:not-allowed">
      <button type="button" id="hostname-edit-btn"${dis(anyRunning)} onclick="var i=document.getElementById('hostname-input');i.readOnly=false;i.style.opacity='1';i.style.cursor='text';i.focus();i.select();this.style.display='none';document.getElementById('hostname-save-btn').style.display='';document.getElementById('hostname-cancel-btn').style.display='';document.getElementById('hostname-warn').style.display='block';">修改</button>
      <button type="submit" id="hostname-save-btn" style="display:none"${dis(anyRunning)}>保存并检测</button>
      <button type="button" id="hostname-cancel-btn" style="display:none" onclick="var i=document.getElementById('hostname-input');i.value=i.getAttribute('data-orig')||'';i.readOnly=true;i.style.opacity='0.75';i.style.cursor='not-allowed';this.style.display='none';document.getElementById('hostname-save-btn').style.display='none';document.getElementById('hostname-edit-btn').style.display='';document.getElementById('hostname-warn').style.display='none';">取消</button>
    </form>
    <div id="hostname-warn" class="banner" style="display:none;margin-top:6px">⚠ 提醒：当前子域名已建好隧道。修改子域名后需要重新执行第 4–7 步（新建对应隧道、写解析、写配置、重启服务），并同步更新云端 YoYo 桥设置页里的隧道地址。</div>`
    : `<form class="inline" method="post" action="/bridge-admin/tunnel/hostname">
      <input type="text" name="hostname" value="${esc(hostname)}" size="30">
      <button type="submit"${dis(anyRunning)}>保存并检测</button></form>`;
  return `
<h2>隧道向导（cloudflared 把本地画布接到公网，只放 /bridge/*）</h2>
<p class="muted">按 1 → 8 顺序操作：前 3 步完成后，可直接点下方「一键完成 4–8 步」自动串联建隧道、写解析、写配置、装服务与公网体检。</p>
<div class="banner">
  <form class="inline" method="post" action="/bridge-admin/tunnel/auto">
    <button type="submit"${dis(!status.installed.ok || !status.authorized || remoteNoCred || anyRunning)}>一键完成 4–8 步</button>
  </form>
  <span class="muted">${!status.installed.ok ? "需先完成第 1 步安装" : !status.authorized ? "需先完成第 2 步授权" : remoteNoCred ? "当前子域名对应的隧道名已被旧机占用，请先在第 3 步更换子域名" : "将自动执行：建隧道 → 覆盖写解析 → 写 config.yml → 装服务 → 端到端体检"}</span>
</div>
<table><thead><tr><th>步骤</th><th>状态</th><th>详情与操作</th></tr></thead><tbody>
<tr><td>1. cloudflared 安装</td>
  <td>${badge(status.installed.ok)}</td>
  <td>${status.installed.ok
    ? `已安装（版本 ${esc(status.installed.version ?? "?")}）`
    : "未安装"}
    <form class="inline" method="post" action="/bridge-admin/tunnel/install">
      <button type="submit"${dis(status.installed.ok || anyRunning)}>安装</button></form></td></tr>
<tr><td>2. Cloudflare 授权</td>
  <td>${badge(status.authorized)}</td>
  <td>${status.authorized ? "cert.pem 已存在（通行证就位）" : "尚未授权：点按钮后浏览器会打开 Cloudflare 登录页，选中域名 ck971.cc.cd 并点授权"}
    <form class="inline" method="post" action="/bridge-admin/tunnel/login">
      <button type="submit"${dis(!status.installed.ok || anyRunning)}>授权</button></form></td></tr>
<tr><td>3. 设定本机子域名</td>
  <td>${badge(isValidHostname(hostname), "已设", "未设")}</td>
  <td>${hostnameCell}
    <div class="muted">将使用子域名前缀作为本机独立隧道名：<code>${esc(status.tunnel.name)}</code>（每台机器填不同子域名即可互不冲突）</div></td></tr>
<tr><td>4. 隧道 ${esc(status.tunnel.name)}</td>
  <td>${badge(status.tunnel.ok)}</td>
  <td>${tunnelDetail}
    <form class="inline" method="post" action="/bridge-admin/tunnel/create">
      <button type="submit"${dis(!status.authorized || status.tunnel.ok || remoteNoCred || anyRunning)}>${status.tunnel.ok ? "已就绪" : "建隧道"}</button></form></td></tr>
<tr><td>5. 子域名解析（DNS）</td>
  <td>${badge(status.dns.state === "created" ? true : status.dns.state === "unknown" ? null : false)}</td>
  <td>${esc(status.dns.detail)}
    <form class="inline" method="post" action="${needOverwrite ? "/bridge-admin/tunnel/route-overwrite" : "/bridge-admin/tunnel/route"}">
      <button type="submit"${dis(!status.tunnel.ok || (!needOverwrite && status.dns.state === "created") || anyRunning)}>${needOverwrite ? "覆盖写解析（--overwrite-dns）" : "写解析（route dns）"}</button></form></td></tr>
<tr><td>6. config.yml</td>
  <td>${badge(status.config.ok)}</td>
  <td>${esc(status.config.detail)}
    <form class="inline" method="post" action="/bridge-admin/tunnel/config">
      <button type="submit"${dis(!status.tunnel.ok || anyRunning)}>写配置</button></form>
    <span class="muted">写入 ~/.cloudflared/config.yml，已有文件先备份为 .bak</span></td></tr>
<tr><td>7. 隧道运行 / 开机自启</td>
  <td>${badge(status.service.state === "running" || status.running.ok ? true : status.service.state === "unknown" ? null : false)}</td>
  <td><div>运行态：${esc(status.running.detail)} · Windows 服务：${esc(status.service.detail)}</div>
    <form class="inline" method="post" action="/bridge-admin/tunnel/service">
      <button type="submit"${dis(!status.config.ok || anyRunning)}>装服务（开机自启）</button></form>
    <form class="inline" method="post" action="/bridge-admin/tunnel/run">
      <button type="submit"${dis(!status.config.ok || anyRunning)}>前台运行</button></form>
    <form class="inline" method="post" action="/bridge-admin/tunnel/stop">
      <button type="submit">停止（本页托管）</button></form>
    <span class="muted">装服务会弹 UAC，点「是」</span></td></tr>
<tr><td>8. 端到端公网体检</td>
  <td>${badge(status.e2e.ok, "已通", "未通")}</td>
  <td><div>${esc(status.e2e.detail)}</div>
    <div>云端 YoYo 桥填写地址：<code>${esc(publicUrl)}</code>
      <button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(publicUrl)}').then(()=>{this.textContent='已复制';setTimeout(()=>{this.textContent='复制地址'},1500)})">复制地址</button>
      ${activeLabel ? `<span class="muted">（当前启用账号：${esc(activeLabel)}）</span>` : `<span class="muted">（请先在上方新增并启用一个桥账号）</span>`}
    </div>
    ${status.e2e.needsDnsOverwrite ? `<form class="inline" method="post" action="/bridge-admin/tunnel/route-overwrite"><button type="submit"${dis(!status.tunnel.ok || anyRunning)}>一键覆盖解析修复 530</button></form>` : ""}
    <a href="/bridge-admin"><button type="button">重新体检</button></a></td></tr>
</tbody></table>
${logTail.length ? `<h3>隧道运行日志（最近）</h3><pre>${esc(logTail.join("\n"))}</pre>` : ""}
${jobs.length ? `<h3>向导操作记录</h3><table><thead><tr><th>操作</th><th>状态</th><th>结果</th></tr></thead><tbody>${jobRows}</tbody></table>` : ""}`;
}

async function renderList(deps: Deps, notice = ""): Promise<Response> {
  const file = readProfilesFile();
  const eff = effectiveProfiles();
  const counts = await jobCounts(deps.db);
  const rows = file.profiles
    .map((p) => profileRow(p, !eff.envDriven && p.id === file.activeProfileId))
    .join("\n");
  const envBanner = eff.envDriven
    ? `<div class="banner">当前由环境变量 <code>YOYO_BRIDGE_TOKEN</code> 临时接管。       桥端点只认环境变量里的令牌，下方文件档案暂时让位；增删改照常落盘；       移除环境变量并重启后生效。</div>`
    : "";
  const hostname = tunnelWizard.savedHostname();
  const activeProfile =
    eff.profiles.find((p) => p.id === eff.activeProfileId) ?? null;
  const tStatus = await tunnelWizard.status(hostname, activeProfile?.token ?? null);
  let autoHealNotice = "";
  if (
    tStatus.tunnel.ok &&
    tStatus.config.ok &&
    !tStatus.running.ok &&
    tStatus.service.state !== "running" &&
    !tunnelWizard.anyJobRunning() &&
    !tunnelWizard.isManuallyStopped()
  ) {
    void tunnelWizard.ensureRunning(hostname).catch(() => {});
    autoHealNotice = `<div class="banner">检测到本地隧道未运行，正在后台自动重连，页面将自动刷新…</div>`;
  }
  const tunnelHtml = tunnelSection(tStatus, hostname, activeProfile?.label ?? null);
  const busy =
    tunnelWizard.anyJobRunning() ||
    (tunnelWizard.childRunning() && !tStatus.e2e.ok) ||
    tunnelWizard.isHealing() ||
    autoHealNotice !== "";
  const body = `
<h1>桥账号管理 · 多账号手动切换</h1>
<p class="muted">本地可保存多个 Muse 账号的桥配置，手动选一个为当前账号。只有当前账号的桥能领新任务；其余账号的桥来拉任务时拿到空列表、安静空转。?切换时若有任务在途，原桥仍可把结果送回来（结果/失败/参考文件对任何已配对账号放行）。</p>
<p>桥任务现状：排队中 ${counts.queued} 个 · 在途（已领走未回送） ${counts.claimed} 个。</p>
${notice}${autoHealNotice}
${envBanner}
<h2>账号档案：${file.profiles.length} 个）</h2>
${file.profiles.length === 0
    ? "<p>还没有任何档案。先在下方新增一个，拿到令牌后去那个账号的「YoYo桥」设置页配对。</p>"
    : `<table><thead><tr><th>备注名</th><th>令牌（掩码）</th><th>最近在线</th><th>创建时间</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody></table>`}
<h2>新增档案</h2>
<form method="post" action="/bridge-admin/add">
  <input type="text" name="label" placeholder="备注名（可空，如：备用账号）" size="24">
  <button type="submit">生成新档案</button>
</form>
<p class="muted">新令牌只在生成后显示一次全文，之后只显示掩码，请当场复制保存。?每个账号一个档案：在那个账号的「YoYo桥」设置页填同一个隧道地址 + 该档案的令牌，?回到本页把它「设为当前」即完成切换。</p>
${tunnelHtml}
<p class="muted">本页无口令，只应通过本机回环访问；本地服务默认绑 127.0.0.1，?请勿把本页对局域网开放。「最近在线」是内存记录，本地服务重启后清零。</p>`;
  return page(
    "桥账号管",
    body,
    busy ? '<meta http-equiv="refresh" content="4">' : "",
  );
}

function renderCreated(profile: BridgeProfile): Response {
  const body = `
<h1>新档案已生成：${esc(profile.label)}</h1>
<p>这是该账号的桥令牌，<strong>全文只显示这一次</strong>，请立即复制保存。</p>
<div class="token">${esc(profile.token)}</div>
<p>接下来：打开那个 Muse 账号的「YoYo桥」设置页，地址填与其它账号相同的隧道地址，令牌粘贴上面这串并保存；回到本页把这个档案「设为当前」，生成
即切换到该账号。</p>
<p><a href="/bridge-admin">← 返回档案列表</a></p>`;
  return page("新桥令牌（只显示一次）", body);
}

function renderDeleteWarning(profile: BridgeProfile, claimed: number): Response {
  const body = `
<h1>删除档案：${esc(profile.label)}」？</h1>
<div class="banner">当前有 <strong>${claimed}</strong> 个任务在途（已被某个桥领走，还没回送结果）。若在途任务正是这个账号的桥领走的，删除档案后它的令牌立即
失效，结果将无法送回（任务会一直停在在途，直到人工处理）。</div>
<p>确认仍要删除吗？</p>
<form method="post" action="/bridge-admin/delete">
  <input type="hidden" name="id" value="${esc(profile.id)}">
  <input type="hidden" name="confirm" value="1">
  <button type="submit">仍要删除</button>
</form>
<p><a href="/bridge-admin">← 取消，返回列表</a></p>`;
  return page("删除档案确认", body);
}

function redirectToList(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/bridge-admin" },
  });
}

async function formField(req: Request, name: string): Promise<string> {
  const data = await req.formData();
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function tunnelError(deps: Deps, err: unknown): Promise<Response> {
  return renderList(
    deps,
    `<div class="error">${esc(err instanceof Error ? err.message : String(err))}</div>`,
  );
}

const SUMMARY_TTL_MS = 30_000;
let cachedTunnelStatus: { hostname: string; at: number; status: TunnelStatus } | null = null;

function invalidateSummaryCache(): void {
  cachedTunnelStatus = null;
}

async function getDiagnosis(_deps: Deps, forceFresh = false) {
  const hostname = tunnelWizard.savedHostname();
  const eff = effectiveProfiles();
  const active = eff.profiles.find((p) => p.id === eff.activeProfileId) ?? null;
  const now = Date.now();
  const useCache =
    !forceFresh &&
    !tunnelWizard.anyJobRunning() &&
    cachedTunnelStatus !== null &&
    cachedTunnelStatus.hostname === hostname &&
    now - cachedTunnelStatus.at < SUMMARY_TTL_MS;
  const cachedStatus = useCache ? cachedTunnelStatus!.status : undefined;
  const diagnosis = await tunnelWizard.diagnose(hostname, {
    activeProfile: active,
    profileLastSeenAt: active ? profileLastSeenAt(active.id) : null,
    envDriven: eff.envDriven,
    telemetry: getBridgeTelemetry(),
    cachedStatus,
  });
  if (!useCache && diagnosis.state !== "connecting") {
    cachedTunnelStatus = { hostname, at: now, status: diagnosis.status };
  }
  return { hostname, eff, active, diagnosis };
}

async function handleBridgeApi(
  req: Request,
  path: string,
  deps: Deps,
): Promise<Response> {
  if (req.method === "GET" && path === "/bridge-admin/api/summary") {
    const { hostname, active, diagnosis } = await getDiagnosis(deps, false);
    return Response.json({
      state: diagnosis.state,
      label: diagnosis.label,
      summary: diagnosis.summary,
      hostname,
      activeProfile: active
        ? {
            id: active.id,
            label: active.label,
            maskedToken: maskToken(active.token),
            lastSeenAt: profileLastSeenAt(active.id),
            everConnectedAt: active.everConnectedAt ?? null,
          }
        : null,
      jobRunning: tunnelWizard.anyJobRunning(),
    });
  }

  if (req.method === "GET" && path === "/bridge-admin/api/state") {
    const { hostname, eff, diagnosis } = await getDiagnosis(deps, false);
    const counts = await jobCounts(deps.db);
    return Response.json({
      hostname,
      envDriven: eff.envDriven,
      activeProfileId: eff.activeProfileId,
      profiles: eff.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        maskedToken: maskToken(p.token),
        createdAt: p.createdAt,
        lastSeenAt: profileLastSeenAt(p.id),
        everConnectedAt: p.everConnectedAt ?? null,
      })),
      diagnosis,
      jobs: tunnelWizard.listJobs(),
      tunnelLogTail: tunnelWizard.tunnelLogTail(),
      counts,
      telemetry: getBridgeTelemetry(),
      childRunning: tunnelWizard.childRunning(),
      manualStop: tunnelWizard.isManuallyStopped(),
    });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/diagnose") {
    invalidateSummaryCache();
    const { diagnosis } = await getDiagnosis(deps, true);
    return Response.json({ diagnosis });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/wizard/start") {
    const body = (await req.json().catch(() => null)) as
      | { label?: string; hostname?: string }
      | null;
    const hostname = (body?.hostname ?? "").trim().toLowerCase();
    if (!isValidHostname(hostname)) {
      return Response.json(
        { error: "子域名格式不对：只许字母、数字、点、连字符，且至少含一个点" },
        { status: 400 },
      );
    }
    const label = (body?.label ?? "").trim() || "主账号";
    invalidateSummaryCache();
    tunnelWizard.saveHostname(hostname);

    let plainToken: string | null = null;
    const eff = effectiveProfiles();
    let activeId = eff.activeProfileId;
    if (!eff.envDriven) {
      const existing = eff.profiles.find((p) => p.label === label);
      if (existing) {
        activateProfile(existing.id);
        activeId = existing.id;
        plainToken = existing.token;
      } else {
        const created = addProfile(label);
        activateProfile(created.id);
        activeId = created.id;
        plainToken = created.token;
      }
    } else {
      plainToken = eff.profiles[0]?.token ?? null;
    }

    const job = tunnelWizard.startAutoSetup(hostname, plainToken);
    return Response.json({
      job,
      hostname,
      activeProfileId: activeId,
      plainToken,
    });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/fix") {
    const body = (await req.json().catch(() => null)) as
      | { fixId?: string; confirm?: boolean }
      | null;
    const hostname = tunnelWizard.savedHostname();
    invalidateSummaryCache();
    const eff = effectiveProfiles();
    const active = eff.profiles.find((p) => p.id === eff.activeProfileId) ?? null;

    let fixId = body?.fixId ?? "auto-safe";
    if (fixId === "auto-safe") {
      const { diagnosis } = await getDiagnosis(deps, true);
      const firstFix = diagnosis.layers.find(
        (l) =>
          l.status === "error" &&
          l.fixAction &&
          !l.fixAction.dangerous &&
          l.fixAction.id !== "goto-wizard",
      )?.fixAction;
      if (!firstFix) {
        return Response.json({
          ok: false,
          message: "没有可自动修复的安全项，请查看下方逐层说明",
        });
      }
      fixId = firstFix.id;
    }

    if (fixId.startsWith("activate-profile:")) {
      const targetId = fixId.slice("activate-profile:".length);
      activateProfile(targetId);
      return Response.json({ ok: true, message: "已切换当前启用账号" });
    }
    if (fixId === "stop-tunnel") {
      return Response.json({ ok: true, message: tunnelWizard.stopRun() });
    }
    if (fixId === "overwrite-dns" && !body?.confirm) {
      return Response.json(
        { error: "覆盖写解析需要确认", needsConfirm: true },
        { status: 400 },
      );
    }
    const res = await tunnelWizard.applyFix(fixId, hostname, active?.token ?? null);
    return Response.json(res, { status: res.ok ? 200 : 400 });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/profiles/add") {
    const body = (await req.json().catch(() => null)) as { label?: string } | null;
    invalidateSummaryCache();
    const profile = addProfile(body?.label?.trim() || undefined);
    return Response.json({
      profile: {
        id: profile.id,
        label: profile.label,
        maskedToken: maskToken(profile.token),
        createdAt: profile.createdAt,
      },
      plainToken: profile.token,
    });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/profiles/activate") {
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) return Response.json({ error: "缺少 id" }, { status: 400 });
    invalidateSummaryCache();
    activateProfile(body.id);
    return Response.json({ ok: true });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/profiles/rename") {
    const body = (await req.json().catch(() => null)) as
      | { id?: string; label?: string }
      | null;
    if (!body?.id) return Response.json({ error: "缺少 id" }, { status: 400 });
    renameProfile(body.id, body.label ?? "");
    return Response.json({ ok: true });
  }

  if (req.method === "POST" && path === "/bridge-admin/api/profiles/delete") {
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) return Response.json({ error: "缺少 id" }, { status: 400 });
    invalidateSummaryCache();
    deleteProfile(body.id);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function handleBridgeAdmin(
  req: Request,
  url: URL,
  deps: Deps,
): Promise<Response> {
  const path = url.pathname;

  if (path.startsWith("/bridge-admin/api/")) {
    try {
      return await handleBridgeApi(req, path, deps);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  }

  if (req.method === "GET" && (path === "/bridge-admin" || path === "/bridge-admin/")) {
    return renderList(deps);
  }

  if (req.method === "POST" && path.startsWith("/bridge-admin/tunnel/")) {
    const action = path.slice("/bridge-admin/tunnel/".length);
    try {
      const hostname = tunnelWizard.savedHostname();
      switch (action) {
        case "hostname": {
          const value = (await formField(req, "hostname")).trim().toLowerCase();
          if (!isValidHostname(value)) {
            throw new Error(
              "子域名格式不对：只许字母、数字、点、连字符，且至少含一个点",
            );
          }
          tunnelWizard.saveHostname(value);
          return redirectToList();
        }
        case "install":
          tunnelWizard.startInstall();
          return redirectToList();
        case "login":
          tunnelWizard.startLogin();
          return redirectToList();
        case "create":
          tunnelWizard.startCreate(hostname);
          return redirectToList();
        case "route":
          tunnelWizard.startRoute(hostname, false);
          return redirectToList();
        case "route-overwrite":
          tunnelWizard.startRoute(hostname, true);
          return redirectToList();
        case "auto": {
          const eff = effectiveProfiles();
          const active =
            eff.profiles.find((p) => p.id === eff.activeProfileId) ?? null;
          tunnelWizard.startAutoSetup(hostname, active?.token ?? null);
          return redirectToList();
        }
        case "config":
          tunnelWizard.startWriteConfig(hostname);
          return redirectToList();
        case "service":
          tunnelWizard.startServiceInstall();
          return redirectToList();
        case "run": {
          const svc = await tunnelWizard.detectService();
          if (svc.state === "running") {
            return renderList(
              deps,
              `<div class="banner">Cloudflared 已由 Windows 服务在运行，不再重复拉起（重复运行会冲突）。</div>`,
            );
          }
          const msg = tunnelWizard.startRun(hostname);
          return renderList(deps, `<div class="banner">${esc(msg)}</div>`);
        }
        case "stop": {
          const msg = tunnelWizard.stopRun();
          return renderList(deps, `<div class="banner">${esc(msg)}</div>`);
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      return tunnelError(deps, err);
    }
  }

  if (req.method === "POST" && path === "/bridge-admin/add") {
    try {
      const label = await formField(req, "label");
      const profile = addProfile(label || undefined);
      return renderCreated(profile);
    } catch (err) {
      return renderList(
        deps,
        `<div class="error">${esc(err instanceof Error ? err.message : String(err))}</div>`,
      );
    }
  }

  if (req.method === "POST" && path === "/bridge-admin/rename") {
    try {
      const data = await req.formData();
      renameProfile(String(data.get("id") ?? ""), String(data.get("label") ?? ""));
      return redirectToList();
    } catch (err) {
      return renderList(
        deps,
        `<div class="error">${esc(err instanceof Error ? err.message : String(err))}</div>`,
      );
    }
  }

  if (req.method === "POST" && path === "/bridge-admin/activate") {
    try {
      activateProfile(await formField(req, "id"));
      return redirectToList();
    } catch (err) {
      return renderList(
        deps,
        `<div class="error">${esc(err instanceof Error ? err.message : String(err))}</div>`,
      );
    }
  }

  if (req.method === "POST" && path === "/bridge-admin/delete") {
    try {
      const data = await req.formData();
      const id = String(data.get("id") ?? "");
      const confirmed = data.get("confirm") === "1";
      const file = readProfilesFile();
      const profile = file.profiles.find((p) => p.id === id);
      if (!profile) throw new Error("要删除的档案不存");
      if (!confirmed) {
        const counts = await jobCounts(deps.db);
        if (counts.claimed > 0) return renderDeleteWarning(profile, counts.claimed);
      }
      deleteProfile(id);
      return redirectToList();
    } catch (err) {
      return renderList(
        deps,
        `<div class="error">${esc(err instanceof Error ? err.message : String(err))}</div>`,
      );
    }
  }

  return new Response("not found", { status: 404 });
}
