// [yoyo-local] Antigravity CLI (agy) 管理、一键部署/登录与本地执行引擎：
//   - 状态检测：本地二进制探测 + `agy models` 登录态与模型列表探测（带短期缓存）
//   - 配置持久化：`data/agy-config.json`（enabled / model / nodeEngines）
//   - 一键部署：`install.ps1` / `install.sh` 静默安装 + 自动写入 trustedWorkspaces + 默认启用
//   - 一键登录：Windows 拉起可见终端触发浏览器 OAuth，已登录桌面版/IDE 时自动免登
//   - 本地执行：文本/多模态推理（runAgyPrompt）、Agent 流式对话（streamAgyChat）、Nano Banana 生图（generateImageWithAgy）

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { DATA_DIR, PROJECTS_DIR } from "./config";

export type AgyEngine = "muse" | "agy";

export type AgyModelOption = {
  id: string;
  label: string;
};

export type AgyConfig = {
  enabled: boolean;
  model: string;
  nodeEngines: Record<string, AgyEngine>;
};

export type AgyWizardStep = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
};

export type AgyDeployJob = {
  id: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  message: string;
  steps: AgyWizardStep[];
};

export type AgyStatus = {
  installed: boolean;
  binPath: string | null;
  version: string | null;
  loggedIn: boolean;
  enabled: boolean;
  model: string;
  ready: boolean;
  models: AgyModelOption[];
  nodeEngines: Record<string, AgyEngine>;
  job: AgyDeployJob | null;
  lastError: string | null;
  checkedAt: number;
};

const CONFIG_PATH = resolve(DATA_DIR, "agy-config.json");
const PREFERRED_DEFAULT_MODELS = [
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-4-carbon-medium",
  "gemini-4-argon-medium",
];
const ALLOWED_IMAGE_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
]);
const STATUS_TTL_MS = 30_000;
const OUTPUT_TAIL = 4000;

export function resolveAgyBin(
  platform = process.platform,
  env = process.env,
  home = homedir(),
): string | null {
  const exe = platform === "win32" ? "agy.exe" : "agy";
  const pathSep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(pathSep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, exe);
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks =
    platform === "win32"
      ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "agy", "bin", "agy.exe")]
      : [join(home, ".local", "bin", "agy"), "/usr/local/bin/agy"];
  for (const p of fallbacks) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function parseAgyModelsOutput(raw: string): AgyModelOption[] {
  const out: AgyModelOption[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^fetching\b/i.test(trimmed)) continue;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx > 0) {
      const id = trimmed.slice(0, tabIdx).trim();
      const label = trimmed.slice(tabIdx + 1).trim() || id;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id, label });
      }
      continue;
    }
    const spaceMatch = trimmed.match(/^([a-z0-9][a-z0-9._-]+)\s{2,}(.+)$/i);
    if (spaceMatch?.[1] && spaceMatch[2]) {
      const id = spaceMatch[1].trim();
      const label = spaceMatch[2].trim();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, label });
      }
    }
  }
  return out;
}

export function pickDefaultAgyModel(models: AgyModelOption[]): string {
  for (const preferred of PREFERRED_DEFAULT_MODELS) {
    if (models.some((m) => m.id === preferred)) return preferred;
  }
  return models[0]?.id ?? "";
}

export function mapAspectRatioForAgy(ratio: string | null | undefined): string {
  const raw = String(ratio ?? "").trim();
  if (ALLOWED_IMAGE_RATIOS.has(raw)) return raw;
  if (raw === "21:9") return "16:9";
  return "16:9";
}

export function loadAgyConfig(): AgyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AgyConfig>;
      const nodeEngines: Record<string, AgyEngine> = {};
      if (raw.nodeEngines && typeof raw.nodeEngines === "object") {
        for (const [k, v] of Object.entries(raw.nodeEngines)) {
          if (v === "muse" || v === "agy") nodeEngines[k] = v;
        }
      }
      return {
        enabled: raw.enabled === true,
        model: typeof raw.model === "string" ? raw.model.trim() : "",
        nodeEngines,
      };
    }
  } catch {
    // ignore corrupt config
  }
  return { enabled: false, model: "", nodeEngines: {} };
}

export function saveAgyConfig(next: AgyConfig): AgyConfig {
  mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function getNodeEngine(
  nodeId: string,
  defaultEngine: AgyEngine = "muse",
): AgyEngine {
  const cfg = loadAgyConfig();
  const explicit = cfg.nodeEngines[nodeId];
  if (explicit === "agy" || explicit === "muse") return explicit;
  return defaultEngine;
}

export function setNodeEngine(nodeId: string, engine: AgyEngine): AgyConfig {
  const cfg = loadAgyConfig();
  // Explicitly persist both "muse" and "agy" so an image node switched
  // back to Muse does not fall back to the "agy" default when AGY is ready.
  cfg.nodeEngines[nodeId] = engine;
  return saveAgyConfig(cfg);
}

export function copyNodeEngine(fromNodeId: string, toNodeId: string): void {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
  const cfg = loadAgyConfig();
  const engine = cfg.nodeEngines[fromNodeId];
  if (engine === "agy" || engine === "muse") {
    cfg.nodeEngines[toNodeId] = engine;
    saveAgyConfig(cfg);
  }
}

export function ensureAgyTrustedWorkspaces(
  dirs: string[],
  home = homedir(),
): void {
  const cliDir = join(home, ".gemini", "antigravity-cli");
  const settingsPath = join(cliDir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    }
  } catch {
    current = {};
  }
  const existing = Array.isArray(current.trustedWorkspaces)
    ? current.trustedWorkspaces.filter((x): x is string => typeof x === "string")
    : [];
  const merged = [...existing];
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (!merged.includes(abs)) merged.push(abs);
  }
  if (!current.colorScheme) {
    current.colorScheme = "colorblind-friendly dark";
  }
  current.trustedWorkspaces = merged;
  mkdirSync(cliDir, { recursive: true });
  atomicWriteFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
}

type ExecResult = { code: number | null; out: string; err: string };

function execCmd(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, out, err: errText });
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(null);
    };
    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(null);
    }, opts?.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      errText += d.toString("utf8");
    });
    child.on("error", (err) => {
      errText = errText || err.message;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

type AgyProbe = {
  binPath: string | null;
  version: string | null;
  loggedIn: boolean;
  models: AgyModelOption[];
  lastError: string | null;
  checkedAt: number;
};

let cachedProbe: AgyProbe | null = null;

let probeInFlight: Promise<AgyProbe> | null = null;
let currentJob: AgyDeployJob | null = null;
let nextJobId = 1;
const activeTasks = new Map<string, AbortController>();

export function invalidateAgyStatusCache(): void {
  cachedProbe = null;
}

async function probeAgyLive(): Promise<AgyProbe> {
  const binPath = resolveAgyBin();
  if (!binPath) {
    const res = {
      binPath: null,
      version: null,
      loggedIn: false,
      models: [] as AgyModelOption[],
      lastError: null,
      checkedAt: Date.now(),
    };
    cachedProbe = res;
    return res;
  }
  const modelsRun = await execCmd(binPath, ["models"], { timeoutMs: 12_000 });
  const models = modelsRun.code === 0 ? parseAgyModelsOutput(modelsRun.out) : [];
  const loggedIn = modelsRun.code === 0 && models.length > 0;
  const rawErr = (modelsRun.err || modelsRun.out).trim();
  const lastError = loggedIn
    ? null
    : rawErr
      ? rawErr.slice(0, 300)
      : "agy CLI 尚未登录或无法拉取模型列表";
  const res = {
    binPath,
    version: null as string | null,
    loggedIn,
    models,
    lastError,
    checkedAt: Date.now(),
  };
  cachedProbe = res;
  return res;
}

export async function getAgyStatus(forceRefresh = false): Promise<AgyStatus> {
  if (forceRefresh) cachedProbe = null;
  let probe = cachedProbe;
  if (!probe || Date.now() - probe.checkedAt > STATUS_TTL_MS) {
    if (!probeInFlight) {
      probeInFlight = probeAgyLive().finally(() => {
        probeInFlight = null;
      });
    }
    probe = await probeInFlight;
  }
  const cfg = loadAgyConfig();
  const ready = Boolean(
    probe.binPath &&
      probe.loggedIn &&
      cfg.enabled &&
      cfg.model &&
      (probe.models.length === 0 || probe.models.some((m) => m.id === cfg.model)),
  );
  return {
    installed: Boolean(probe.binPath),
    binPath: probe.binPath,
    version: probe.version,
    loggedIn: probe.loggedIn,
    enabled: cfg.enabled,
    model: cfg.model,
    ready,
    models: probe.models,
    nodeEngines: cfg.nodeEngines,
    job: currentJob,
    lastError: probe.lastError,
    checkedAt: probe.checkedAt,
  };
}

export function isAgyReadySync(): boolean {
  const cfg = loadAgyConfig();
  if (!cfg.enabled || !cfg.model) return false;
  if (cachedProbe) {
    return Boolean(cachedProbe.binPath && cachedProbe.loggedIn);
  }
  return Boolean(resolveAgyBin());
}

export function startAgyInstallJob(): AgyDeployJob {
  if (currentJob && currentJob.status === "running") {
    return currentJob;
  }
  const steps: AgyWizardStep[] = [
    { key: "install", label: "检查/安装 agy CLI", state: "pending" },
    { key: "trust", label: "配置工作区信任与默认参数", state: "pending" },
    { key: "auth", label: "检测登录态与可用模型", state: "pending" },
  ];
  const job: AgyDeployJob = {
    id: nextJobId++,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: "",
    message: "开始部署 agy CLI…",
    steps,
  };
  currentJob = job;

  const append = (text: string) => {
    job.output = (job.output + text).slice(-OUTPUT_TAIL);
  };
  const setStep = (key: string, state: AgyWizardStep["state"], detail?: string) => {
    const s = job.steps.find((x) => x.key === key);
    if (s) {
      s.state = state;
      if (detail !== undefined) s.detail = detail;
    }
  };

  void (async () => {
    try {
      setStep("install", "running", "正在检测本机安装…");
      let bin = resolveAgyBin();
      if (bin) {
        append(`检测到已安装：${bin}\n`);
        setStep("install", "done", `已安装 (${bin})`);
      } else {
        setStep("install", "running", "正在从官方源下载安装 agy CLI…");
        if (process.platform === "win32") {
          const psCmd =
            "$ProgressPreference='SilentlyContinue'; irm https://antigravity.google/cli/install.ps1 | iex";
          append(`> powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"\n`);
          const res = await execCmd(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd],
            { timeoutMs: 300_000 },
          );
          append(res.out);
          if (res.err) append(res.err);
          bin = resolveAgyBin();
          if (res.code !== 0 || !bin) {
            throw new Error(
              `安装失败（退出码 ${res.code ?? "未知"}）。请检查网络或代理是否可访问 antigravity.google。`,
            );
          }
        } else {
          append("> bash -c \"curl -fsSL https://antigravity.google/cli/install.sh | bash\"\n");
          const res = await execCmd(
            "bash",
            ["-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
            { timeoutMs: 300_000 },
          );
          append(res.out);
          if (res.err) append(res.err);
          bin = resolveAgyBin();
          if (res.code !== 0 || !bin) {
            throw new Error(
              `安装失败（退出码 ${res.code ?? "未知"}）。请检查网络后重试。`,
            );
          }
        }
        setStep("install", "done", `安装成功 (${bin})`);
      }

      setStep("trust", "running", "写入工作区信任列表…");
      ensureAgyTrustedWorkspaces([DATA_DIR, PROJECTS_DIR]);
      append(`已将 ${DATA_DIR} 与 ${PROJECTS_DIR} 加入 ~/.gemini/antigravity-cli/settings.json 信任目录。\n`);
      setStep("trust", "done", "已配置工作区信任");

      setStep("auth", "running", "正在探测 agy 登录状态与模型…");
      invalidateAgyStatusCache();
      const status = await getAgyStatus(true);
      if (status.loggedIn) {
        const cur = loadAgyConfig();
        const chosenModel =
          cur.model && status.models.some((m) => m.id === cur.model)
            ? cur.model
            : pickDefaultAgyModel(status.models);
        saveAgyConfig({ ...cur, enabled: true, model: chosenModel });
        setStep(
          "auth",
          "done",
          `已登录，已自动启用模型 ${chosenModel}（共 ${status.models.length} 个可用）`,
        );
        job.message = "部署与配置完成，AGY 本地引擎已就绪";
      } else {
        setStep("auth", "done", "CLI 已就绪，请点击「一键登录」完成 Google 授权");
        job.message = "agy CLI 已安装完成，下一步请点「一键登录」完成账号授权";
      }
      job.status = "done";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const s of job.steps) {
        if (s.state === "running") {
          s.state = "failed";
          s.detail = msg;
        }
      }
      job.status = "failed";
      job.message = msg;
      append(`\n错误：${msg}\n`);
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

export async function launchAgyLogin(): Promise<{
  ok: boolean;
  alreadyLoggedIn?: boolean;
  launched?: boolean;
  message: string;
}> {
  const status = await getAgyStatus(true);
  if (!status.installed || !status.binPath) {
    return { ok: false, message: "尚未安装 agy CLI，请先点击「一键部署」" };
  }
  if (status.loggedIn) {
    const cur = loadAgyConfig();
    const chosenModel =
      cur.model && status.models.some((m) => m.id === cur.model)
        ? cur.model
        : pickDefaultAgyModel(status.models);
    if (!cur.enabled || !cur.model) {
      saveAgyConfig({ ...cur, enabled: true, model: chosenModel });
    }
    return {
      ok: true,
      alreadyLoggedIn: true,
      message: `检测到本地已有登录态，已启用模型 ${chosenModel}`,
    };
  }
  ensureAgyTrustedWorkspaces([DATA_DIR, PROJECTS_DIR]);
  if (process.platform === "win32") {
    const child = spawn(
      "cmd.exe",
      ["/c", "start", "AGY 登录授权", status.binPath],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.unref();
    invalidateAgyStatusCache();
    return {
      ok: true,
      launched: true,
      message: "已打开 AGY 授权终端与浏览器，请完成 Google 账号登录后等待状态自动刷新",
    };
  }
  return {
    ok: false,
    launched: false,
    message: `请在终端执行 ${status.binPath} 完成 Google 账号登录后，点此刷新状态`,
  };
}

export type AgyEnvelope = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  structured_output?: unknown;
  duration_seconds?: number;
};

export async function runAgyPrompt(opts: {
  prompt: string;
  model?: string;
  addDirs?: string[];
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  conversationId: string;
  response: string;
  structuredOutput: unknown;
}> {
  const bin = resolveAgyBin();
  if (!bin) {
    throw new Error("未找到 agy CLI，请先在顶部「AGY 引擎」一键部署");
  }
  const cfg = loadAgyConfig();
  const model = (opts.model || cfg.model).trim();
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  const timeoutSecs = Math.max(15, Math.round((opts.timeoutMs ?? 120_000) / 1000));
  args.push("--print-timeout", `${timeoutSecs}s`);
  if (opts.jsonSchema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  }
  const seenDirs = new Set<string>();
  for (const dir of opts.addDirs ?? []) {
    const abs = resolve(dir);
    if (!seenDirs.has(abs) && existsSync(abs)) {
      seenDirs.add(abs);
      args.push("--add-dir", abs);
    }
  }

  const run = await execCmd(bin, args, {
    timeoutMs: (opts.timeoutMs ?? 120_000) + 10_000,
    signal: opts.signal,
  });
  if (opts.signal?.aborted) {
    throw new DOMException("已手动停止", "AbortError");
  }
  const stdoutTrimmed = run.out.trim();
  let envelope: AgyEnvelope | null = null;
  if (stdoutTrimmed) {
    try {
      envelope = JSON.parse(stdoutTrimmed) as AgyEnvelope;
    } catch {
      const lines = stdoutTrimmed.split(/\r?\n/).reverse();
      for (const line of lines) {
        try {
          envelope = JSON.parse(line) as AgyEnvelope;
          break;
        } catch {
          // continue
        }
      }
    }
  }
  if (!envelope) {
    const errDetail = (run.err || stdoutTrimmed).trim().slice(0, 300);
    if (/authentication required/i.test(errDetail)) {
      invalidateAgyStatusCache();
      throw new Error("agy CLI 未登录或登录已过期，请重新在顶部「AGY 引擎」一键登录");
    }
    throw new Error(
      errDetail || `agy CLI 执行失败（退出码 ${run.code ?? "未知"}）`,
    );
  }
  if (envelope.status !== "SUCCESS") {
    const errMsg = envelope.error || run.err.trim() || `状态：${envelope.status ?? "ERROR"}`;
    if (/authentication required/i.test(errMsg)) {
      invalidateAgyStatusCache();
      throw new Error("agy CLI 未登录或登录已过期，请重新在顶部「AGY 引擎」一键登录");
    }
    throw new Error(`agy CLI 返回失败：${errMsg.slice(0, 300)}`);
  }
  return {
    conversationId: envelope.conversation_id ?? "",
    response: envelope.response ?? "",
    structuredOutput: envelope.structured_output ?? null,
  };
}

function findNewestBrainImage(conversationId: string): string | null {
  if (!conversationId) return null;
  const brainDir = join(homedir(), ".gemini", "antigravity-cli", "brain", conversationId);
  if (!existsSync(brainDir)) return null;
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  let bestPath: string | null = null;
  let bestMtime = 0;
  try {
    for (const entry of readdirSync(brainDir)) {
      const full = join(brainDir, entry);
      if (entry.startsWith(".")) continue;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (!imageExts.has(extname(entry).toLowerCase())) continue;
        if (st.mtimeMs >= bestMtime) {
          bestMtime = st.mtimeMs;
          bestPath = full;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
  return bestPath;
}

export async function generateImageWithAgy(opts: {
  prompt: string;
  ratio: string | null;
  refFilePaths: string[];
  outputDir: string;
  fileNameBase: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ filePath: string }> {
  const aspectRatio = mapAspectRatioForAgy(opts.ratio);
  const safeBase = opts.fileNameBase.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "nano_banana";
  const refSection =
    opts.refFilePaths.length > 0
      ? [
          `参考图片路径列表（必须严格按顺序作为 ImagePaths 传给 image-generator，并按画面描述执行编辑、遮罩局部修改或参考融合）：`,
          ...opts.refFilePaths.map((p, i) => `${i + 1}. ${p}`),
        ].join("\n")
      : "";

  const prompt = [
    `请调用 invoke_subagent（TypeName 必须为 "image-generator"）生成一张图片，不要修改任何代码文件，也不要跳过生图直接编造路径。`,
    `传递给 image-generator 的 Prompt 参数：`,
    `AspectRatio: ${aspectRatio}`,
    `ImageName: ${safeBase}`,
    refSection ? `ImagePaths: ${JSON.stringify(opts.refFilePaths)}` : `无参考图（纯文生图）。`,
    `画面描述：${opts.prompt}`,
    refSection,
    `拿到 image-generator 返回的已保存图片绝对路径后，严格按 schema 返回 JSON：{"filePath": "<图片绝对路径>"}。`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const addDirs = [opts.outputDir, ...opts.refFilePaths.map((p) => resolve(p, ".."))];
  const result = await runAgyPrompt({
    prompt,
    model: opts.model,
    addDirs,
    jsonSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
    timeoutMs: 180_000,
    signal: opts.signal,
  });

  const structured = result.structuredOutput as { filePath?: unknown } | null;
  let sourcePath =
    structured && typeof structured.filePath === "string"
      ? structured.filePath.trim()
      : "";
  if (!sourcePath || !existsSync(sourcePath)) {
    const match = result.response.match(/([A-Za-z]:\\[^\s"'`<>]+\.(?:png|jpg|jpeg|webp)|\/[^\s"'`<>]+\.(?:png|jpg|jpeg|webp))/i);
    if (match?.[1] && existsSync(match[1])) {
      sourcePath = match[1];
    }
  }
  if (!sourcePath || !existsSync(sourcePath)) {
    sourcePath = findNewestBrainImage(result.conversationId) ?? "";
  }
  if (!sourcePath || !existsSync(sourcePath)) {
    const resp = result.response.trim();
    if (/(?:safety|policy|refus|blocked|violat|prohibit|cannot generate|无法生成|安全策略|违规)/i.test(resp)) {
      throw new Error(`Nano Banana 拒绝生成（可能触发安全/人脸或内容策略）：${resp.slice(0, 180)}`);
    }
    throw new Error("Nano Banana 未产出有效的本地图片文件，请重试");
  }

  mkdirSync(opts.outputDir, { recursive: true });
  const ext = extname(sourcePath).toLowerCase() || ".png";
  const destPath = resolve(opts.outputDir, `${safeBase}-${randomUUID().slice(0, 8)}${ext}`);
  copyFileSync(sourcePath, destPath);
  return { filePath: destPath };
}

export function streamAgyChat(opts: {
  prompt: string;
  model?: string;
  addDirs?: string[];
  jsonSchema?: Record<string, unknown>;
  parseResponse: (rawText: string) => { reply: string; operations: unknown[] };
  abortSignal?: AbortSignal;
}): Response {
  const bin = resolveAgyBin();
  if (!bin) {
    return Response.json(
      { error: "未找到 agy CLI，请先在顶部「AGY 引擎」一键部署" },
      { status: 400 },
    );
  }
  const cfg = loadAgyConfig();
  const model = (opts.model || cfg.model).trim();
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "300s",
  ];
  if (model) args.push("--model", model);
  if (opts.jsonSchema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  }
  const seenDirs = new Set<string>();
  for (const dir of opts.addDirs ?? []) {
    const abs = resolve(dir);
    if (!seenDirs.has(abs) && existsSync(abs)) {
      seenDirs.add(abs);
      args.push("--add-dir", abs);
    }
  }

  const sseLine = (event: string, data: unknown): Uint8Array =>
    new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let child: ChildProcess | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onAbort = () => {
        try {
          child?.kill();
        } catch {
          // ignore
        }
      };
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          onAbort();
        } else {
          opts.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      let buffer = "";
      let errText = "";
      let totalChars = 0;
      let settled = false;

      const finishError = (msg: string) => {
        if (settled) return;
        settled = true;
        opts.abortSignal?.removeEventListener("abort", onAbort);
        controller.enqueue(sseLine("error", { error: msg }));
        controller.close();
      };

      const finishSuccess = (reply: string, operations: unknown[]) => {
        if (settled) return;
        settled = true;
        opts.abortSignal?.removeEventListener("abort", onAbort);
        controller.enqueue(sseLine("done", { reply, operations }));
        controller.close();
      };

      child.stderr?.on("data", (d: Buffer) => {
        errText += d.toString("utf8");
      });

      child.stdout?.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (obj.event === "step_update") {
            const su = obj.step_update as
              | { step_type?: string; text_delta?: string }
              | undefined;
            if (su?.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta) {
              totalChars += su.text_delta.length;
              controller.enqueue(
                sseLine("delta", { text: su.text_delta, totalChars }),
              );
            }
          } else if (obj.event === "result") {
            const res = obj.result as AgyEnvelope | undefined;
            if (!res || res.status !== "SUCCESS") {
              const errMsg = res?.error || errText.trim() || "agy CLI 执行失败";
              if (/authentication required/i.test(errMsg)) {
                invalidateAgyStatusCache();
              }
              finishError(errMsg.slice(0, 300));
              return;
            }
            const structured = res.structured_output as
              | { reply?: unknown; operations?: unknown }
              | undefined;
            if (
              structured &&
              typeof structured === "object" &&
              typeof structured.reply === "string"
            ) {
              const ops = Array.isArray(structured.operations)
                ? structured.operations
                : [];
              finishSuccess(structured.reply, ops);
              return;
            }
            const parsed = opts.parseResponse(res.response ?? "");
            finishSuccess(parsed.reply, parsed.operations);
            return;
          }
        }
      });

      child.on("error", (err) => {
        finishError(err.message);
      });

      child.on("close", (code) => {
        if (settled) return;
        if (opts.abortSignal?.aborted) {
          settled = true;
          controller.close();
          return;
        }
        const msg = errText.trim() || `agy CLI 意外退出（退出码 ${code ?? "未知"}）`;
        finishError(msg.slice(0, 300));
      });
    },
    cancel() {
      try {
        child?.kill();
      } catch {
        // ignore
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function registerAgyTask(runner: (signal: AbortSignal) => Promise<void>): string {
  const taskId = `agy-${randomUUID()}`;
  const controller = new AbortController();
  activeTasks.set(taskId, controller);
  void runner(controller.signal).finally(() => {
    activeTasks.delete(taskId);
  });
  return taskId;
}

export function cancelAgyTask(taskId: string): void {
  const controller = activeTasks.get(taskId);
  if (controller) {
    controller.abort();
    activeTasks.delete(taskId);
  }
}

export async function handleAgy(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/agy/status") {
    const refresh = url.searchParams.get("refresh") === "1";
    const status = await getAgyStatus(refresh);
    return Response.json(status);
  }

  if (req.method === "POST" && path === "/agy/install") {
    const job = startAgyInstallJob();
    return Response.json({ ok: true, job });
  }

  if (req.method === "POST" && path === "/agy/login") {
    const result = await launchAgyLogin();
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (req.method === "POST" && path === "/agy/config") {
    const body = (await req.json().catch(() => null)) as {
      enabled?: boolean;
      model?: string;
    } | null;
    const status = await getAgyStatus(false);
    const cur = loadAgyConfig();
    const nextModel =
      typeof body?.model === "string"
        ? body.model.trim()
        : cur.model || pickDefaultAgyModel(status.models);
    const nextEnabled =
      typeof body?.enabled === "boolean" ? body.enabled : cur.enabled;
    if (nextEnabled && !nextModel) {
      return Response.json(
        { error: "请先选择一个可用的 AGY 模型" },
        { status: 400 },
      );
    }
    const saved = saveAgyConfig({
      ...cur,
      enabled: nextEnabled,
      model: nextModel,
    });
    const refreshed = await getAgyStatus(false);
    return Response.json({ ok: true, config: saved, status: refreshed });
  }

  if (req.method === "POST" && path === "/agy/test") {
    const body = (await req.json().catch(() => null)) as { model?: string } | null;
    const startedAt = Date.now();
    try {
      const res = await runAgyPrompt({
        prompt: "Reply with exactly: OK",
        model: body?.model,
        timeoutMs: 30_000,
      });
      return Response.json({
        ok: true,
        message: `连接成功（${res.response.trim().slice(0, 40)}）`,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      return Response.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  if (req.method === "POST" && path === "/agy/node-engine") {
    const body = (await req.json().catch(() => null)) as {
      nodeId?: string;
      engine?: string;
    } | null;
    if (!body?.nodeId) {
      return Response.json({ error: "缺少 nodeId" }, { status: 400 });
    }
    if (body.engine !== "muse" && body.engine !== "agy") {
      return Response.json({ error: "engine 仅支持 muse 或 agy" }, { status: 400 });
    }
    if (body.engine === "agy") {
      const status = await getAgyStatus(false);
      if (!status.ready) {
        return Response.json(
          { error: "AGY CLI 尚未部署、登录或启用，暂不可选择" },
          { status: 400 },
        );
      }
    }
    const cfg = setNodeEngine(body.nodeId, body.engine);
    return Response.json({ ok: true, nodeEngines: cfg.nodeEngines });
  }

  return Response.json({ error: "unknown_agy_route" }, { status: 404 });
}
