import { useCallback, useEffect, useMemo, useState } from "react";
import { DialogShell } from "./DialogShell";
import { StageshowPasteDemo } from "./StageshowPasteDemo";

const DEFAULT_SUFFIX = ".ck971.cc.cd";

export type BridgeSummaryState =
  | "unconfigured"
  | "unpaired"
  | "connecting"
  | "disconnected"
  | "connected";

export type BridgeSummary = {
  state: BridgeSummaryState;
  label: string;
  summary: string;
  hostname: string;
  activeProfile: {
    id: string;
    label: string;
    maskedToken: string;
    lastSeenAt: number | null;
    everConnectedAt: number | null;
  } | null;
  jobRunning: boolean;
};

type WizardStep = {
  key: string;
  label: string;
  state: "pending" | "running" | "waiting" | "done" | "warn" | "failed";
  detail?: string;
  actionUrl?: string;
};

type Job = {
  id: number;
  kind: string;
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

type DiagnosisLayer = {
  id: string;
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

type DiagnosisReport = {
  state: BridgeSummaryState;
  label: string;
  summary: string;
  canAutoFix: boolean;
  layers: DiagnosisLayer[];
};

type ProfileItem = {
  id: string;
  label: string;
  maskedToken: string;
  createdAt: number;
  lastSeenAt: number | null;
  everConnectedAt: number | null;
};

type BridgeAdminState = {
  hostname: string;
  envDriven: boolean;
  activeProfileId: string | null;
  profiles: ProfileItem[];
  diagnosis: DiagnosisReport;
  jobs: Job[];
  tunnelLogTail: string[];
  counts: { queued: number; claimed: number };
  childRunning: boolean;
  manualStop: boolean;
};

type TabKey = "wizard" | "diagnose" | "accounts";

function splitHostname(hostname: string): { prefix: string; isCustom: boolean } {
  const norm = hostname.trim().toLowerCase();
  if (norm.endsWith(DEFAULT_SUFFIX) && norm.length > DEFAULT_SUFFIX.length) {
    const prefix = norm.slice(0, -DEFAULT_SUFFIX.length);
    if (!prefix.includes(".")) return { prefix, isCustom: false };
  }
  return { prefix: norm, isCustom: true };
}

function fmtTime(ts: number | null): string {
  if (!ts) return "从未";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function BridgeSetupModal({
  open,
  onClose,
  onSummaryChange,
  showToast,
}: {
  open: boolean;
  onClose: () => void;
  onSummaryChange: () => void;
  showToast: (msg: string) => void;
}) {
  const [data, setData] = useState<BridgeAdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("wizard");
  const [tabInitialized, setTabInitialized] = useState(false);

  const [label, setLabel] = useState("主账号");
  const [prefixInput, setPrefixInput] = useState("yoyo-bridge");
  const [customDomain, setCustomDomain] = useState(false);
  const [formInitialized, setFormInitialized] = useState(false);

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [newProfileLabel, setNewProfileLabel] = useState("");

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/bridge-admin/api/state");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as BridgeAdminState;
      setData(json);
      if (!tabInitialized) {
        setTab(
          json.diagnosis.state === "unconfigured" ||
            json.diagnosis.state === "unpaired"
            ? "wizard"
            : "diagnose",
        );
        setTabInitialized(true);
      }
      if (!formInitialized) {
        const active = json.profiles.find((p) => p.id === json.activeProfileId);
        if (active?.label) setLabel(active.label);
        const split = splitHostname(json.hostname);
        setPrefixInput(split.prefix);
        setCustomDomain(split.isCustom);
        setFormInitialized(true);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "加载桥状态失败");
    } finally {
      setLoading(false);
    }
  }, [formInitialized, tabInitialized]);

  useEffect(() => {
    if (!open) {
      setTabInitialized(false);
      setFormInitialized(false);
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    void fetchState();
  }, [open, fetchState]);

  const activeAutoJob = useMemo(() => {
    const jobs = data?.jobs ?? [];
    return jobs.find((j) => j.kind === "auto") ?? jobs[0] ?? null;
  }, [data?.jobs]);

  const anyRunning = useMemo(
    () => (data?.jobs ?? []).some((j) => j.status === "running"),
    [data?.jobs],
  );

  // 向导运行中每 1.5s 轮询，等待 Muse 配对时每 4s 轮询监听心跳
  useEffect(() => {
    if (!open) return;
    const waitingPairing = data?.diagnosis.state === "unpaired";
    if (!anyRunning && !waitingPairing) return;
    const timer = window.setInterval(() => {
      void fetchState();
      onSummaryChange();
    }, anyRunning ? 1500 : 4000);
    return () => window.clearInterval(timer);
  }, [open, anyRunning, data?.diagnosis.state, fetchState, onSummaryChange]);

  const fullHostname = useMemo(() => {
    const clean = prefixInput.trim().toLowerCase();
    if (customDomain) return clean;
    return clean ? `${clean}${DEFAULT_SUFFIX}` : "";
  }, [customDomain, prefixInput]);

  const copyText = async (text: string, hint: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(hint);
    } catch {
      showToast("复制失败，请手动选中复制");
    }
  };

  const startWizard = async (overrideHostname?: string) => {
    const targetHost = (overrideHostname ?? fullHostname).trim().toLowerCase();
    if (!targetHost || !targetHost.includes(".")) {
      setErrorMsg("请先填写有效的子域名前缀（只含字母、数字、连字符）");
      return;
    }
    setErrorMsg(null);
    setBusyAction("wizard");
    try {
      const res = await fetch("/bridge-admin/api/wizard/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || "主账号",
          hostname: targetHost,
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        plainToken?: string | null;
      };
      if (!res.ok) throw new Error(json.error ?? "启动向导失败");
      if (json.plainToken) setSessionToken(json.plainToken);
      if (overrideHostname) {
        const split = splitHostname(overrideHostname);
        setPrefixInput(split.prefix);
        setCustomDomain(split.isCustom);
      }
      await fetchState();
      onSummaryChange();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "启动向导失败");
    } finally {
      setBusyAction(null);
    }
  };

  const runDiagnose = async () => {
    setErrorMsg(null);
    setBusyAction("diagnose");
    try {
      const res = await fetch("/bridge-admin/api/diagnose", { method: "POST" });
      const json = (await res.json()) as {
        diagnosis?: DiagnosisReport;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "检测失败");
      await fetchState();
      onSummaryChange();
      showToast("已完成全链路检测");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "检测失败");
    } finally {
      setBusyAction(null);
    }
  };

  const runFix = async (
    fixId: string,
    opts?: { dangerous?: boolean; confirmText?: string },
  ) => {
    if (fixId === "goto-wizard") {
      setTab("wizard");
      return;
    }
    if (opts?.dangerous && !window.confirm(opts.confirmText ?? "确认执行此修复操作？")) {
      return;
    }
    setErrorMsg(null);
    setBusyAction(fixId);
    try {
      const res = await fetch("/bridge-admin/api/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixId, confirm: Boolean(opts?.dangerous) }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? json.message ?? "修复失败");
      showToast(json.message ?? "已执行修复");
      await fetchState();
      onSummaryChange();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "修复失败");
    } finally {
      setBusyAction(null);
    }
  };

  const copyDiagnosticReport = async () => {
    if (!data) return;
    const lines = [
      `YoYo桥诊断报告 (${new Date().toLocaleString("zh-CN", { hour12: false })})`,
      `状态: ${data.diagnosis.label} (${data.diagnosis.state})`,
      `域名: ${data.hostname}`,
      `任务队列: 排队 ${data.counts.queued} / 在途 ${data.counts.claimed}`,
      "",
      ...data.diagnosis.layers.map(
        (l) => `[${l.status.toUpperCase()}] ${l.title}: ${l.detail}`,
      ),
    ];
    if (data.tunnelLogTail.length) {
      lines.push("", "--- 最近隧道日志 ---", ...data.tunnelLogTail.slice(-12));
    }
    await copyText(lines.join("\n"), "已复制脱敏诊断报告");
  };

  const handleProfileAction = async (
    action: "add" | "activate" | "rename" | "delete",
    payload: Record<string, unknown>,
  ) => {
    setErrorMsg(null);
    setBusyAction(action);
    try {
      const res = await fetch(`/bridge-admin/api/profiles/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        error?: string;
        plainToken?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "操作失败");
      if (json.plainToken) setSessionToken(json.plainToken);
      if (action === "add") setNewProfileLabel("");
      await fetchState();
      onSummaryChange();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };

  if (!open) return null;

  const diag = data?.diagnosis;
  const activeProfile = data?.profiles.find((p) => p.id === data.activeProfileId) ?? null;
  const showMusePasteCard =
    diag?.state === "unpaired" ||
    diag?.state === "connected" ||
    (activeAutoJob?.kind === "auto" && activeAutoJob.status === "done");

  return (
    <DialogShell
      title="YoYo桥配置与诊断"
      description="把本地画布连接到云端 Muse，只需填好备注名与子域名即可一键完成。"
      onClose={() => {
        onSummaryChange();
        onClose();
      }}
      wide
    >
      {/* 顶部状态总览 + Tab */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              diag?.state === "connected"
                ? "bg-[var(--teal-soft)] text-[var(--teal)]"
                : diag?.state === "disconnected"
                  ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "bg-[var(--accent-soft)] text-[var(--accent)]"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                diag?.state === "connected"
                  ? "bg-[var(--ok)]"
                  : diag?.state === "disconnected"
                    ? "bg-[var(--danger)]"
                    : "bg-[var(--accent)]"
              }`}
            />
            {diag?.label ?? "检测中…"}
          </span>
          {activeProfile ? (
            <span className="text-xs text-[var(--dim)]">
              当前账号：{activeProfile.label}
            </span>
          ) : null}
        </div>

        <div className="flex gap-1 rounded-lg bg-[var(--surface-2)] p-1 text-xs">
          {(
            [
              ["wizard", "配置向导"],
              ["diagnose", "一键检测与修复"],
              ["accounts", "账号与日志"],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                tab === key
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                  : "text-[var(--dim)] hover:text-[var(--text)]"
              }`}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {errorMsg ? (
        <div className="mb-3 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {errorMsg}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-10 text-center text-sm text-[var(--dim)]">
          正在读取本地隧道与桥状态…
        </div>
      ) : null}

      {/* Tab 1: 极简向导 */}
      {data && tab === "wizard" ? (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 sm:grid-cols-12">
            <div className="sm:col-span-4">
              <label className="mb-1 block text-xs font-medium text-[var(--dim)]">
                账号备注名
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如：主账号"
                disabled={anyRunning}
                className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="sm:col-span-8">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-[var(--dim)]">
                  本机专属子域名
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (customDomain) {
                      const split = splitHostname(prefixInput);
                      setPrefixInput(split.prefix);
                      setCustomDomain(false);
                    } else {
                      setPrefixInput(fullHostname);
                      setCustomDomain(true);
                    }
                  }}
                  className="text-[11px] text-[var(--accent)] hover:underline"
                >
                  {customDomain ? "切回默认后缀" : "自定义完整域名"}
                </button>
              </div>
              <div className="flex items-center">
                <input
                  type="text"
                  value={prefixInput}
                  onChange={(e) => setPrefixInput(e.target.value)}
                  placeholder={customDomain ? "yoyo-bridge.example.com" : "xiaoming"}
                  disabled={anyRunning}
                  className={`h-9 min-w-0 flex-1 border border-[var(--border)] bg-[var(--surface)] px-2.5 text-sm outline-none focus:border-[var(--accent)] ${
                    customDomain ? "rounded-lg" : "rounded-l-lg border-r-0"
                  }`}
                />
                {!customDomain ? (
                  <span className="flex h-9 items-center rounded-r-lg border border-[var(--border)] bg-[var(--surface-3)] px-2.5 text-xs text-[var(--dim)]">
                    {DEFAULT_SUFFIX}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-12">
              <span className="text-xs text-[var(--dim)]">
                将自动完成：安装工具 → Cloudflare 授权 → 建隧道 → 写解析 → 写配置 → 启服务 → 公网体检
              </span>
              <button
                type="button"
                disabled={anyRunning || busyAction === "wizard"}
                onClick={() => void startWizard()}
                className="h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {anyRunning ? "正在自动配置…" : "开始一键配置"}
              </button>
            </div>
          </div>

          {/* 进度条与步骤列表 */}
          {activeAutoJob?.steps ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium">
                  {activeAutoJob.status === "running"
                    ? "正在执行自动配置…"
                    : activeAutoJob.status === "done"
                      ? "本机配置已完成"
                      : "配置在某一步暂停"}
                </span>
                <span className="font-mono text-[var(--dim)]">
                  {activeAutoJob.progress ?? 0}%
                </span>
              </div>
              <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    activeAutoJob.status === "failed"
                      ? "bg-[var(--danger)]"
                      : activeAutoJob.status === "done"
                        ? "bg-[var(--ok)]"
                        : "bg-[var(--accent)]"
                  }`}
                  style={{ width: `${activeAutoJob.progress ?? 0}%` }}
                />
              </div>

              <div className="space-y-1.5">
                {activeAutoJob.steps.map((s) => (
                  <div
                    key={s.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface)] px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block w-4 text-center font-bold ${
                          s.state === "done"
                            ? "text-[var(--ok)]"
                            : s.state === "failed"
                              ? "text-[var(--danger)]"
                              : s.state === "warn"
                                ? "text-[var(--accent)]"
                                : s.state === "running" || s.state === "waiting"
                                  ? "text-[var(--accent)]"
                                  : "text-[var(--dim)]"
                        }`}
                      >
                        {s.state === "done"
                          ? "✓"
                          : s.state === "failed"
                            ? "✕"
                            : s.state === "warn"
                              ? "!"
                              : s.state === "running" || s.state === "waiting"
                                ? "◌"
                                : "·"}
                      </span>
                      <span className="font-medium">{s.label}</span>
                      {s.detail ? (
                        <span className="text-[var(--dim)]">— {s.detail}</span>
                      ) : null}
                    </div>
                    {s.actionUrl ? (
                      <a
                        href={s.actionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent-ink)]"
                      >
                        打开 Cloudflare 授权页
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>

              {activeAutoJob.status === "failed" && activeAutoJob.suggestedHostname ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-3 py-2 text-xs">
                  <span>{activeAutoJob.message}</span>
                  <button
                    type="button"
                    onClick={() => void startWizard(activeAutoJob.suggestedHostname!)}
                    className="rounded bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--accent-ink)]"
                  >
                    改用 {activeAutoJob.suggestedHostname} 重试
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 最后一步：去 Muse 粘贴地址与令牌 + Stageshow 迷你动效 */}
          {showMusePasteCard ? (
            <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    {diag?.state === "connected"
                      ? "🎉 Muse 已成功配对连接"
                      : "最后一步：去云端 Muse「YoYo桥」填入以下两项"}
                  </div>
                  <div className="text-xs text-[var(--dim)]">
                    {diag?.state === "connected"
                      ? "本机已收到 Muse 心跳，现在可以直接在画布里使用云端生图。"
                      : "正在实时监听 Muse 连接，你在 Muse 点保存后这里会自动变为「已连接」…"}
                  </div>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-[11px] text-[var(--dim)]">1. 隧道地址</div>
                    <div className="truncate font-mono font-medium">
                      https://{data.hostname}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(`https://${data.hostname}`, "已复制隧道地址")
                    }
                    className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 hover:bg-[var(--hover)]"
                  >
                    复制地址
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-[11px] text-[var(--dim)]">2. 桥令牌</div>
                    <div className="truncate font-mono font-medium">
                      {sessionToken
                        ? `${sessionToken.slice(0, 6)}••••${sessionToken.slice(-4)}`
                        : activeProfile?.maskedToken ?? "未生成"}
                    </div>
                  </div>
                  {sessionToken ? (
                    <button
                      type="button"
                      onClick={() => void copyText(sessionToken, "已复制桥令牌")}
                      className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--accent-ink)]"
                    >
                      复制令牌
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startWizard()}
                      className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 hover:bg-[var(--hover)]"
                    >
                      重新生成
                    </button>
                  )}
                </div>
              </div>

              <StageshowPasteDemo hostname={data.hostname} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Tab 2: 7层一键检测与修复 */}
      {data && tab === "diagnose" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="text-xs text-[var(--dim)]">{diag?.summary}</div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void runDiagnose()}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium hover:bg-[var(--hover)] disabled:opacity-50"
              >
                {busyAction === "diagnose" ? "检测中…" : "一键检测"}
              </button>
              {diag?.canAutoFix ? (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void runFix("auto-safe")}
                  className="h-8 rounded-lg bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50"
                >
                  {busyAction === "auto-safe" ? "修复中…" : "一键自动修复"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void copyDiagnosticReport()}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--dim)] hover:bg-[var(--hover)]"
              >
                复制诊断报告
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {diag?.layers.map((layer) => (
              <div
                key={layer.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        layer.status === "ok"
                          ? "bg-[var(--teal-soft)] text-[var(--teal)]"
                          : layer.status === "error"
                            ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                            : "bg-[var(--accent-soft)] text-[var(--accent)]"
                      }`}
                    >
                      {layer.status === "ok"
                        ? "正常"
                        : layer.status === "error"
                          ? "异常"
                          : "注意"}
                    </span>
                    <span className="font-medium">{layer.title}</span>
                  </div>
                  <div className="mt-1 text-[var(--dim)]">{layer.detail}</div>
                </div>
                {layer.fixAction ? (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void runFix(layer.fixAction!.id, layer.fixAction!)}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${
                      layer.fixAction.dangerous
                        ? "border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                        : "bg-[var(--accent)] text-[var(--accent-ink)] hover:opacity-90"
                    }`}
                  >
                    {busyAction === layer.fixAction.id ? "处理中…" : layer.fixAction.label}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Tab 3: 账号与日志 */}
      {data && tab === "accounts" ? (
        <div className="space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <span>
              桥任务：排队中 <strong>{data.counts.queued}</strong> 个 · 在途{" "}
              <strong>{data.counts.claimed}</strong> 个
            </span>
            <a
              href="/bridge-admin"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              打开独立高级管理页 ↗
            </a>
          </div>

          <div className="space-y-2">
            {data.profiles.map((p) => {
              const isActive = p.id === data.activeProfileId;
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.label}</span>
                      {isActive ? (
                        <span className="rounded bg-[var(--teal-soft)] px-1.5 py-0.5 text-[10px] text-[var(--teal)]">
                          当前启用
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--dim)]">
                      {p.maskedToken} · 最近在线：{fmtTime(p.lastSeenAt)}
                    </div>
                  </div>
                  {!data.envDriven ? (
                    <div className="flex gap-1.5">
                      {!isActive ? (
                        <button
                          type="button"
                          onClick={() =>
                            void handleProfileAction("activate", { id: p.id })
                          }
                          className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--hover)]"
                        >
                          设为当前
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`确认删除账号「${p.label}」？`)) {
                            void handleProfileAction("delete", { id: p.id });
                          }
                        }}
                        className="rounded border border-[var(--danger)]/35 px-2 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                      >
                        删除
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {!data.envDriven ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={newProfileLabel}
                onChange={(e) => setNewProfileLabel(e.target.value)}
                placeholder="新增账号备注名（如：备用账号）"
                className="h-8 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs outline-none focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() =>
                  void handleProfileAction("add", { label: newProfileLabel })
                }
                className="h-8 rounded-lg bg-[var(--accent)] px-3 font-medium text-[var(--accent-ink)]"
              >
                生成新档案
              </button>
            </div>
          ) : null}

          {data.tunnelLogTail.length ? (
            <div>
              <div className="mb-1 text-[11px] text-[var(--dim)]">最近隧道日志</div>
              <pre className="max-h-36 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 font-mono text-[11px] text-[var(--dim)]">
                {data.tunnelLogTail.join("\n")}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </DialogShell>
  );
}
