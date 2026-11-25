// [yoyo-local] Gemini 网页版 (gemini.google.com) 本地无头生图引擎：
//   - 零 Python、零额外浏览器下载：直接使用项目自带 Bun + 本机已装 Chrome / Edge（Win10/11 内置）
//   - 独立档案目录：`data/gemini-web-profile/`，不干扰用户日常浏览器
//   - 一键登录：弹出可见浏览器窗口打开 gemini.google.com，后端通过 CDP 自动检测登录完成并保存
//   - 按需静默生图：串行队列在后台无头拉起浏览器 → 输入提示词 → 等待并下载高清原图 → 立即关闭

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { DATA_DIR } from "./config";

export type GeminiWebConfig = {
  enabled: boolean;
};

export type BrowserInfo = {
  path: string;
  name: string;
};

export type GeminiWebStatus = {
  browserFound: boolean;
  browserName: string | null;
  browserPath: string | null;
  loggedIn: boolean;
  loginInProgress: boolean;
  enabled: boolean;
  ready: boolean;
  lastError: string | null;
  checkedAt: number;
};

const CONFIG_PATH = resolve(DATA_DIR, "gemini-web-config.json");
const PROFILE_DIR = resolve(DATA_DIR, "gemini-web-profile");
const DOWNLOAD_TMP_DIR = resolve(DATA_DIR, "gemini-web-downloads");
const GEMINI_URL = "https://gemini.google.com/app";
const LOGIN_URL =
  "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const STATUS_TTL_MS = 30_000;

const TEXTBOX_SEL =
  'rich-textarea div[contenteditable="true"], div[contenteditable="true"][role="textbox"], [role="textbox"]';
const COMPOSER_ROOT_SEL =
  'input-area-v2, .input-area-container, .input-area, chat-window-content, main';
const SIDEBAR_EXCLUDE_SEL =
  'bard-sidenav, sidenav, conversations-list, .conversations-container, .side-nav';
const SEND_BTN_SELECTORS = [
  'button.send-button',
  'button[aria-label="Send message"]',
  'button[aria-label="发送"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
];
const STOP_BTN_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="停止回答"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
];
const DOWNLOAD_BTN_SEL =
  'button[aria-label*="Download full size"], button[aria-label*="下载完整尺寸"], button[aria-label*="Download"], button[aria-label*="下载"], button[mattooltip*="Download"], button[mattooltip*="下载"], [data-test-id*="download"]';
const UPLOAD_TRIGGER_SELECTORS = [
  'button[aria-label*="上传和工具"]',
  'button[aria-label*="Open upload file menu"]',
  'button[aria-label*="Upload file"]',
  'button[aria-label*="Upload image"]',
  'button[aria-label*="Add file"]',
  'button[aria-label*="上传文件"]',
  'button[aria-label*="上传图片"]',
  'button.upload-card-button',
];
const IMAGE_TOOL_CHIP_SEL =
  'button[aria-label*="取消选择“图片”"], button[aria-label*="Deselect"], button[aria-label*="Remove image"]';
const IMAGE_TOOL_MENU_RE_SRC = '(制作图片|生成图片|Create images?|Generate images?)';

function buildScopedSelectorEval(selectors: string[]): string {
  return `((sels, tbSel, rootSel, sideSel) => {
    const tb = document.querySelector(tbSel);
    const root = (tb && tb.closest(rootSel)) || document;
    const pick = (scope) => {
      for (const s of sels) {
        const list = Array.from(scope.querySelectorAll(s));
        for (const el of list) {
          if (el.closest(sideSel)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
      }
      return null;
    };
    return pick(root) || pick(document);
  })(${JSON.stringify(selectors)}, ${JSON.stringify(TEXTBOX_SEL)}, ${JSON.stringify(COMPOSER_ROOT_SEL)}, ${JSON.stringify(SIDEBAR_EXCLUDE_SEL)})`;
}

export function resolveBrowserBin(
  platform = process.platform,
  env = process.env,
): BrowserInfo | null {
  const candidates: Array<{ path: string; name: string }> = [];
  if (platform === "win32") {
    const pf = env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localApp = env["LOCALAPPDATA"] || "";
    candidates.push(
      { path: join(pf, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" },
      { path: join(pf86, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" },
      ...(localApp
        ? [{ path: join(localApp, "Google", "Chrome", "Application", "chrome.exe"), name: "Google Chrome" }]
        : []),
      { path: join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" },
      { path: join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" },
      ...(localApp
        ? [{ path: join(localApp, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Microsoft Edge" }]
        : []),
    );
  } else if (platform === "darwin") {
    candidates.push(
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Microsoft Edge" },
    );
  } else {
    candidates.push(
      { path: "/usr/bin/google-chrome", name: "Google Chrome" },
      { path: "/usr/bin/chromium", name: "Chromium" },
      { path: "/usr/bin/microsoft-edge", name: "Microsoft Edge" },
    );
  }
  for (const item of candidates) {
    if (item.path && existsSync(item.path)) return item;
  }
  return null;
}

export function loadGeminiWebConfig(): GeminiWebConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<GeminiWebConfig>;
      return { enabled: raw.enabled === true };
    }
  } catch {
    // ignore corrupt config
  }
  return { enabled: false };
}

export function saveGeminiWebConfig(next: GeminiWebConfig): GeminiWebConfig {
  mkdirSync(DATA_DIR, { recursive: true });
  atomicWriteFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function hasSavedProfileCookies(): boolean {
  return (
    existsSync(join(PROFILE_DIR, "Default", "Cookies")) ||
    existsSync(join(PROFILE_DIR, "Default", "Network", "Cookies"))
  );
}

// ---- 串行锁与任务取消 ----

let lockChain: Promise<void> = Promise.resolve();

async function withBrowserLock<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("任务已取消");
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = lockChain;
  lockChain = prev.then(() => next, () => next);
  await prev;
  try {
    if (signal?.aborted) throw new Error("任务已取消");
    return await fn();
  } finally {
    release();
  }
}

const activeTasks = new Map<string, AbortController>();

export function registerGeminiWebTask(
  runner: (signal: AbortSignal) => Promise<void>,
): string {
  const taskId = `gweb-${randomUUID()}`;
  const controller = new AbortController();
  activeTasks.set(taskId, controller);
  void runner(controller.signal).finally(() => {
    activeTasks.delete(taskId);
  });
  return taskId;
}

export function cancelGeminiWebTask(taskId: string): void {
  const controller = activeTasks.get(taskId);
  if (controller) {
    controller.abort();
    activeTasks.delete(taskId);
  }
}

// ---- 轻量 CDP 客户端（原生 Bun WebSocket，零额外依赖） ----

type PendingCdp = {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCdp>();
  private eventListeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number") {
          const item = this.pending.get(msg.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              item.reject(new Error(msg.error.message || "CDP error"));
            } else {
              item.resolve(msg.result);
            }
          }
        } else if (typeof msg.method === "string") {
          for (const fn of this.eventListeners) {
            fn(msg.method, msg.params ?? {});
          }
        }
      } catch {
        // ignore malformed CDP message
      }
    });
    ws.addEventListener("close", () => {
      for (const [, item] of this.pending) {
        clearTimeout(item.timer);
        item.reject(new Error("浏览器连接已断开"));
      }
      this.pending.clear();
      this.eventListeners.clear();
    });
  }

  onEvent(fn: (method: string, params: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("连接浏览器调试端口超时")),
        timeoutMs,
      );
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectPromise(new Error("无法连接浏览器调试端口"));
        },
        { once: true },
      );
    });
    return new CdpSession(ws);
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolvePromise as (v: unknown) => void,
        reject: rejectPromise,
        timer,
      });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async evalJs<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "页面脚本执行异常",
      );
    }
    return res.result?.value as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

type LaunchedBrowser = {
  proc: ChildProcess;
  browserWsUrl: string;
  port: string;
  close: () => Promise<void>;
};

async function spawnCdpBrowser(opts: {
  browserPath: string;
  headless: boolean;
  startUrl: string;
  signal?: AbortSignal;
}): Promise<LaunchedBrowser> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    ...(opts.headless ? ["--headless=new"] : []),
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,900",
    opts.startUrl,
  ];
  const proc = spawn(opts.browserPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: opts.headless,
  });

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const browserWsUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
    let buf = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      rejectPromise(new Error(`启动浏览器调试端口超时：${buf.slice(-300)}`));
    }, 15_000);

    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m?.[1]) {
        clearTimeout(timer);
        resolvePromise(m[1]);
      }
    };
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`浏览器意外退出（code=${code}）：${buf.slice(-300)}`));
    });
  });

  const port = new URL(browserWsUrl).port;
  const close = async () => {
    opts.signal?.removeEventListener("abort", onAbort);
    if (proc.exitCode === null && !proc.killed) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1500);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
  };
  return { proc, browserWsUrl, port, close };
}

async function getPageWsUrl(port: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      const page =
        targets.find(
          (t) =>
            t.type === "page" &&
            t.webSocketDebuggerUrl &&
            !t.url?.startsWith("devtools://"),
        ) ?? targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // retry
    }
    await Bun.sleep(200);
  }
  throw new Error("未找到可用的浏览器标签页");
}

// ---- 状态探测与一键登录 ----

let cachedProbe: {
  loggedIn: boolean;
  lastError: string | null;
  checkedAt: number;
} | null = null;

let activeLogin: {
  proc: ChildProcess;
  close: () => Promise<void>;
} | null = null;

export function invalidateGeminiWebStatusCache(): void {
  cachedProbe = null;
}

async function checkPageState(pageCdp: CdpSession): Promise<{
  url: string;
  readyState: string;
  hasTextbox: boolean;
  hasSignIn: boolean;
}> {
  return pageCdp.evalJs(`(() => {
    const url = location.href;
    const readyState = document.readyState;
    const tb = document.querySelector(${JSON.stringify(TEXTBOX_SEL)});
    const hasTextbox = !!(tb && tb.getBoundingClientRect().width > 0);
    const hasServiceLogin = !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]');
    const btns = Array.from(document.querySelectorAll('a, button'));
    const hasSignInBtn = btns.some(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && /^(Sign in|登录)$/i.test((el.textContent || '').trim());
    });
    return { url, readyState, hasTextbox, hasSignIn: hasServiceLogin || hasSignInBtn };
  })()`);
}

async function probeGeminiWebLogin(): Promise<{
  loggedIn: boolean;
  lastError: string | null;
}> {
  const browser = resolveBrowserBin();
  if (!browser) {
    return { loggedIn: false, lastError: "未检测到本机 Chrome 或 Microsoft Edge" };
  }
  if (!hasSavedProfileCookies()) {
    return { loggedIn: false, lastError: "尚未登录 Google 账号" };
  }
  if (activeLogin) {
    return { loggedIn: false, lastError: "正在等待授权窗口完成登录" };
  }

  return withBrowserLock(async () => {
    const launched = await spawnCdpBrowser({
      browserPath: browser.path,
      headless: true,
      startUrl: GEMINI_URL,
    });
    let pageCdp: CdpSession | null = null;
    try {
      const wsUrl = await getPageWsUrl(launched.port);
      pageCdp = await CdpSession.connect(wsUrl);
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const st = await checkPageState(pageCdp).catch(() => null);
        if (st) {
          if (st.url.toLowerCase().includes("accounts.google.com")) {
            return { loggedIn: false, lastError: "登录态已失效，请重新登录" };
          }
          if (st.hasSignIn) {
            return { loggedIn: false, lastError: "尚未登录 Google 账号" };
          }
          if (st.readyState === "complete" && st.hasTextbox) {
            return { loggedIn: true, lastError: null };
          }
        }
        await Bun.sleep(500);
      }
      return {
        loggedIn: false,
        lastError: "检测 Gemini 网页超时，可能需要重新登录或过验证",
      };
    } catch (err) {
      return {
        loggedIn: false,
        lastError: err instanceof Error ? err.message : String(err),
      };
    } finally {
      pageCdp?.close();
      await launched.close();
    }
  });
}

export async function getGeminiWebStatus(
  forceRefresh = false,
): Promise<GeminiWebStatus> {
  const browser = resolveBrowserBin();
  const cfg = loadGeminiWebConfig();
  const hasCookies = hasSavedProfileCookies();

  let probe = cachedProbe;
  if (
    browser &&
    hasCookies &&
    !activeLogin &&
    (forceRefresh || !probe || Date.now() - probe.checkedAt > STATUS_TTL_MS)
  ) {
    const res = await probeGeminiWebLogin();
    probe = { ...res, checkedAt: Date.now() };
    cachedProbe = probe;
  } else if (!hasCookies) {
    probe = {
      loggedIn: false,
      lastError: browser ? "尚未登录 Google 账号" : "未检测到本机 Chrome 或 Edge",
      checkedAt: Date.now(),
    };
  }

  const loggedIn = Boolean(probe?.loggedIn);
  const ready = Boolean(browser && loggedIn && cfg.enabled);
  return {
    browserFound: Boolean(browser),
    browserName: browser?.name ?? null,
    browserPath: browser?.path ?? null,
    loggedIn,
    loginInProgress: Boolean(activeLogin),
    enabled: cfg.enabled,
    ready,
    lastError: probe?.lastError ?? null,
    checkedAt: probe?.checkedAt ?? Date.now(),
  };
}

export async function startGeminiWebLogin(): Promise<{
  ok: boolean;
  alreadyLoggedIn?: boolean;
  launched?: boolean;
  message: string;
}> {
  const browser = resolveBrowserBin();
  if (!browser) {
    return {
      ok: false,
      message: "未检测到 Google Chrome 或 Microsoft Edge，请先安装其中之一",
    };
  }
  if (activeLogin) {
    return {
      ok: true,
      launched: true,
      message: "登录窗口已打开，请在浏览器中完成 Google 账号登录",
    };
  }

  return withBrowserLock(async () => {
    const launched = await spawnCdpBrowser({
      browserPath: browser.path,
      headless: false,
      startUrl: LOGIN_URL,
    });
    activeLogin = { proc: launched.proc, close: launched.close };

    void (async () => {
      let pageCdp: CdpSession | null = null;
      try {
        const wsUrl = await getPageWsUrl(launched.port, 15_000);
        pageCdp = await CdpSession.connect(wsUrl);
        let stableCount = 0;
        while (launched.proc.exitCode === null && !launched.proc.killed) {
          const st = await checkPageState(pageCdp).catch(() => null);
          const isLoggedInPage =
            st &&
            st.readyState === "complete" &&
            st.url.toLowerCase().startsWith("https://gemini.google.com") &&
            !st.url.toLowerCase().includes("accounts.google.com") &&
            !st.hasSignIn &&
            st.hasTextbox;
          if (isLoggedInPage) {
            stableCount += 1;
            if (stableCount >= 2) {
              cachedProbe = { loggedIn: true, lastError: null, checkedAt: Date.now() };
              saveGeminiWebConfig({ enabled: true });
              await Bun.sleep(600);
              break;
            }
          } else {
            stableCount = 0;
          }
          await Bun.sleep(1000);
        }
      } catch {
        // user closed window manually
      } finally {
        pageCdp?.close();
        await launched.close();
        activeLogin = null;
        if (!cachedProbe?.loggedIn && hasSavedProfileCookies()) {
          invalidateGeminiWebStatusCache();
        }
      }
    })();

    return {
      ok: true,
      launched: true,
      message: `已打开 ${browser.name} 登录窗口，完成 Google 账号登录并跳转回 Gemini 对话界面后将自动保存并关闭`,
    };
  });
}

// ---- 按需无头生图 ----

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function findDownloadedFile(dir: string): string | null {
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".crdownload") || entry.endsWith(".tmp")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isFile() && st.size > 1024 && IMAGE_EXTS.has(extname(entry).toLowerCase())) {
        return full;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function generateImageWithGeminiWeb(opts: {
  prompt: string;
  ratio: string | null;
  refFilePaths: string[];
  outputDir: string;
  fileNameBase: string;
  signal?: AbortSignal;
}): Promise<{ filePath: string }> {
  const browser = resolveBrowserBin();
  if (!browser) {
    throw new Error("未检测到本机 Chrome 或 Microsoft Edge，无法使用 Gemini 网页生图");
  }
  if (activeLogin) {
    throw new Error("请先完成当前的 Gemini 网页授权登录");
  }

  const ratio = opts.ratio && opts.ratio.trim() ? opts.ratio.trim() : "16:9";
  const safeBase =
    opts.fileNameBase.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "gweb";

  return withBrowserLock(async () => {
    const launched = await spawnCdpBrowser({
      browserPath: browser.path,
      headless: true,
      startUrl: GEMINI_URL,
      signal: opts.signal,
    });
    const runDlDir = resolve(DOWNLOAD_TMP_DIR, randomUUID());
    let browserCdp: CdpSession | null = null;
    let pageCdp: CdpSession | null = null;

    try {
      mkdirSync(runDlDir, { recursive: true });
      browserCdp = await CdpSession.connect(launched.browserWsUrl);
      await browserCdp
        .send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: runDlDir,
          eventsEnabled: false,
        })
        .catch(() => {});

      const wsUrl = await getPageWsUrl(launched.port);
      pageCdp = await CdpSession.connect(wsUrl);
      await pageCdp.send("Page.enable");
      await pageCdp.send("DOM.enable");
      await pageCdp.send("Network.enable");

      const imageRequests = new Map<string, { requestId: string; mimeType: string }>();
      pageCdp.onEvent((method, params) => {
        if (method !== "Network.responseReceived") return;
        const requestId = typeof params.requestId === "string" ? params.requestId : "";
        const resp = params.response as { url?: string; mimeType?: string } | undefined;
        if (requestId && resp?.url && resp.mimeType?.startsWith("image/")) {
          imageRequests.set(resp.url, { requestId, mimeType: resp.mimeType });
        }
      });

      // 1. 等待输入框出现，校验登录态
      let ready = false;
      const loginDeadline = Date.now() + 15_000;
      while (Date.now() < loginDeadline) {
        if (opts.signal?.aborted) throw new Error("任务已取消");
        const st = await checkPageState(pageCdp).catch(() => null);
        if (st) {
          if (st.url.toLowerCase().includes("accounts.google.com") || st.hasSignIn) {
            cachedProbe = {
              loggedIn: false,
              lastError: "登录态已失效，请重新登录",
              checkedAt: Date.now(),
            };
            throw new Error(
              "Gemini 网页登录态已失效，请点击顶部「Gemini 网页」重新一键登录",
            );
          }
          if (st.readyState === "complete" && st.hasTextbox) {
            ready = true;
            break;
          }
        }
        await Bun.sleep(500);
      }
      if (!ready) {
        throw new Error(
          "未检测到 Gemini 对话输入框（可能触发人机验证或网络超时），请在顶部弹窗重新登录确认",
        );
      }

      // 2. 开启「制作图片」工具（避免复杂编辑/蒙版指令回落成纯文本模型拒答）
      const triggerFinder = buildScopedSelectorEval(UPLOAD_TRIGGER_SELECTORS);
      const imageToolActive = await pageCdp
        .evalJs<boolean>(`(() => {
          const tb = document.querySelector(${JSON.stringify(TEXTBOX_SEL)});
          const root = (tb && tb.closest(${JSON.stringify(COMPOSER_ROOT_SEL)})) || document;
          return !!root.querySelector(${JSON.stringify(IMAGE_TOOL_CHIP_SEL)});
        })()`)
        .catch(() => false);
      if (!imageToolActive) {
        const opened = await pageCdp
          .evalJs<boolean>(`(() => {
            const btn = ${triggerFinder};
            if (btn) { btn.click(); return true; }
            return false;
          })()`)
          .catch(() => false);
        if (opened) {
          let toolState: "clicked" | "already" | "missing" = "missing";
          const menuDeadline = Date.now() + 2_000;
          while (Date.now() < menuDeadline) {
            toolState = await pageCdp
              .evalJs<"clicked" | "already" | "missing">(`(() => {
                const re = new RegExp(${JSON.stringify(IMAGE_TOOL_MENU_RE_SRC)}, 'i');
                const items = Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"], .cdk-overlay-container button'));
                const target = items.find(el => re.test((el.textContent || '').trim()));
                if (!target) return 'missing';
                if (target.getAttribute('aria-checked') === 'true') return 'already';
                target.click();
                return 'clicked';
              })()`)
              .catch(() => "missing" as const);
            if (toolState !== "missing") break;
            await Bun.sleep(200);
          }
          if (toolState === "already" || toolState === "missing") {
            const menuOpen = await pageCdp
              .evalJs<boolean>("!!document.querySelector('.cdk-overlay-container [role=\"menu\"]')")
              .catch(() => false);
            if (menuOpen) {
              await pageCdp
                .send("Input.dispatchKeyEvent", {
                  type: "keyDown",
                  key: "Escape",
                  code: "Escape",
                  windowsVirtualKeyCode: 27,
                })
                .catch(() => {});
            }
          }
          await Bun.sleep(300);
        }
      }

      // 3. 若有参考图/蒙版图，展开上传菜单并定位 image/* 文件输入框，通过 CDP 注入文件并等待上传完成
      if (opts.refFilePaths.length > 0) {
        const uploadAttempt = async (): Promise<number | null> => {
          const doc = await pageCdp!.send<{ root: { nodeId: number } }>("DOM.getDocument");
          for (const sel of ['input[type="file"][accept*="image"]', 'input[type="file"]']) {
            const q = await pageCdp!
              .send<{ nodeId: number }>("DOM.querySelector", {
                nodeId: doc.root.nodeId,
                selector: sel,
              })
              .catch(() => ({ nodeId: 0 }));
            if (q.nodeId > 0) return q.nodeId;
          }
          return null;
        };
        let fileInputNodeId = await uploadAttempt();
        if (!fileInputNodeId) {
          for (let attempt = 0; attempt < 2 && !fileInputNodeId; attempt += 1) {
            await pageCdp.evalJs(`(() => {
              const btn = ${triggerFinder};
              if (btn) { btn.click(); return true; }
              return false;
            })()`);
            const waitEnd = Date.now() + 2_500;
            while (Date.now() < waitEnd) {
              await Bun.sleep(350);
              fileInputNodeId = await uploadAttempt();
              if (fileInputNodeId) break;
            }
          }
        }
        if (!fileInputNodeId) {
          throw new Error(
            "Gemini 网页端当前页面未找到图片上传入口，暂无法携带参考图或蒙版生成",
          );
        }
        await pageCdp.send("DOM.setFileInputFiles", {
          nodeId: fileInputNodeId,
          files: opts.refFilePaths,
        });
        const attachDeadline = Date.now() + 20_000;
        let lastAttach = { attached: 0, spinners: 0 };
        while (Date.now() < attachDeadline) {
          if (opts.signal?.aborted) throw new Error("任务已取消");
          lastAttach = await pageCdp
            .evalJs<{ attached: number; spinners: number }>(`(() => {
              const tb = document.querySelector(${JSON.stringify(TEXTBOX_SEL)});
              const root = (tb && tb.closest(${JSON.stringify(COMPOSER_ROOT_SEL)})) || document;
              const attached = root.querySelectorAll('gem-media-attachment, uploader-file-preview, user-query-file-preview').length;
              const spinners = root.querySelectorAll('mat-spinner, mat-progress-spinner, [role="progressbar"]').length;
              return { attached, spinners };
            })()`)
            .catch(() => ({ attached: 0, spinners: 1 }));
          if (lastAttach.attached >= opts.refFilePaths.length && lastAttach.spinners === 0) {
            break;
          }
          await Bun.sleep(350);
        }
        if (lastAttach.attached < opts.refFilePaths.length || lastAttach.spinners > 0) {
          throw new Error("Gemini 网页参考图上传未完成或超时，请稍后重试");
        }
        await Bun.sleep(350);
        const menuOpen = await pageCdp
          .evalJs<boolean>("!!document.querySelector('.cdk-overlay-container [role=\"menu\"]')")
          .catch(() => false);
        if (menuOpen) {
          await pageCdp
            .send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            })
            .catch(() => {});
          await Bun.sleep(200);
        }
      }

      // 3. 记录发送前已有 AI 回复与图片，严格排除用户提问区/附件区图片
      const EXCLUDED_ANCESTOR_SEL =
        "user-query, user-query-content, user-query-file-preview, user-query-file-carousel, gem-media-attachment, .user-query-container, .file-preview-container, .hidden-content-image-cache, sidenav-mavatar-footer";
      const MODEL_CONTAINER_SEL =
        "model-response, generated-image, .response-container, message-content";

      const beforeState = await pageCdp.evalJs<{
        srcs: string[];
        respCount: number;
      }>(`(() => {
        const srcs = Array.from(document.querySelectorAll('img'))
          .filter(i => {
            if (i.closest(${JSON.stringify(EXCLUDED_ANCESTOR_SEL)})) return false;
            return i.complete && i.naturalWidth >= 256 && i.naturalHeight >= 256;
          })
          .map(i => i.currentSrc || i.src || '');
        const respCount = document.querySelectorAll('model-response').length;
        return { srcs, respCount };
      })()`);
      const beforeSrcs = new Set(beforeState.srcs);

      // 4. 聚焦输入框并注入提示词
      const finalPrompt = /(?:image|draw|generate|picture|画|生成.*图|绘制)/i.test(
        opts.prompt,
      )
        ? `${opts.prompt.trim()}\n（画面比例 ${ratio}）`
        : `请直接生成图片（画面比例 ${ratio}）：${opts.prompt.trim()}`;

      await pageCdp.evalJs(`(() => {
        const tb = document.querySelector(${JSON.stringify(TEXTBOX_SEL)});
        if (!tb) throw new Error('textbox missing');
        tb.focus();
      })()`);
      await pageCdp.send("Input.insertText", { text: finalPrompt });
      await Bun.sleep(250);

      const sendFinder = buildScopedSelectorEval(SEND_BTN_SELECTORS);
      const clickedSend = await pageCdp.evalJs<boolean>(`(() => {
        const btn = ${sendFinder};
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
      })()`);
      if (!clickedSend) {
        await pageCdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await pageCdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      }

      // 5. 等待 AI 回复区生成图完成（严禁拾取提问气泡里的参考图）
      let targetSrc: string | null = null;
      let textOnlyPolls = 0;
      let lastModelText = "";
      const genDeadline = Date.now() + 120_000;
      while (Date.now() < genDeadline) {
        if (opts.signal?.aborted) throw new Error("任务已取消");
        const stopFinder = buildScopedSelectorEval(STOP_BTN_SELECTORS);
        const poll = await pageCdp.evalJs<{
          url: string;
          stopVisible: boolean;
          srcs: string[];
          respCount: number;
          modelText: string;
          hasPendingImage: boolean;
        }>(`(() => {
          const stop = ${stopFinder};
          const stopVisible = !!stop;
          const srcs = Array.from(document.querySelectorAll('img'))
            .filter(i => {
              if (i.closest(${JSON.stringify(EXCLUDED_ANCESTOR_SEL)})) return false;
              if (!i.closest(${JSON.stringify(MODEL_CONTAINER_SEL)})) return false;
              const s = i.currentSrc || i.src || '';
              return s && !s.includes('/a/') && i.complete && i.naturalWidth >= 256 && i.naturalHeight >= 256;
            })
            .map(i => i.currentSrc || i.src || '');
          const resps = document.querySelectorAll('model-response');
          const lastResp = resps[resps.length - 1];
          const hasPendingImage = !!lastResp && (
            !!lastResp.querySelector('generated-image, single-image, .generated-image, .loader, mat-spinner, mat-progress-spinner, [role="progressbar"]') ||
            Array.from(lastResp.querySelectorAll('img')).some(i => {
              if (i.closest(${JSON.stringify(EXCLUDED_ANCESTOR_SEL)})) return false;
              const s = i.currentSrc || i.src || '';
              return !s.includes('/a/') && (!i.complete || i.naturalWidth === 0);
            })
          );
          const contentEl = lastResp?.querySelector('message-content, .markdown, .model-response-text');
          const rawText = ((contentEl || lastResp)?.textContent || '').trim();
          const modelText = rawText.replace(/^Gemini\\s*(?:说|said)\\s*/i, '').trim();
          return { url: location.href, stopVisible, srcs, respCount: resps.length, modelText, hasPendingImage };
        })()`);

        if (poll.url.toLowerCase().includes("accounts.google.com")) {
          cachedProbe = {
            loggedIn: false,
            lastError: "生成过程中登录态失效",
            checkedAt: Date.now(),
          };
          throw new Error("Gemini 网页登录态已失效，请重新一键登录");
        }
        const fresh = poll.srcs.filter((s) => !beforeSrcs.has(s));
        if (fresh.length > 0 && !poll.stopVisible) {
          targetSrc = fresh[fresh.length - 1] ?? null;
          break;
        }
        if (
          fresh.length === 0 &&
          !poll.hasPendingImage &&
          poll.respCount > beforeState.respCount &&
          !poll.stopVisible &&
          poll.modelText.length > 0
        ) {
          lastModelText = poll.modelText;
          textOnlyPolls += 1;
          if (textOnlyPolls >= 4) {
            throw new Error(
              `Gemini 网页未返回图片，回复：${lastModelText.slice(0, 160)}`,
            );
          }
        } else {
          textOnlyPolls = 0;
        }
        await Bun.sleep(1000);
      }

      if (!targetSrc) {
        throw new Error(
          lastModelText
            ? `Gemini 网页未返回图片，回复：${lastModelText.slice(0, 160)}`
            : "等待 Gemini 网页生图超时或未返回图片（可能触发了内容安全策略或仅返回了文字）",
        );
      }

      // 6. 优先用真实鼠标悬停并点原图下载按钮；兜底走 CDP 缓存字节 / 服务端带 Cookie fetch（无 CORS 限制）
      mkdirSync(opts.outputDir, { recursive: true });
      const imgRect = await pageCdp.evalJs<{ x: number; y: number } | null>(`(() => {
        const imgs = Array.from(document.querySelectorAll('img'))
          .filter(i => (i.currentSrc || i.src) === ${JSON.stringify(targetSrc)});
        const target = imgs[imgs.length - 1];
        if (!target) return null;
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (imgRect) {
        await pageCdp
          .send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(imgRect.x),
            y: Math.round(imgRect.y),
          })
          .catch(() => {});
        await Bun.sleep(400);
      }

      const clickedDownload = await pageCdp.evalJs<boolean>(`(() => {
        const dlBtns = Array.from(document.querySelectorAll(${JSON.stringify(DOWNLOAD_BTN_SEL)}))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        const btn = dlBtns[dlBtns.length - 1];
        if (btn) { btn.click(); return true; }
        return false;
      })()`);

      if (clickedDownload) {
        const dlDeadline = Date.now() + 8_000;
        while (Date.now() < dlDeadline) {
          const dlFile = findDownloadedFile(runDlDir);
          if (dlFile) {
            const ext = extname(dlFile).toLowerCase() || ".png";
            const destPath = resolve(
              opts.outputDir,
              `${safeBase}-${randomUUID().slice(0, 8)}${ext}`,
            );
            copyFileSync(dlFile, destPath);
            return { filePath: destPath };
          }
          await Bun.sleep(300);
        }
      }

      const extFromMime = (mime: string): string => {
        const m = mime.toLowerCase();
        if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
        if (m.includes("webp")) return ".webp";
        return ".png";
      };

      const saveBuffer = (buf: Buffer, mime: string): { filePath: string } => {
        const destPath = resolve(
          opts.outputDir,
          `${safeBase}-${randomUUID().slice(0, 8)}${extFromMime(mime)}`,
        );
        writeFileSync(destPath, buf);
        return { filePath: destPath };
      };

      // 兜底 A：直接从浏览器已收到的网络响应取原始图片字节（零额外请求、零 CORS）
      const tracked = imageRequests.get(targetSrc);
      if (tracked) {
        try {
          const bodyRes = await pageCdp.send<{ body?: string; base64Encoded?: boolean }>(
            "Network.getResponseBody",
            { requestId: tracked.requestId },
            15_000,
          );
          if (bodyRes.body) {
            const buf = bodyRes.base64Encoded
              ? Buffer.from(bodyRes.body, "base64")
              : Buffer.from(bodyRes.body, "binary");
            if (buf.byteLength > 1024) {
              return saveBuffer(buf, tracked.mimeType);
            }
          }
        } catch {
          // fallback to server-side fetch
        }
      }

      // 兜底 B：data URI / 同源 blob URI
      if (targetSrc.startsWith("data:image/") || targetSrc.startsWith("blob:")) {
        const dataUrl = await pageCdp.evalJs<string>(`(async () => {
          const src = ${JSON.stringify(targetSrc)};
          if (src.startsWith('data:image/')) return src;
          const resp = await fetch(src);
          if (!resp.ok) throw new Error('fetch blob failed: ' + resp.status);
          const blob = await resp.blob();
          return await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result || ''));
            r.onerror = () => rej(new Error('FileReader failed'));
            r.readAsDataURL(blob);
          });
        })()`);
        const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (match?.[1] && match?.[2]) {
          return saveBuffer(Buffer.from(match[2], "base64"), `image/${match[1]}`);
        }
      }

      // 兜底 C：提取该 URL 对应的浏览器 Cookie，由 Bun 服务端直接 fetch（不受浏览器 CORS 限制）
      if (targetSrc.startsWith("http")) {
        const cookieRes = await pageCdp
          .send<{ cookies?: Array<{ name: string; value: string }> }>(
            "Network.getCookies",
            { urls: [targetSrc] },
          )
          .catch(() => ({ cookies: [] }));
        const cookieHeader = (cookieRes.cookies ?? [])
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const ua = await pageCdp
          .evalJs<string>("navigator.userAgent")
          .catch(() => "Mozilla/5.0");
        const resp = await fetch(targetSrc, {
          headers: {
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            Referer: "https://gemini.google.com/",
            "User-Agent": ua,
          },
          signal: opts.signal,
        });
        if (!resp.ok) {
          throw new Error(`下载 Gemini 图片失败（HTTP ${resp.status}）`);
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.byteLength <= 1024) {
          throw new Error("下载到的 Gemini 图片内容异常（文件过小）");
        }
        return saveBuffer(buf, resp.headers.get("content-type") ?? "image/png");
      }

      throw new Error(`不支持的图片地址格式：${targetSrc.slice(0, 80)}`);
    } finally {
      pageCdp?.close();
      browserCdp?.close();
      await launched.close();
      try {
        rmSync(runDlDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, opts.signal);
}

// ---- HTTP 路由 ----

export async function handleGeminiWeb(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/gemini-web/status") {
    const refresh = url.searchParams.get("refresh") === "1";
    const status = await getGeminiWebStatus(refresh);
    return Response.json(status);
  }

  if (req.method === "POST" && path === "/gemini-web/login") {
    const result = await startGeminiWebLogin();
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (req.method === "POST" && path === "/gemini-web/config") {
    const body = (await req.json().catch(() => null)) as { enabled?: boolean } | null;
    const cur = loadGeminiWebConfig();
    const nextEnabled =
      typeof body?.enabled === "boolean" ? body.enabled : cur.enabled;
    const saved = saveGeminiWebConfig({ enabled: nextEnabled });
    const status = await getGeminiWebStatus(false);
    return Response.json({ ok: true, config: saved, status });
  }

  if (req.method === "POST" && path === "/gemini-web/test") {
    const startedAt = Date.now();
    try {
      const probe = await probeGeminiWebLogin();
      cachedProbe = { ...probe, checkedAt: Date.now() };
      if (!probe.loggedIn) {
        return Response.json({
          ok: false,
          error: probe.lastError ?? "未登录 Gemini 网页",
          latencyMs: Date.now() - startedAt,
        });
      }
      return Response.json({
        ok: true,
        message: "已连接 Gemini 网页且登录态有效",
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

  return Response.json({ error: "unknown_gemini_web_route" }, { status: 404 });
}
