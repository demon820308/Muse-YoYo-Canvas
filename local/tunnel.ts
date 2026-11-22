// [yoyo-local] 隧道向导（Wei 2026-11-22 09:05 提出的 9:10 细则）：
// 把配对操作单第 1–6、8 步从命令行搬进桥管理页点按钮完成。本模块
// 是唯一收敛点：平台判断、cloudflared 命令执行、DNS 判定、状态自检、异步任务、托管子进程都在这里；bridge-admin.ts 只负责渲染与路由。纪律：主机名/隧道名过白名单校验后才进命令参数；长命令一律异步 + 状态查询；全部能力只随本地服务绑回环暴露（与管理页既有口径一致）。
// ★细则落实：
//   一、cloudflared 已安装（能取到版本号）→ 显示已安装、安装按钮禁用；//   二、子域名可手动填写（默认预填 yoyo-bridge.ck971.cc.cd）；
//   三、子域名若已被创建（CNAME 指向 *.cfargotunnel.com）→ 页面
//       提示，route dns 不再重复执行

import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { resolve as resolveDnsCname } from "node:dns/promises";
import { resolve4, resolve6 } from "node:dns/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { DATA_DIR } from "./config";
import {
  buildConfigYml,
  classifyDns,
  DEFAULT_HOSTNAME,
  extractTunnelId,
  isValidHostname,
  parseServiceState,
  parseTunnelList,
  parseVersionOutput,
  TUNNEL_NAME,
  type DnsRecords,
  type DnsState,
  type TunnelInfo,
} from "./tunnel-parsers";

export {
  buildConfigYml,
  classifyDns,
  DEFAULT_HOSTNAME,
  extractTunnelId,
  isValidHostname,
  parseServiceState,
  parseTunnelList,
  parseVersionOutput,
  TUNNEL_NAME,
  type DnsRecords,
  type DnsState,
  type TunnelInfo,
};

const TUNNEL_FILE = resolve(DATA_DIR, "tunnel.json");

export type ExecResult = { code: number | null; out: string; err: string };

export type TunnelDeps = {
  exec: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ) => Promise<ExecResult>;
  resolveDns: (hostname: string) => Promise<DnsRecords>;
  homeDir: () => string;
  platform: () => string;
  probe: (hostname: string) => Promise<boolean>;
};

const WIN_FALLBACK_BINS: Record<string, string[]> = {
  winget: [
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "winget.exe"),
  ],
  cloudflared: [
    resolve(import.meta.dir, "..", "runtime", "cloudflared", "cloudflared.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "cloudflared", "cloudflared.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "cloudflared.exe"),
  ],
};

function resolveWinBin(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  const candidates = WIN_FALLBACK_BINS[cmd];
  if (!candidates) return cmd;
  for (const dir of (process.env.PATH ?? "").split(";")) {
    if (!dir) continue;
    const inPath = join(dir, `${cmd}.exe`);
    if (existsSync(inPath)) return inPath;
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return cmd;
}

function defaultExec(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(resolveWinBin(cmd), args, { windowsHide: true });
    } catch (err) {
      resolvePromise({
        code: null,
        out: "",
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let out = "";
    let errText = "";
    const timer = setTimeout(() => child.kill(), opts?.timeoutMs ?? 30_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      errText += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, out, err: errText || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err: errText });
    });
  });
}

const FAKE_IP_RE = /^198\.1[89]\./;

async function queryDoh(
  endpoint: string,
  hostname: string,
  type: "CNAME" | "A" | "AAAA",
  typeNum: number,
): Promise<string[] | null> {
  try {
    const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`;
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      Status?: number;
      Answer?: { type?: number; data?: string }[];
    };
    if (typeof json.Status !== "number") return null;
    return (json.Answer ?? [])
      .filter((r) => r.type === typeNum && typeof r.data === "string")
      .map((r) => r.data!);
  } catch {
    return null;
  }
}

async function defaultResolveDns(hostname: string): Promise<DnsRecords> {
  // 优先用 DoH 查公网权威结果，避免本机 Clash/Mihomo TUN Fake-IP（198.18.0.0/15）把未建域名误判为已占用
  for (const endpoint of [
    "https://cloudflare-dns.com/dns-query",
    "https://dns.alidns.com/resolve",
  ]) {
    const [cname, a, aaaa] = await Promise.all([
      queryDoh(endpoint, hostname, "CNAME", 5),
      queryDoh(endpoint, hostname, "A", 1),
      queryDoh(endpoint, hostname, "AAAA", 28),
    ]);
    if (cname !== null && a !== null && aaaa !== null) {
      return { cname, a, aaaa };
    }
  }
  const grab = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [cname, a, aaaa] = await Promise.all([
    grab(() => resolveDnsCname(hostname)),
    grab(() => resolve4(hostname)),
    grab(() => resolve6(hostname)),
  ]);
  return { cname, a: a.filter((ip) => !FAKE_IP_RE.test(ip)), aaaa };
}

async function defaultProbe(hostname: string): Promise<boolean> {
  try {
    // 401/503/200 任何 HTTP 响应都说明隧道已通到本地后端
    await fetch(`https://${hostname}/bridge/pending`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

export const defaultTunnelDeps: TunnelDeps = {
  exec: defaultExec,
  resolveDns: defaultResolveDns,
  homeDir: () => homedir(),
  platform: () => process.platform,
  probe: defaultProbe,
};

export type JobKind =
  | "install"
  | "login"
  | "create"
  | "route"
  | "config"
  | "service";

export type Job = {
  id: number;
  kind: JobKind;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  message: string;
};

export type TunnelStatus = {
  installed: { ok: boolean; version: string | null };
  authorized: boolean;
  tunnel: { ok: boolean; id: string | null };
  dns: { state: DnsState | "unknown"; detail: string };
  config: { ok: boolean; detail: string };
  running: { ok: boolean; detail: string };
  service: { state: "running" | "stopped" | "absent" | "unknown"; detail: string };
};

const OUTPUT_TAIL = 4000;

export class TunnelWizard {
  private jobs = new Map<number, Job>();
  private nextJobId = 1;
  private child: ChildProcess | null = null;
  private childLog: string[] = [];

  constructor(private deps: TunnelDeps = defaultTunnelDeps) {}

  cfDir(): string {
    return join(this.deps.homeDir(), ".cloudflared");
  }


  private readTunnelFile(): { hostname?: string; routedHostname?: string } {
    try {
      return JSON.parse(readFileSync(TUNNEL_FILE, "utf8")) as {
        hostname?: string;
        routedHostname?: string;
      };
    } catch {
      return {};
    }
  }

  savedHostname(): string {
    const parsed = this.readTunnelFile();
    if (typeof parsed.hostname === "string" && isValidHostname(parsed.hostname)) {
      return parsed.hostname.trim().toLowerCase();
    }
    return DEFAULT_HOSTNAME;
  }

  saveHostname(hostname: string): void {
    const prev = this.readTunnelFile();
    atomicWriteFileSync(
      TUNNEL_FILE,
      `${JSON.stringify({ ...prev, hostname }, null, 2)}\n`,
    );
  }

  private markRouted(hostname: string): void {
    const prev = this.readTunnelFile();
    const norm = hostname.trim().toLowerCase();
    if (prev.routedHostname === norm) return;
    atomicWriteFileSync(
      TUNNEL_FILE,
      `${JSON.stringify({ ...prev, hostname: prev.hostname ?? norm, routedHostname: norm }, null, 2)}\n`,
    );
  }


  async detectInstalled(): Promise<{ ok: boolean; version: string | null }> {
    const r = await this.deps.exec("cloudflared", ["--version"], {
      timeoutMs: 10_000,
    });
    const version = parseVersionOutput(`${r.out}\n${r.err}`);
    return { ok: version !== null, version };
  }

  detectAuthorized(): boolean {
    return existsSync(join(this.cfDir(), "cert.pem"));
  }

  async detectTunnel(): Promise<TunnelInfo | null> {
    const r = await this.deps.exec(
      "cloudflared",
      ["tunnel", "list", "--output", "json"],
      { timeoutMs: 15_000 },
    );
    const fromList = parseTunnelList(r.out, TUNNEL_NAME);
    if (fromList) return fromList;
    // 兜底：凭据 json 文件名即隧道 ID（create 时落盘）
    try {
      for (const name of readdirSync(this.cfDir())) {
        if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
          return { id: name.replace(/\.json$/i, ""), name: TUNNEL_NAME };
        }
      }
    } catch {
      // 目录不存在 → 未建
    }
    return null;
  }

  async checkDns(
    hostname: string,
  ): Promise<{ state: DnsState | "unknown"; detail: string }> {
    try {
      const records = await this.deps.resolveDns(hostname);
      let state = classifyDns(records);
      const norm = hostname.trim().toLowerCase();
      if (state === "occupied" && this.readTunnelFile().routedHostname === norm) {
        state = "created";
      }
      const detail =
        state === "created"
          ? "该子域名已创建（已指向隧道）"
          : state === "occupied"
            ? `该子域名已被占用（不是隧道记录：${[...records.cname, ...records.a, ...records.aaaa].join(", ")}）`
            : "未创建，可用";
      return { state, detail };
    } catch (err) {
      return {
        state: "unknown",
        detail: `DNS 查询失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  checkConfig(
    hostname: string,
    tunnelId: string | null,
  ): { ok: boolean; detail: string } {
    const path = join(this.cfDir(), "config.yml");
    if (!existsSync(path)) return { ok: false, detail: "尚未写入 config.yml" };
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { ok: false, detail: "config.yml 读不" };
    }
    const hasHost = text.includes(hostname);
    const hasId = tunnelId ? text.includes(tunnelId) : false;
    if (hasHost && (hasId || !tunnelId)) {
      return { ok: true, detail: "config.yml 已写入且与当前隧道/主机名一致" };
    }
    return {
      ok: false,
      detail: `config.yml 与当前状态不一致（主机：${hasHost ? "✓" : "✗"}、隧道 ID：${hasId ? "✓" : "✗"}），建议重写`,
    };
  }

  childRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async detectRunning(hostname: string): Promise<{ ok: boolean; detail: string }> {
    if (this.childRunning()) {
      return { ok: true, detail: "由本页托管运行中" };
    }
    const reachable = await this.deps.probe(hostname);
    if (reachable) {
      return { ok: true, detail: "隧道可达（可能由服务或另一个进程在跑）" };
    }
    return { ok: false, detail: "隧道未运行（公网地址连不到本地后端）" };
  }

  async detectService(): Promise<{
    state: "running" | "stopped" | "absent" | "unknown";
    detail: string;
  }> {
    if (this.deps.platform() !== "win32") {
      return { state: "unknown", detail: "非 Windows 平台，服务状态未知" };
    }
    const r = await this.deps.exec("sc", ["query", "Cloudflared"], {
      timeoutMs: 10_000,
    });
    if (r.code === null) {
      return { state: "unknown", detail: "服务状态查不到（sc 命令不可用）" };
    }
    const state = parseServiceState(`${r.out}\n${r.err}`);
    if (state === "absent") {
      return { state: "absent", detail: "尚未安装为 Windows 服务" };
    }
    return {
      state,
      detail: state === "running" ? "Cloudflared 服务运行中" : "Cloudflared 服务已装、当前未运行",
    };
  }

  async status(hostname: string): Promise<TunnelStatus> {
    const [installed, tunnel, dns, service] = await Promise.all([
      this.detectInstalled(),
      this.detectTunnel(),
      this.checkDns(hostname),
      this.detectService(),
    ]);
    const config = this.checkConfig(hostname, tunnel?.id ?? null);
    const running = await this.detectRunning(hostname);
    // Cloudflare 橙云代理会把隧道 CNAME 扁平化为边缘 A/AAAA IP；公网探活已通即证实指向本隧道
    const resolvedDns =
      running.ok && dns.state === "occupied"
        ? (this.markRouted(hostname),
          { state: "created" as const, detail: "该子域名已创建（隧道已连通）" })
        : dns;
    return {
      installed,
      authorized: this.detectAuthorized(),
      tunnel: { ok: tunnel !== null, id: tunnel?.id ?? null },
      dns: resolvedDns,
      config,
      running,
      service,
    };
  }


  listJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.id - a.id).slice(0, 6);
  }

  anyJobRunning(): boolean {
    return [...this.jobs.values()].some((j) => j.status === "running");
  }

  private startJob(
    kind: JobKind,
    runner: (append: (text: string) => void) => Promise<string>,
  ): Job {
    const job: Job = {
      id: this.nextJobId++,
      kind,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      output: "",
      message: "",
    };
    this.jobs.set(job.id, job);
    const append = (text: string) => {
      job.output = (job.output + text).slice(-OUTPUT_TAIL);
    };
    runner(append)
      .then((message) => {
        job.status = "done";
        job.message = message;
      })
      .catch((err: unknown) => {
        job.status = "failed";
        job.message = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return job;
  }

  private async runToText(
    cmd: string,
    args: string[],
    timeoutMs: number,
    append: (text: string) => void,
  ): Promise<ExecResult> {
    append(`> ${cmd} ${args.join(" ")}\n`);
    const r = await this.deps.exec(cmd, args, { timeoutMs });
    append(r.out);
    if (r.err) append(r.err);
    return r;
  }

  startInstall(): Job {
    return this.startJob("install", async (append) => {
      if (this.deps.platform() !== "win32") {
        throw new Error(
          "一键安装只支持 Windows；当前平台请手动安装 cloudflared 后刷新本",
        );
      }
      const r = await this.runToText(
        "winget",
        [
          "install",
          "--id",
          "Cloudflare.cloudflared",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ],
        300_000,
        append,
      );
      if (r.code !== 0) {
        throw new Error(
          `winget 安装失败（退出码 ${r.code ?? "未知"}），可手动运行：winget install --id Cloudflare.cloudflared`,
        );
      }
      return "cloudflared 安装完成";
    });
  }

  startLogin(): Job {
    return this.startJob("login", async (append) => {
      append("已启动授权：浏览器应已打开 Cloudflare 登录页，请选中域名并点授权。\n");
      const r = await this.runToText(
        "cloudflared",
        ["tunnel", "login"],
        600_000,
        append,
      );
      if (this.detectAuthorized()) return "授权完成（cert.pem 已生成）";
      throw new Error(
        `授权未完成（退出码 ${r.code ?? "未知"}）；如浏览器没打开，可手动运行：cloudflared tunnel login`,
      );
    });
  }

  startCreate(): Job {
    return this.startJob("create", async (append) => {
      const r = await this.runToText(
        "cloudflared",
        ["tunnel", "create", TUNNEL_NAME],
        60_000,
        append,
      );
      if (r.code !== 0) {
        throw new Error(
          `建隧道失败（退出码 ${r.code ?? "未知"}），可手动运行：cloudflared tunnel create ${TUNNEL_NAME}`,
        );
      }
      const id = extractTunnelId(`${r.out}\n${r.err}`) ??
        (await this.detectTunnel())?.id ??
        null;
      if (!id) throw new Error("隧道已建但没能捕获到隧道 ID，请刷新页面看状");
      return `隧道已创建，ID：${id}`;
    });
  }

  startRoute(hostname: string): Job {
    return this.startJob("route", async (append) => {
      const before = await this.checkDns(hostname);
      append(`写解析前检查：${before.detail}\n`);
      if (before.state === "created") {
        return "该子域名已创建（已指向隧道），无需重复写解";
      }
      if (before.state === "occupied") {
        throw new Error(
          "该子域名已被其它记录占用，不是隧道记录；先到 Cloudflare 后台处理掉那条记录，或换一个子域名",
        );
      }
      const r = await this.runToText(
        "cloudflared",
        ["tunnel", "route", "dns", TUNNEL_NAME, hostname],
        60_000,
        append,
      );
      if (r.code !== 0) {
        throw new Error(
          `写解析失败（退出码 ${r.code ?? "未知"}），可手动运行：cloudflared tunnel route dns ${TUNNEL_NAME} ${hostname}`,
        );
      }
      this.markRouted(hostname);
      const after = await this.checkDns(hostname);
      append(`写解析后复查：${after.detail}\n`);
      return after.state === "created"
        ? "子域名解析已创建并指向隧"
        : "解析命令已执行，DNS 生效可能稍有延迟，稍后刷新页面复";
    });
  }

  startWriteConfig(hostname: string): Job {
    return this.startJob("config", async (append) => {
      const tunnel = await this.detectTunnel();
      if (!tunnel) {
        throw new Error("还没建隧道，先完成「建隧道」再写配");
      }
      const dir = this.cfDir();
      const credentialsFile = join(dir, `${tunnel.id}.json`);
      const path = join(dir, "config.yml");
      if (existsSync(path)) {
        copyFileSync(path, `${path}.bak`);
        append("已有 config.yml，已备份为 config.yml.bak\n");
      }
      const yml = buildConfigYml({
        tunnelId: tunnel.id,
        hostname,
        credentialsFile,
      });
      atomicWriteFileSync(path, yml);
      append(`已写入 ${path}\n${yml}`);
      return "config.yml 已写入（主机名与隧道 ID 均为实测值）";
    });
  }

  startServiceInstall(): Job {
    return this.startJob("service", async (append) => {
      if (this.deps.platform() !== "win32") {
        throw new Error(
          "装服务只支持 Windows；当前平台可手动运行：cloudflared service install",
        );
      }
      append("将弹出 Windows 管理员确认框（UAC），请点「是」。\n");
      const bin = resolveWinBin("cloudflared");
      const cfg = join(this.cfDir(), "config.yml");
      const psEsc = (s: string) => s.replace(/'/g, "''");
      // cloudflared service install 用 LocalSystem 跑服务，默认去 systemprofile 找配置；
      // 这里顺手把服务 ImagePath 指向当前用户的 config.yml 并重启，避免 1033 空转
      const innerScript = [
        `& '${psEsc(bin)}' service install`,
        `if (Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Cloudflared') {`,
        `  Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Cloudflared' -Name ImagePath -Value ('"' + '${psEsc(bin)}' + '" --config "' + '${psEsc(cfg)}' + '" tunnel run')`,
        `  Restart-Service Cloudflared -Force`,
        `}`,
      ].join("; ");
      const encoded = Buffer.from(innerScript, "utf16le").toString("base64");
      const r = await this.runToText(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Start-Process powershell -ArgumentList '-NoProfile','-EncodedCommand','${encoded}' -Verb RunAs -Wait`,
        ],
        180_000,
        append,
      );
      const svc = await this.detectService();
      append(`服务状态复查：${svc.detail}\n`);
      if (svc.state === "running" || svc.state === "stopped") {
        return "Cloudflared 服务已安装（开机自启）";
      }
      throw new Error(
        `装服务未确认成功（命令退出码 ${r.code ?? "未知"}，服务状态：${svc.detail}），可手动在管理员 PowerShell 运行：cloudflared service install`,
      );
    });
  }


  tunnelLogTail(lines = 30): string[] {
    return this.childLog.slice(-lines);
  }

  startRun(): string {
    if (this.childRunning()) return "隧道已在由本页托管运行中";
    let child: ChildProcess;
    try {
      child = spawn(resolveWinBin("cloudflared"), ["tunnel", "run", TUNNEL_NAME], {
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(
        `拉起隧道失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.child = child;
    this.childLog = [];
    const push = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) this.childLog.push(line);
      }
      if (this.childLog.length > 200) {
        this.childLog = this.childLog.slice(-200);
      }
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("close", (code) => {
      this.childLog.push(`[cloudflared 已退出，code=${code ?? "未知"}]`);
      if (this.child === child) this.child = null;
    });
    return "隧道已拉起（本页托管），稍等几秒后看上方运行状态";
  }

  stopRun(): string {
    if (!this.childRunning()) return "当前没有由本页托管的隧道进程";
    this.child?.kill();
    return "已停止本页托管的隧道进程";
  }
}

/** 管理页与端点共用的默认向导实例（真实依赖）。*/
export const tunnelWizard = new TunnelWizard();
