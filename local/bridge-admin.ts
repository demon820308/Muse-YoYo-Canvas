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
  login: "授权（tunnel login",
  create: "建隧",
  route: "写子域名解析",
  config: "写 config.yml",
  service: "装 Windows 服务（开机自启）",
};

function badge(ok: boolean | null, okText = "已完", noText = "未完"): string {
  if (ok === null) return `<span class="muted">未知</span>`;
  return ok ? `<span class="current">✓ ${okText}</span>` : `<span class="muted">✗ ${noText}</span>`;
}

function tunnelSection(status: TunnelStatus, hostname: string): string {
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
  return `
<h2>隧道向导（cloudflared 把本地画布接到公网，只放 /bridge/*）</h2>
<p class="muted">把配对操作单第 1–6、8 步搬进页面：点按钮即可，失败会给出人话原因与可手动兜底的原始命令。第 7 步配对（把档案令牌填到桥 Space
设置页）仍在那边完成。</p>
<table><thead><tr><th>检查项</th><th>状态</th></tr></thead><tbody>
<tr><td>1. cloudflared 安装</td>
  <td>${badge(status.installed.ok)}</td>
  <td>${status.installed.ok
    ? `已安装（版本 ${esc(status.installed.version ?? "?")}）`
    : "未安"}
    <form class="inline" method="post" action="/bridge-admin/tunnel/install">
      <button type="submit"${dis(status.installed.ok)}>安装</button></form></td></tr>
<tr><td>2. Cloudflare 授权</td>
  <td>${badge(status.authorized)}</td>
  <td>${status.authorized ? "cert.pem 已存在（通行证就位）" : "尚未授权：点按钮后浏览器会打开 Cloudflare 登录页，选中域名 ck971.cc.cd 并点授权；列表里没有这个域名就先停下回报"}
    <form class="inline" method="post" action="/bridge-admin/tunnel/login">
      <button type="submit">授权</button></form></td></tr>
<tr><td>3. 隧道 yoyo-bridge</td>
  <td>${badge(status.tunnel.ok)}</td>
  <td>${status.tunnel.ok ? `已创建，ID：<code>` : "尚未创建"}
    <form class="inline" method="post" action="/bridge-admin/tunnel/create">
      <button type="submit"${dis(status.tunnel.ok)}>${status.tunnel.ok ? "已创建" : "建隧道"}</button></form></td></tr>
<tr><td>4. 子域名</td>
  <td>${badge(status.dns.state === "created" ? true : status.dns.state === "unknown" ? null : false)}</td>
  <td><form class="inline" method="post" action="/bridge-admin/tunnel/hostname">
      <input type="text" name="hostname" value="${esc(hostname)}" size="30">
      <button type="submit">保存并检测</button></form>
    <div>${esc(status.dns.detail)}</div>
    <form class="inline" method="post" action="/bridge-admin/tunnel/route">
      <button type="submit"${dis(status.dns.state === "created")}>写解析（route dns）</button></form></td></tr>
<tr><td>5. config.yml</td>
  <td>${badge(status.config.ok)}</td>
  <td>${esc(status.config.detail)}
    <form class="inline" method="post" action="/bridge-admin/tunnel/config">
      <button type="submit">写配置</button></form>
    <span class="muted">写入 ~/.cloudflared/config.yml，已有文件先备份为 .bak</span></td></tr>
<tr><td>6. 隧道运行</td>
  <td>${badge(status.running.ok)}</td>
  <td>${esc(status.running.detail)}
    <form class="inline" method="post" action="/bridge-admin/tunnel/run">
      <button type="submit">运行</button></form>
    <form class="inline" method="post" action="/bridge-admin/tunnel/stop">
      <button type="submit">停止（本页托管）</button></form></td></tr>
<tr><td>7. 开机自启（Windows 服务）</td>
  <td>${badge(status.service.state === "running" ? true : status.service.state === "unknown" ? null : false)}</td>
  <td>${esc(status.service.detail)}
    <form class="inline" method="post" action="/bridge-admin/tunnel/service">
      <button type="submit">装服务</button></form>
    <span class="muted">会弹管理员确认框（UAC），点「是」</span></td></tr>
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
  const tStatus = await tunnelWizard.status(hostname);
  const tunnelHtml = tunnelSection(tStatus, hostname);
  const busy = tunnelWizard.anyJobRunning() || tunnelWizard.childRunning();
  const body = `
<h1>桥账号管理 · 多账号手动切换</h1>
<p class="muted">本地可保存多个 Muse 账号的桥配置，手动选一个为当前账号。只有当前账号的桥能领新任务；其余账号的桥来拉任务时拿到空列表、安静空转。?切换时若有任务在途，原桥仍可把结果送回来（结果/失败/参考文件对任何已配对账号放行）。</p>
<p>桥任务现状：排队中 ${counts.queued} 个 · 在途（已领走未回送） ${counts.claimed} 个。</p>
${notice}
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

export async function handleBridgeAdmin(
  req: Request,
  url: URL,
  deps: Deps,
): Promise<Response> {
  const path = url.pathname;

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
          tunnelWizard.startCreate();
          return redirectToList();
        case "route":
          tunnelWizard.startRoute(hostname);
          return redirectToList();
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
          const msg = tunnelWizard.startRun();
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
