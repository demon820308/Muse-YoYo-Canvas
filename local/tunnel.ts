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
  parseCloudflareErrorCode,
  parseServiceState,
  parseTunnelList,
  parseVersionOutput,
  TUNNEL_NAME,
  tunnelNameForHostname,
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
  parseCloudflareErrorCode,
  parseServiceState,
  parseTunnelList,
  parseVersionOutput,
  TUNNEL_NAME,
  tunnelNameForHostname,
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
  probeHttp?: (hostname: string, token?: string | null) => Promise<number | null>;
  probeDetail?: (
    hostname: string,
    token?: string | null,
  ) => Promise<{ status: number | null; cfErrorCode?: number | null }>;
  spawnTunnel?: (args: string[]) => ChildProcess;
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

async function defaultProbeDetail(
  hostname: string,
  token?: string | null,
): Promise<{ status: number | null; cfErrorCode?: number | null }> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`https://${hostname}/bridge/pending`, {
      headers,
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
    });
    const cfErrorCode =
      res.status === 530
        ? parseCloudflareErrorCode(await res.text().catch(() => ""))
        : null;
    return { status: res.status, cfErrorCode };
  } catch {
    return { status: null, cfErrorCode: null };
  }
}

async function defaultProbeHttp(
  hostname: string,
  token?: string | null,
): Promise<number | null> {
  return (await defaultProbeDetail(hostname, token)).status;
}

async function defaultProbe(hostname: string): Promise<boolean> {
  const status = await defaultProbeHttp(hostname);
  // 只有 200/401 才证明请求穿透隧道到达本地后端；530/502/503 都是 Cloudflare 隧道未通
  return status === 200 || status === 401;
}

export const defaultTunnelDeps: TunnelDeps = {
  exec: defaultExec,
  resolveDns: defaultResolveDns,
  homeDir: () => homedir(),
  platform: () => process.platform,
  probe: defaultProbe,
  probeHttp: defaultProbeHttp,
  probeDetail: defaultProbeDetail,
};

export type JobKind =
  | "install"
  | "login"
  | "create"
  | "route"
  | "config"
  | "service"
  | "auto";

export type WizardStepState =
  | "pending"
  | "running"
  | "waiting"
  | "done"
  | "warn"
  | "failed";

export type WizardStep = {
  key: string;
  label: string;
  state: WizardStepState;
  detail?: string;
  actionUrl?: string;
};

export type Job = {
  id: number;
  kind: JobKind;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  message: string;
  progress?: number;
  steps?: WizardStep[];
  errorCode?: "missing_credentials" | "dns_occupied" | "auth_timeout" | null;
  suggestedHostname?: string | null;
};

export type DiagnosisLayer = {
  id: "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";
  title: string;
  status: "ok" | "warn" | "error";
  detail: string;
  fixAction: {
    id: string;
    label: string;
    dangerous?: boolean;
    confirmText?: string;
  } | null;
};

export type BridgeSummaryState =
  | "unconfigured"
  | "unpaired"
  | "connecting"
  | "disconnected"
  | "connected";

export type DiagnosisReport = {
  state: BridgeSummaryState;
  label: string;
  summary: string;
  canAutoFix: boolean;
  layers: DiagnosisLayer[];
  status: TunnelStatus;
};

export type TunnelStatus = {
  installed: { ok: boolean; version: string | null };
  authorized: boolean;
  tunnel: {
    ok: boolean;
    id: string | null;
    name: string;
    existsRemote: boolean;
    hasCredentials: boolean;
  };
  dns: { state: DnsState | "unknown"; detail: string };
  config: { ok: boolean; detail: string };
  running: { ok: boolean; detail: string };
  service: { state: "running" | "stopped" | "absent" | "unknown"; detail: string };
  e2e: {
    ok: boolean;
    httpStatus: number | null;
    detail: string;
    needsDnsOverwrite: boolean;
  };
};

const OUTPUT_TAIL = 4000;

export class TunnelWizard {
  private jobs = new Map<number, Job>();
  private nextJobId = 1;
  private child: ChildProcess | null = null;
  private childLog: string[] = [];
  private manualStop = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private ensureInFlight: Promise<string | null> | null = null;
  private lastStartRunAt = 0;

  constructor(private deps: TunnelDeps = defaultTunnelDeps) {}

  isManuallyStopped(): boolean {
    return this.manualStop;
  }

  isHealing(): boolean {
    return this.ensureInFlight !== null || this.restartTimer !== null;
  }

  isStartingUp(): boolean {
    return (
      this.isHealing() ||
      (this.lastStartRunAt > 0 && Date.now() - this.lastStartRunAt < 10_000)
    );
  }

  hasLocalConfig(hostname = this.savedHostname()): boolean {
    if (!isValidHostname(hostname)) return false;
    const cfgPath = join(this.cfDir(), "config.yml");
    if (!existsSync(cfgPath)) return false;
    let text = "";
    try {
      text = readFileSync(cfgPath, "utf8");
    } catch {
      return false;
    }
    if (!text.includes(hostname)) return false;
    const id = extractTunnelId(text);
    return id !== null && existsSync(join(this.cfDir(), `${id}.json`));
  }

  cfDir(): string {
    return join(this.deps.homeDir(), ".cloudflared");
  }


  private readTunnelFile(): {
    hostname?: string;
    routedHostname?: string;
    routedTunnelId?: string;
  } {
    try {
      return JSON.parse(readFileSync(TUNNEL_FILE, "utf8")) as {
        hostname?: string;
        routedHostname?: string;
        routedTunnelId?: string;
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

  private markRouted(hostname: string, tunnelId?: string | null): void {
    const prev = this.readTunnelFile();
    const norm = hostname.trim().toLowerCase();
    const nextTunnelId = tunnelId ?? prev.routedTunnelId;
    if (prev.routedHostname === norm && prev.routedTunnelId === nextTunnelId) return;
    atomicWriteFileSync(
      TUNNEL_FILE,
      `${JSON.stringify({ ...prev, hostname: prev.hostname ?? norm, routedHostname: norm, routedTunnelId: nextTunnelId }, null, 2)}\n`,
    );
  }


  async detectInstalled(): Promise<{ ok: boolean; version: string | null }> {
    const r = await this.deps.exec("cloudflared", ["--version"], {
      timeoutMs: 10_000,
    });
    const version = parseVersionOutput(`${r.out}\n${r.err}`);
    return { ok: version !== null, version };
  }

  tunnelName(hostname = this.savedHostname()): string {
    return tunnelNameForHostname(hostname);
  }

  detectAuthorized(): boolean {
    return existsSync(join(this.cfDir(), "cert.pem"));
  }

  async detectTunnel(tunnelName = this.tunnelName()): Promise<TunnelInfo | null> {
    const r = await this.deps.exec(
      "cloudflared",
      ["tunnel", "list", "--output", "json"],
      { timeoutMs: 15_000 },
    );
    const fromList = parseTunnelList(r.out, tunnelName);
    if (fromList) return fromList;
    // 兜底：凭据 json 文件名即隧道 ID（create 时落盘）
    try {
      for (const name of readdirSync(this.cfDir())) {
        if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
          return { id: name.replace(/\.json$/i, ""), name: tunnelName };
        }
      }
    } catch {
      // 目录不存在 → 未建
    }
    return null;
  }

  async checkDns(
    hostname: string,
    expectedTunnelId?: string | null,
  ): Promise<{ state: DnsState | "unknown"; detail: string }> {
    try {
      const records = await this.deps.resolveDns(hostname);
      let state = classifyDns(records, expectedTunnelId);
      const norm = hostname.trim().toLowerCase();
      const saved = this.readTunnelFile();
      const cachedMatch =
        saved.routedHostname === norm &&
        (!expectedTunnelId ||
          !saved.routedTunnelId ||
          saved.routedTunnelId === expectedTunnelId);
      if (state === "occupied" && cachedMatch) {
        state = "created";
      }
      const detail =
        state === "created"
          ? "该子域名已创建（已指向当前隧道）"
          : state === "mismatch"
            ? "该子域名指向了其它旧隧道（非本机隧道），请点「覆盖写解析」指向本机隧道"
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

  async probeE2e(
    hostname: string,
    token?: string | null,
  ): Promise<TunnelStatus["e2e"]> {
    const probed = this.deps.probeDetail
      ? await this.deps.probeDetail(hostname, token)
      : this.deps.probeHttp
        ? { status: await this.deps.probeHttp(hostname, token), cfErrorCode: null }
        : {
            status: (await this.deps.probe(hostname))
              ? token
                ? 200
                : 401
              : null,
            cfErrorCode: null,
          };
    const httpStatus = probed.status;
    if (httpStatus === 200) {
      return {
        ok: true,
        httpStatus,
        detail: "公网桥端到端已连通（HTTP 200，令牌校验通过）",
        needsDnsOverwrite: false,
      };
    }
    if (httpStatus === 401) {
      return token
        ? {
            ok: false,
            httpStatus,
            detail: "公网隧道已到达本机，但令牌校验未通过（HTTP 401）",
            needsDnsOverwrite: false,
          }
        : {
            ok: true,
            httpStatus,
            detail: "公网隧道已直达本机（HTTP 401；请先在下方创建并启用桥账号）",
            needsDnsOverwrite: false,
          };
    }
    if (httpStatus === 530) {
      if (probed.cfErrorCode === 1033) {
        return {
          ok: false,
          httpStatus,
          detail: "隧道尚未连上 Cloudflare（Error 1033），正等待本地隧道启动",
          needsDnsOverwrite: false,
        };
      }
      return {
        ok: false,
        httpStatus,
        detail: "Cloudflare 返回 HTTP 530：DNS 未指向当前隧道或隧道未连上边缘，请点「覆盖写解析」",
        needsDnsOverwrite: true,
      };
    }
    if (httpStatus !== null) {
      return {
        ok: false,
        httpStatus,
        detail: `公网探测返回 HTTP ${httpStatus}（请确认本地服务与隧道运行正常）`,
        needsDnsOverwrite: false,
      };
    }
    return {
      ok: false,
      httpStatus: null,
      detail: "公网暂不可达（请确认第 6/7 步隧道已启动）",
      needsDnsOverwrite: false,
    };
  }

  async status(hostname: string, activeToken?: string | null): Promise<TunnelStatus> {
    const tunnelName = this.tunnelName(hostname);
    const [installed, tunnel, service] = await Promise.all([
      this.detectInstalled(),
      this.detectTunnel(tunnelName),
      this.detectService(),
    ]);
    const hasCredentials = tunnel
      ? existsSync(join(this.cfDir(), `${tunnel.id}.json`))
      : false;
    const tunnelReady = tunnel !== null && hasCredentials;
    const [dns, running, e2e] = await Promise.all([
      this.checkDns(hostname, tunnel?.id ?? null),
      this.detectRunning(hostname),
      this.probeE2e(hostname, activeToken),
    ]);
    const config = this.checkConfig(hostname, tunnel?.id ?? null);
    let resolvedDns = dns;
    if (e2e.httpStatus === 530 && e2e.needsDnsOverwrite && dns.state === "created") {
      resolvedDns = {
        state: "mismatch",
        detail: "公网返回 HTTP 530：DNS 可能仍指向旧隧道，请点「覆盖写解析」",
      };
    } else if (
      (e2e.httpStatus === 200 || e2e.httpStatus === 401 || running.ok) &&
      dns.state === "occupied"
    ) {
      this.markRouted(hostname, tunnel?.id ?? null);
      resolvedDns = { state: "created", detail: "该子域名已创建（隧道已连通）" };
    }
    return {
      installed,
      authorized: this.detectAuthorized(),
      tunnel: {
        ok: tunnelReady,
        id: tunnel?.id ?? null,
        name: tunnelName,
        existsRemote: tunnel !== null,
        hasCredentials,
      },
      dns: resolvedDns,
      config,
      running,
      service,
      e2e,
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
    runner: (append: (text: string) => void, job: Job) => Promise<string>,
    init?: (job: Job) => void,
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
    init?.(job);
    this.jobs.set(job.id, job);
    const append = (text: string) => {
      job.output = (job.output + text).slice(-OUTPUT_TAIL);
      const urlMatch = text.match(/https:\/\/dash\.cloudflare\.com\/[^\s"'<>]+/);
      if (urlMatch && job.steps) {
        const loginStep = job.steps.find((s) => s.key === "login");
        if (loginStep && !loginStep.actionUrl) {
          loginStep.actionUrl = urlMatch[0];
          loginStep.detail = "请在弹出的浏览器中选中域名并授权（或点下方按钮打开）";
        }
      }
    };
    runner(append, job)
      .then((message) => {
        job.status = "done";
        job.message = message;
        if (job.steps) job.progress = 100;
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

  startCreate(hostname = this.savedHostname()): Job {
    const name = this.tunnelName(hostname);
    return this.startJob("create", async (append) => {
      const r = await this.runToText(
        "cloudflared",
        ["tunnel", "create", name],
        60_000,
        append,
      );
      if (r.code !== 0) {
        throw new Error(
          `建隧道失败（退出码 ${r.code ?? "未知"}），可手动运行：cloudflared tunnel create ${name}`,
        );
      }
      const id = extractTunnelId(`${r.out}\n${r.err}`) ??
        (await this.detectTunnel(name))?.id ??
        null;
      if (!id) throw new Error("隧道已建但没能捕获到隧道 ID，请刷新页面看状");
      return `隧道 ${name} 已创建，ID：${id}`;
    });
  }

  startRoute(hostname: string, overwrite = false): Job {
    const name = this.tunnelName(hostname);
    return this.startJob("route", async (append) => {
      const tunnel = await this.detectTunnel(name);
      const before = await this.checkDns(hostname, tunnel?.id ?? null);
      append(`写解析前检查：${before.detail}\n`);
      if (!overwrite && before.state === "created") {
        return "该子域名已创建（已指向当前隧道），无需重复写解析";
      }
      if (!overwrite && before.state === "occupied") {
        throw new Error(
          "该子域名已被其它记录占用，不是隧道记录；先到 Cloudflare 后台处理掉那条记录，或换一个子域名",
        );
      }
      const useOverwrite = overwrite || before.state === "mismatch";
      const args = useOverwrite
        ? ["tunnel", "route", "dns", "--overwrite-dns", name, hostname]
        : ["tunnel", "route", "dns", name, hostname];
      const r = await this.runToText("cloudflared", args, 60_000, append);
      if (r.code !== 0) {
        throw new Error(
          `写解析失败（退出码 ${r.code ?? "未知"}），可手动运行：cloudflared ${args.join(" ")}`,
        );
      }
      this.markRouted(hostname, tunnel?.id ?? null);
      const after = await this.checkDns(hostname, tunnel?.id ?? null);
      append(`写解析后复查：${after.detail}\n`);
      return after.state === "created"
        ? "子域名解析已创建并指向当前隧道"
        : "解析命令已执行，DNS 生效可能稍有延迟，稍后刷新页面复查";
    });
  }

  startWriteConfig(hostname: string): Job {
    const name = this.tunnelName(hostname);
    return this.startJob("config", async (append) => {
      const tunnel = await this.detectTunnel(name);
      if (!tunnel) {
        throw new Error(`还没建隧道 ${name}，先完成「建隧道」再写配置`);
      }
      const dir = this.cfDir();
      const credentialsFile = join(dir, `${tunnel.id}.json`);
      if (!existsSync(credentialsFile)) {
        throw new Error(
          `云端存在隧道 ${name}，但本机缺少凭据文件（${tunnel.id}.json）。请回第 3 步换一个新的子域名重新建隧道，或从旧机器拷贝该凭据文件`,
        );
      }
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

  private async installWindowsServiceInternal(
    append: (text: string) => void,
  ): Promise<string> {
    if (this.deps.platform() !== "win32") {
      throw new Error(
        "装服务只支持 Windows；当前平台可手动运行：cloudflared service install",
      );
    }
    this.manualStop = false;
    this.clearRestartTimer();
    if (this.childRunning()) {
      append("先停止本页托管的 cloudflared 进程，避免与 Windows 服务冲突。\n");
      this.stopChildProcess();
    }
    append("将弹出 Windows 管理员确认框（UAC），请点「是」。\n");
    const bin = resolveWinBin("cloudflared");
    const cfg = join(this.cfDir(), "config.yml");
    const psEsc = (s: string) => s.replace(/'/g, "''");
    // cloudflared service install 用 LocalSystem 跑服务，默认去 systemprofile 找配置；
    // 这里顺手把服务 ImagePath 指向当前用户的 config.yml，并配置网络/DNS 依赖、延迟自启及多次失败自动重启
    const innerScript = [
      `& '${psEsc(bin)}' service install`,
      `if (Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Cloudflared') {`,
      `  Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Cloudflared' -Name ImagePath -Value ('"' + '${psEsc(bin)}' + '" --config "' + '${psEsc(cfg)}' + '" tunnel run')`,
      `  & sc.exe config Cloudflared start= delayed-auto depend= Tcpip/Dnscache | Out-Null`,
      `  & sc.exe failure Cloudflared reset= 300 actions= restart/15000/restart/30000/restart/60000 | Out-Null`,
      `  & sc.exe failureflag Cloudflared 1 | Out-Null`,
      `  Stop-Service Cloudflared -Force -NoWait -ErrorAction SilentlyContinue`,
      `  Start-Sleep -Seconds 2`,
      `  $svcPid = (Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction SilentlyContinue).ProcessId`,
      `  if ($svcPid -and $svcPid -gt 0) { Stop-Process -Id $svcPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }`,
      `  Start-Service Cloudflared`,
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
  }

  startServiceInstall(): Job {
    return this.startJob("service", (append) =>
      this.installWindowsServiceInternal(append),
    );
  }

  private suggestAltHostname(hostname: string): string {
    const parts = hostname.trim().toLowerCase().split(".");
    if (parts.length < 2) return hostname;
    const prefix = parts[0]!;
    const nextPrefix = /-pc(\d+)$/.test(prefix)
      ? prefix.replace(/-pc(\d+)$/, (_, n) => `-pc${Number(n) + 1}`)
      : `${prefix}-pc2`;
    return [nextPrefix, ...parts.slice(1)].join(".");
  }

  startAutoSetup(hostname: string, activeToken?: string | null): Job {
    const name = this.tunnelName(hostname);
    const initialSteps: WizardStep[] = [
      { key: "install", label: "检查 / 安装 cloudflared", state: "pending" },
      { key: "login", label: "Cloudflare 账号授权", state: "pending" },
      { key: "tunnel", label: `准备本机隧道（${name}）`, state: "pending" },
      { key: "dns", label: "写入子域名 DNS 解析", state: "pending" },
      { key: "config", label: "生成 config.yml 配置", state: "pending" },
      { key: "service", label: "启动隧道服务", state: "pending" },
      { key: "e2e", label: "公网端到端连通体检", state: "pending" },
    ];
    const setStep = (
      job: Job,
      key: string,
      patch: Partial<WizardStep>,
      progress?: number,
    ) => {
      const s = job.steps?.find((x) => x.key === key);
      if (s) Object.assign(s, patch);
      if (typeof progress === "number") job.progress = progress;
    };

    return this.startJob(
      "auto",
      async (append, job) => {
        // 1. 安装检查
        setStep(job, "install", { state: "running", detail: "检测 cloudflared…" }, 8);
        const installed = await this.detectInstalled();
        if (!installed.ok) {
          if (this.deps.platform() !== "win32") {
            setStep(job, "install", { state: "failed", detail: "未检测到 cloudflared" });
            throw new Error("未检测到 cloudflared，请先在本机安装后再试");
          }
          setStep(job, "install", { state: "running", detail: "正在通过 winget 安装 cloudflared…" }, 12);
          const ir = await this.runToText(
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
          if (ir.code !== 0) {
            setStep(job, "install", { state: "failed", detail: "winget 安装失败" });
            throw new Error(
              `cloudflared 自动安装失败（退出码 ${ir.code ?? "未知"}），可手动下载放入 runtime/cloudflared/`,
            );
          }
        }
        setStep(job, "install", { state: "done", detail: "cloudflared 已就绪" }, 18);

        // 2. Cloudflare 授权
        setStep(job, "login", { state: "running", detail: "检查授权证书 cert.pem…" }, 22);
        if (!this.detectAuthorized()) {
          setStep(
            job,
            "login",
            {
              state: "waiting",
              detail: "等待浏览器完成 Cloudflare 授权（选中域名并点 Authorize）…",
            },
            25,
          );
          const lr = await this.runToText(
            "cloudflared",
            ["tunnel", "login"],
            600_000,
            append,
          );
          if (!this.detectAuthorized()) {
            job.errorCode = "auth_timeout";
            setStep(job, "login", { state: "failed", detail: "未完成 Cloudflare 授权" });
            throw new Error(
              `尚未完成 Cloudflare 授权（退出码 ${lr.code ?? "未知"}）；请重新点击开始并在浏览器中确认授权`,
            );
          }
        }
        setStep(job, "login", { state: "done", detail: "Cloudflare 授权已就绪", actionUrl: undefined }, 34);

        // 3. 检查或创建隧道
        setStep(job, "tunnel", { state: "running", detail: `检查隧道 ${name}…` }, 40);
        append(`[1/4] 检查隧道 ${name}...\n`);
        let tunnel = await this.detectTunnel(name);
        if (tunnel) {
          const credPath = join(this.cfDir(), `${tunnel.id}.json`);
          if (!existsSync(credPath)) {
            job.errorCode = "missing_credentials";
            job.suggestedHostname = this.suggestAltHostname(hostname);
            setStep(job, "tunnel", {
              state: "failed",
              detail: `同名隧道已存在但本机缺少凭据（建议改用 ${job.suggestedHostname}）`,
            });
            throw new Error(
              `云端已存在同名隧道 ${name}，但本机缺少凭据文件（${tunnel.id}.json）。建议改用新子域名 ${job.suggestedHostname}`,
            );
          }
          append(`隧道 ${name} 已就绪（ID：${tunnel.id}）\n`);
        } else {
          const cr = await this.runToText(
            "cloudflared",
            ["tunnel", "create", name],
            60_000,
            append,
          );
          if (cr.code !== 0) {
            setStep(job, "tunnel", { state: "failed", detail: "建隧道失败" });
            throw new Error(
              `建隧道失败（退出码 ${cr.code ?? "未知"}），可手动运行：cloudflared tunnel create ${name}`,
            );
          }
          const id =
            extractTunnelId(`${cr.out}\n${cr.err}`) ??
            (await this.detectTunnel(name))?.id ??
            null;
          if (!id) {
            setStep(job, "tunnel", { state: "failed", detail: "未能捕获隧道 ID" });
            throw new Error("隧道已建但未能捕获隧道 ID，请刷新重试");
          }
          tunnel = { id, name };
          append(`隧道 ${name} 创建完成（ID：${id}）\n`);
        }
        setStep(job, "tunnel", { state: "done", detail: `已就绪（${tunnel.id.slice(0, 8)}…）` }, 52);

        // 4. 写 DNS 解析
        setStep(job, "dns", { state: "running", detail: `检查 ${hostname} 解析…` }, 58);
        append(`[2/4] 检查并写入 DNS 解析 ${hostname}...\n`);
        const dnsBefore = await this.checkDns(hostname, tunnel.id);
        if (dnsBefore.state === "occupied") {
          job.errorCode = "dns_occupied";
          job.suggestedHostname = this.suggestAltHostname(hostname);
          setStep(job, "dns", {
            state: "failed",
            detail: `子域名已被非隧道记录占用（建议改用 ${job.suggestedHostname}）`,
          });
          throw new Error(
            `子域名 ${hostname} 已被非隧道记录占用，建议改用 ${job.suggestedHostname} 或到 Cloudflare 后台清理`,
          );
        }
        if (dnsBefore.state !== "created") {
          const args = [
            "tunnel",
            "route",
            "dns",
            "--overwrite-dns",
            name,
            hostname,
          ];
          const rr = await this.runToText("cloudflared", args, 60_000, append);
          if (rr.code !== 0) {
            setStep(job, "dns", { state: "failed", detail: "写 DNS 解析失败" });
            throw new Error(
              `写解析失败（退出码 ${rr.code ?? "未知"}），可手动运行：cloudflared ${args.join(" ")}`,
            );
          }
          this.markRouted(hostname, tunnel.id);
        } else {
          append("DNS 解析已指向当前隧道，跳过\n");
        }
        setStep(job, "dns", { state: "done", detail: "DNS 已指向当前隧道" }, 68);

        // 5. 写入 config.yml
        setStep(job, "config", { state: "running", detail: "写入 config.yml…" }, 72);
        append("[3/4] 写入 config.yml...\n");
        const dir = this.cfDir();
        const credentialsFile = join(dir, `${tunnel.id}.json`);
        const cfgPath = join(dir, "config.yml");
        if (existsSync(cfgPath)) {
          copyFileSync(cfgPath, `${cfgPath}.bak`);
        }
        const yml = buildConfigYml({
          tunnelId: tunnel.id,
          hostname,
          credentialsFile,
        });
        atomicWriteFileSync(cfgPath, yml);
        append(`已写入 ${cfgPath}\n`);
        setStep(job, "config", { state: "done", detail: "config.yml 已写入" }, 78);

        // 6. 启动隧道（Windows 优先装服务；若取消 UAC 则自动降级为本页托管）
        setStep(
          job,
          "service",
          {
            state: this.deps.platform() === "win32" ? "waiting" : "running",
            detail:
              this.deps.platform() === "win32"
                ? "如弹出管理员授权框（UAC），请点「是」以开启开机自启…"
                : "正在拉起隧道…",
          },
          84,
        );
        append("[4/4] 启动隧道并做端到端公网体检...\n");
        let serviceWarn: string | null = null;
        if (this.deps.platform() === "win32") {
          try {
            await this.installWindowsServiceInternal(append);
            const svcNow = await this.detectService();
            if (svcNow.state !== "running") {
              serviceWarn = "Windows 服务未在运行，已自动切换为随本地服务托管运行";
              this.startRun(hostname);
            }
          } catch {
            serviceWarn = "未完成系统服务安装（可能取消了 UAC），已自动切换为随本地服务托管运行";
            this.startRun(hostname);
          }
        } else if (!this.childRunning()) {
          this.startRun(hostname);
        }
        setStep(
          job,
          "service",
          {
            state: serviceWarn ? "warn" : "done",
            detail: serviceWarn ?? "隧道服务运行中",
          },
          90,
        );

        // 7. 端到端公网体检（自动退避重试，避免刚写 DNS 误报 530）
        setStep(job, "e2e", { state: "running", detail: "正在等待公网边缘连通…" }, 94);
        let e2e = await this.probeE2e(hostname, activeToken);
        for (let i = 0; i < 5 && !e2e.ok && (e2e.httpStatus === null || e2e.httpStatus === 530); i += 1) {
          setStep(job, "e2e", {
            state: "running",
            detail: `DNS / 边缘连接预热中（第 ${i + 2}/6 次探测）…`,
          });
          await new Promise((res) => setTimeout(res, 3_000));
          e2e = await this.probeE2e(hostname, activeToken);
        }
        append(`公网体检结果：${e2e.detail}\n`);
        if (e2e.ok) {
          setStep(job, "e2e", { state: "done", detail: e2e.detail }, 100);
          return `一键配置全部完成：${e2e.detail}`;
        }
        setStep(job, "e2e", { state: "warn", detail: e2e.detail }, 100);
        return `配置已写入并启动隧道；公网体检提示：${e2e.detail}`;
      },
      (job) => {
        job.progress = 4;
        job.steps = initialSteps;
      },
    );
  }

  async diagnose(
    hostname: string,
    opts: {
      activeProfile: { id: string; label: string; token: string; everConnectedAt?: number | null } | null;
      profileLastSeenAt: number | null;
      envDriven: boolean;
      telemetry: {
        processStartedAt: number;
        lastInvalidTokenAt: number | null;
        lastInactiveVisit: { profileId: string; label: string; at: number } | null;
      };
      cachedStatus?: TunnelStatus;
    },
  ): Promise<DiagnosisReport> {
    const status =
      opts.cachedStatus ??
      (await this.status(hostname, opts.activeProfile?.token ?? null));
    const layers: DiagnosisLayer[] = [];

    // L1 本地账号档案
    if (!opts.activeProfile) {
      layers.push({
        id: "L1",
        title: "L1 · 本地账号档案",
        status: "error",
        detail: "尚未创建或启用任何桥账号档案。",
        fixAction: { id: "goto-wizard", label: "去创建账号" },
      });
    } else if (opts.envDriven) {
      layers.push({
        id: "L1",
        title: "L1 · 本地账号档案",
        status: "warn",
        detail: `当前由环境变量 YOYO_BRIDGE_TOKEN 临时接管（${opts.activeProfile.label}）。`,
        fixAction: null,
      });
    } else {
      layers.push({
        id: "L1",
        title: "L1 · 本地账号档案",
        status: "ok",
        detail: `当前启用账号：${opts.activeProfile.label}`,
        fixAction: null,
      });
    }

    // L2 工具与授权
    if (!status.installed.ok) {
      layers.push({
        id: "L2",
        title: "L2 · cloudflared 与授权",
        status: "error",
        detail: "本机未安装 cloudflared。",
        fixAction: { id: "install-cloudflared", label: "一键安装 cloudflared" },
      });
    } else if (!status.authorized) {
      layers.push({
        id: "L2",
        title: "L2 · cloudflared 与授权",
        status: "error",
        detail: "尚未完成 Cloudflare 登录授权（缺少 cert.pem）。",
        fixAction: { id: "login-cloudflare", label: "一键打开授权" },
      });
    } else {
      layers.push({
        id: "L2",
        title: "L2 · cloudflared 与授权",
        status: "ok",
        detail: `已安装（${status.installed.version ?? "可用"}），Cloudflare 授权已就位`,
        fixAction: null,
      });
    }

    // L3 隧道与配置文件
    if (!status.tunnel.ok) {
      layers.push({
        id: "L3",
        title: "L3 · 隧道与 config.yml",
        status: "error",
        detail: status.tunnel.existsRemote
          ? `云端已有隧道 ${status.tunnel.name}，但本机缺少凭据 .json；建议更换子域后缀重建。`
          : `尚未创建本机隧道 ${status.tunnel.name}。`,
        fixAction: status.tunnel.existsRemote
          ? { id: "goto-wizard", label: "更换子域重建" }
          : { id: "run-auto", label: "一键建隧道并配置" },
      });
    } else if (!status.config.ok) {
      layers.push({
        id: "L3",
        title: "L3 · 隧道与 config.yml",
        status: "error",
        detail: status.config.detail,
        fixAction: { id: "rewrite-config", label: "一键重写 config.yml" },
      });
    } else {
      layers.push({
        id: "L3",
        title: "L3 · 隧道与 config.yml",
        status: "ok",
        detail: `隧道 ${status.tunnel.name} 与 config.yml 一致`,
        fixAction: null,
      });
    }

    // L4 隧道运行态
    if (status.running.ok || status.service.state === "running") {
      layers.push({
        id: "L4",
        title: "L4 · 隧道运行态",
        status: "ok",
        detail:
          status.service.state === "running"
            ? "Windows 服务（Cloudflared）运行中"
            : status.running.detail,
        fixAction: null,
      });
    } else {
      layers.push({
        id: "L4",
        title: "L4 · 隧道运行态",
        status: "error",
        detail: `${status.running.detail}（${status.service.detail}）`,
        fixAction: status.config.ok
          ? { id: "start-tunnel", label: "一键拉起隧道" }
          : null,
      });
    }

    // L5 DNS 解析
    if (status.dns.state === "created") {
      layers.push({
        id: "L5",
        title: "L5 · 子域名 DNS 解析",
        status: "ok",
        detail: status.dns.detail,
        fixAction: null,
      });
    } else if (status.dns.state === "mismatch") {
      layers.push({
        id: "L5",
        title: "L5 · 子域名 DNS 解析",
        status: "error",
        detail: status.dns.detail,
        fixAction: status.tunnel.ok
          ? {
              id: "overwrite-dns",
              label: "覆盖写解析（--overwrite-dns）",
              dangerous: true,
              confirmText: `确认把 ${hostname} 的 DNS 覆盖指向当前隧道 ${status.tunnel.name}？`,
            }
          : null,
      });
    } else if (status.dns.state === "occupied") {
      layers.push({
        id: "L5",
        title: "L5 · 子域名 DNS 解析",
        status: "error",
        detail: status.dns.detail,
        fixAction: { id: "goto-wizard", label: "换个子域名" },
      });
    } else {
      layers.push({
        id: "L5",
        title: "L5 · 子域名 DNS 解析",
        status: "warn",
        detail: status.dns.detail,
        fixAction: status.tunnel.ok
          ? { id: "write-dns", label: "写入 DNS 解析" }
          : null,
      });
    }

    // L6 公网端到端自检
    if (status.e2e.ok) {
      layers.push({
        id: "L6",
        title: "L6 · 公网端到端可达性",
        status: "ok",
        detail: status.e2e.detail,
        fixAction: null,
      });
    } else {
      layers.push({
        id: "L6",
        title: "L6 · 公网端到端可达性",
        status: "error",
        detail: status.e2e.detail,
        fixAction: status.e2e.needsDnsOverwrite && status.tunnel.ok
          ? {
              id: "overwrite-dns",
              label: "覆盖写解析修复 530",
              dangerous: true,
              confirmText: `确认把 ${hostname} 的 DNS 覆盖指向当前隧道？`,
            }
          : status.config.ok && !status.running.ok
            ? { id: "start-tunnel", label: "一键启动隧道" }
            : null,
      });
    }

    // L7 云端 Muse 心跳与令牌匹配
    const now = Date.now();
    const BOOT_GRACE_MS = 2 * 60_000;
    const HEARTBEAT_TTL_MS = 3 * 60_000;
    const everConnected = Boolean(opts.activeProfile?.everConnectedAt);
    const inBootGrace =
      everConnected && now - opts.telemetry.processStartedAt < BOOT_GRACE_MS;
    const recentSeen =
      opts.profileLastSeenAt !== null &&
      now - opts.profileLastSeenAt < HEARTBEAT_TTL_MS;
    const recentInvalid =
      opts.telemetry.lastInvalidTokenAt !== null &&
      now - opts.telemetry.lastInvalidTokenAt < HEARTBEAT_TTL_MS;
    const recentInactive =
      opts.telemetry.lastInactiveVisit !== null &&
      now - opts.telemetry.lastInactiveVisit.at < HEARTBEAT_TTL_MS
        ? opts.telemetry.lastInactiveVisit
        : null;

    if (!opts.activeProfile || !status.tunnel.ok || !status.config.ok) {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "warn",
        detail: "完成本机隧道配置后，需在云端 Muse YoYo桥填入地址与令牌。",
        fixAction: null,
      });
    } else if (recentInvalid) {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "error",
        detail: "云端请求已到达本机，但令牌校验失败（401）。请核对 Muse 中粘贴的令牌。",
        fixAction: { id: "goto-wizard", label: "去核对/重置令牌" },
      });
    } else if (recentInactive && !recentSeen) {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "warn",
        detail: `收到另一账号「${recentInactive.label}」的桥请求，当前启用的是「${opts.activeProfile.label}」。`,
        fixAction: {
          id: `activate-profile:${recentInactive.profileId}`,
          label: `切换为「${recentInactive.label}」`,
        },
      });
    } else if (!everConnected) {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "warn",
        detail: "本地隧道已就绪，尚未收到云端 Muse 的首次配对连接。",
        fixAction: null,
      });
    } else if (recentSeen || inBootGrace) {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "ok",
        detail: recentSeen
          ? "Muse 心跳正常（近期已交互）"
          : "本地服务刚启动（宽限期内），隧道已就绪等待 Muse 轮询",
        fixAction: null,
      });
    } else {
      layers.push({
        id: "L7",
        title: "L7 · 云端 Muse 配对状态",
        status: "warn",
        detail: "超过 3 分钟未收到 Muse 心跳，可能已在 Muse 端取消配对或云端未开启同步。",
        fixAction: null,
      });
    }

    // 汇总五态（含连接中过渡态）
    const localConfigured =
      Boolean(opts.activeProfile) && status.tunnel.ok && status.config.ok;
    let state: BridgeSummaryState;
    if (!localConfigured) {
      state = "unconfigured";
    } else if (!everConnected && !recentSeen) {
      state = "unpaired";
    } else if (!status.e2e.ok && (this.isStartingUp() || this.anyJobRunning())) {
      state = "connecting";
    } else if (!status.e2e.ok || recentInvalid || (!recentSeen && !inBootGrace)) {
      state = "disconnected";
    } else {
      state = "connected";
    }

    const label =
      state === "unconfigured"
        ? "YoYo桥未配置"
        : state === "unpaired"
          ? "Muse YoYo桥未配对"
          : state === "connecting"
            ? "YoYo桥连接中…"
            : state === "disconnected"
              ? "YoYo桥连接已断开"
              : "YoYo桥已连接";

    const firstProblem = layers.find((l) => l.status !== "ok");
    const summary =
      state === "connected"
        ? "本地隧道与 Muse 配对均正常。"
        : state === "connecting"
          ? "正在连接本地隧道到 Cloudflare，请稍候…"
          : firstProblem?.detail ?? label;

    const canAutoFix = layers.some(
      (l) => l.status === "error" && l.fixAction !== null && !l.fixAction.dangerous && l.fixAction.id !== "goto-wizard",
    );

    return { state, label, summary, canAutoFix, layers, status };
  }

  async applyFix(
    fixId: string,
    hostname: string,
    activeToken?: string | null,
  ): Promise<{ ok: boolean; message: string; jobId?: number }> {
    switch (fixId) {
      case "start-tunnel": {
        this.manualStop = false;
        const msg = this.startRun(hostname);
        return { ok: true, message: msg };
      }
      case "install-service": {
        const job = this.startServiceInstall();
        return { ok: true, message: "正在安装并启动 Windows 服务…", jobId: job.id };
      }
      case "rewrite-config": {
        const job = this.startWriteConfig(hostname);
        return { ok: true, message: "正在重写 config.yml…", jobId: job.id };
      }
      case "write-dns": {
        const job = this.startRoute(hostname, false);
        return { ok: true, message: "正在写入 DNS 解析…", jobId: job.id };
      }
      case "overwrite-dns": {
        const job = this.startRoute(hostname, true);
        return { ok: true, message: "正在覆盖写入 DNS 解析…", jobId: job.id };
      }
      case "install-cloudflared": {
        const job = this.startInstall();
        return { ok: true, message: "正在安装 cloudflared…", jobId: job.id };
      }
      case "login-cloudflare": {
        const job = this.startLogin();
        return { ok: true, message: "正在打开 Cloudflare 授权…", jobId: job.id };
      }
      case "run-auto": {
        const job = this.startAutoSetup(hostname, activeToken);
        return { ok: true, message: "已启动一键配置向导…", jobId: job.id };
      }
      default:
        return { ok: false, message: `未知修复动作：${fixId}` };
    }
  }


  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private stopChildProcess(): boolean {
    if (!this.childRunning()) return false;
    this.child?.kill();
    return true;
  }

  async ensureRunning(hostname = this.savedHostname()): Promise<string | null> {
    if (this.ensureInFlight) return this.ensureInFlight;
    const task = (async (): Promise<string | null> => {
      if (this.manualStop || this.anyJobRunning() || this.childRunning()) {
        return null;
      }
      if (!this.hasLocalConfig(hostname)) {
        return null;
      }
      const svc = await this.detectService();
      if (svc.state === "running") {
        return null;
      }
      if (await this.deps.probe(hostname)) {
        return null;
      }
      return this.startRun(hostname);
    })().finally(() => {
      if (this.ensureInFlight === task) this.ensureInFlight = null;
    });
    this.ensureInFlight = task;
    return task;
  }

  tunnelLogTail(lines = 30): string[] {
    return this.childLog.slice(-lines);
  }

  startRun(hostname = this.savedHostname()): string {
    this.manualStop = false;
    this.clearRestartTimer();
    if (this.childRunning()) return "隧道已在由本页托管运行中";
    const name = this.tunnelName(hostname);
    const cfgPath = join(this.cfDir(), "config.yml");
    const args = existsSync(cfgPath)
      ? ["tunnel", "--config", cfgPath, "run", name]
      : ["tunnel", "run", name];
    let child: ChildProcess;
    try {
      child = this.deps.spawnTunnel
        ? this.deps.spawnTunnel(args)
        : spawn(resolveWinBin("cloudflared"), args, { windowsHide: true });
    } catch (err) {
      throw new Error(
        `拉起隧道失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.child = child;
    this.childLog = [];
    this.lastStartRunAt = Date.now();
    const startedAt = this.lastStartRunAt;
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
      if (this.manualStop || !this.hasLocalConfig(hostname)) return;
      if (Date.now() - startedAt > 30_000) this.restartAttempt = 0;
      const delayMs = Math.min(30_000, 5_000 * 2 ** this.restartAttempt);
      this.restartAttempt = Math.min(this.restartAttempt + 1, 3);
      this.childLog.push(`[将在 ${Math.round(delayMs / 1000)} 秒后自动重连]`);
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.ensureRunning(hostname).catch(() => {});
      }, delayMs);
    });
    return "隧道已拉起（本页托管），稍等几秒后看上方运行状态";
  }

  stopRun(): string {
    this.manualStop = true;
    this.clearRestartTimer();
    this.restartAttempt = 0;
    if (!this.stopChildProcess()) return "当前没有由本页托管的隧道进程";
    return "已停止本页托管的隧道进程";
  }
}

/** 管理页与端点共用的默认向导实例（真实依赖）。*/
export const tunnelWizard = new TunnelWizard();
