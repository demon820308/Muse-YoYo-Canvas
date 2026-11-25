import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DialogShell } from "./DialogShell";
import { useAgyStatus, type AgyStatus } from "../hooks/use-agy";

export function AgySetupModal({
  open,
  onClose,
  showToast,
}: {
  open: boolean;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const queryClient = useQueryClient();
  const { status, refresh } = useAgyStatus();
  const [selectedModel, setSelectedModel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [waitingLogin, setWaitingLogin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message?: string;
    error?: string;
    latencyMs?: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setWaitingLogin(false);
      setTestResult(null);
      setErrorMsg(null);
      return;
    }
    void refresh(true);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !status) return;
    setEnabled(status.enabled);
    if (status.model) {
      setSelectedModel(status.model);
    } else if (status.models.length > 0) {
      const preferred =
        status.models.find((m) => m.id === "gemini-3.8-flash-medium") ??
        status.models[0];
      if (preferred) setSelectedModel((cur) => cur || preferred.id);
    }
  }, [open, status?.enabled, status?.model, status?.models.length]);

  useEffect(() => {
    if (status?.loggedIn && waitingLogin) {
      setWaitingLogin(false);
      showToast("AGY CLI 登录成功，已解锁 Nano Banana 与本地模型");
      void queryClient.invalidateQueries({ queryKey: ["agent-config"] });
    }
  }, [status?.loggedIn, waitingLogin, showToast, queryClient]);

  useEffect(() => {
    if (!open || !waitingLogin) return;
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [open, waitingLogin, refresh]);

  useEffect(() => {
    if (!open || status?.job?.status !== "running") return;
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [open, status?.job?.status, refresh]);

  if (!open) return null;

  const jobRunning = status?.job?.status === "running";

  const handleInstall = async () => {
    setErrorMsg(null);
    setBusy("install");
    try {
      const res = await fetch("/agy/install", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "启动部署失败");
      await refresh(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "启动部署失败");
    } finally {
      setBusy(null);
    }
  };

  const handleLogin = async () => {
    setErrorMsg(null);
    setBusy("login");
    try {
      const res = await fetch("/agy/login", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        alreadyLoggedIn?: boolean;
        launched?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.message ?? data.error ?? "启动登录失败");
      if (data.alreadyLoggedIn) {
        showToast(data.message ?? "已完成登录");
        await refresh(true);
      } else {
        setWaitingLogin(true);
        showToast(data.message ?? "请在弹出的授权窗口完成登录");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(null);
    }
  };

  const handleSaveConfig = async (nextEnabled = enabled) => {
    setErrorMsg(null);
    setBusy("save");
    try {
      const modelToSave =
        selectedModel ||
        status?.models.find((m) => m.id === "gemini-3.8-flash-medium")?.id ||
        status?.models[0]?.id ||
        "";
      const res = await fetch("/agy/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: nextEnabled,
          model: modelToSave,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: AgyStatus;
      };
      if (!res.ok) throw new Error(data.error ?? "保存配置失败");
      setEnabled(nextEnabled);
      if (modelToSave) setSelectedModel(modelToSave);
      if (data.status) {
        queryClient.setQueryData(["agy-status"], data.status);
      } else {
        await refresh(false);
      }
      showToast(nextEnabled ? "AGY 本地引擎已保存并启用" : "AGY 本地引擎已停用");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setErrorMsg(null);
    setTestResult(null);
    setBusy("test");
    try {
      const res = await fetch("/agy/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: selectedModel || status?.model }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        error?: string;
        latencyMs?: number;
      };
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "测试失败",
      });
    } finally {
      setBusy(null);
    }
  };

  const statusPill = status?.ready
    ? { cls: "bg-[var(--teal-soft)] text-[var(--teal)]", dot: "bg-[var(--ok)]", text: "已就绪 · 可选切换" }
    : status?.installed && status?.loggedIn
      ? { cls: "bg-[var(--accent-soft)] text-[var(--accent)]", dot: "bg-[var(--accent)]", text: "已登录 · 待启用配置" }
      : status?.installed
        ? { cls: "bg-[var(--accent-soft)] text-[var(--accent)]", dot: "bg-[var(--accent)]", text: "已安装 · 待登录" }
        : { cls: "bg-[var(--surface-3)] text-[var(--dim)]", dot: "bg-[var(--dim)]", text: "未部署" };

  return (
    <DialogShell
      title="AGY 本地引擎与 Nano Banana"
      description="一键部署并登录本地 agy CLI 后，可在画布上按节点自由切换使用 Nano Banana 生图、AGY 提示词逆推 / 文本生成与画布 Agent（所有节点默认仍保持 Muse 桥）。"
      onClose={onClose}
      wide
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusPill.cls}`}>
          <span className={`h-2 w-2 rounded-full ${statusPill.dot}`} />
          {statusPill.text}
        </span>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void refresh(true)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
        >
          刷新检测
        </button>
      </div>

      {errorMsg ? (
        <div className="mb-3 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {errorMsg}
        </div>
      ) : null}

      <div className="space-y-3 text-xs">
        {/* Step 1: 安装与工作区配置 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">1. 一键部署 agy CLI</div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                {status?.installed
                  ? `已检测到本地 CLI：${status.binPath}`
                  : "从 Google Antigravity 官方源自动下载到用户目录（免管理员权限），并自动配置画布目录信任"}
              </div>
            </div>
            <button
              type="button"
              disabled={jobRunning || busy !== null}
              onClick={() => void handleInstall()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50"
            >
              {jobRunning
                ? "部署中…"
                : status?.installed
                  ? "检测/修复配置"
                  : "一键部署 AGY"}
            </button>
          </div>

          {status?.job ? (
            <div className="mt-3 space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
              <div className="flex items-center justify-between">
                <span className="font-medium">{status.job.message}</span>
                <span className="text-[11px] text-[var(--dim)]">
                  {status.job.status === "running"
                    ? "运行中"
                    : status.job.status === "done"
                      ? "完成"
                      : "失败"}
                </span>
              </div>
              {status.job.steps.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-[11px]">
                  <span
                    className={
                      s.state === "done"
                        ? "text-[var(--ok)]"
                        : s.state === "failed"
                          ? "text-[var(--danger)]"
                          : s.state === "running"
                            ? "text-[var(--accent)]"
                            : "text-[var(--dim)]"
                    }
                  >
                    {s.state === "done" ? "✓" : s.state === "failed" ? "✕" : s.state === "running" ? "◌" : "·"}
                  </span>
                  <span className="font-medium">{s.label}</span>
                  {s.detail ? <span className="text-[var(--dim)]">— {s.detail}</span> : null}
                </div>
              ))}
              {status.job.output ? (
                <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 font-mono text-[10px] text-[var(--dim)]">
                  {status.job.output}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Step 2: 一键登录 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">2. 账号授权登录</div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                {status?.loggedIn
                  ? `已登录（当前账号可用 ${status.models.length} 个模型）`
                  : waitingLogin
                    ? "正在等待浏览器完成 Google 账号授权（自动每 2.5 秒检测）…"
                    : "若本机桌面版 Antigravity 已登录，可自动免登；否则点右侧按钮弹出授权窗口"}
              </div>
            </div>
            <button
              type="button"
              disabled={!status?.installed || busy !== null}
              onClick={() => void handleLogin()}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 font-medium hover:bg-[var(--hover)] disabled:opacity-45"
            >
              {status?.loggedIn
                ? "已登录 ✓"
                : waitingLogin
                  ? "等待授权中…"
                  : "一键登录 AGY"}
            </button>
          </div>
          {!status?.loggedIn && status?.lastError ? (
            <p className="mt-2 text-[11px] text-[var(--dim)]">
              检测说明：{status.lastError}
            </p>
          ) : null}
        </div>

        {/* Step 3: 模型与开关配置 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">3. 默认模型与启用开关</div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                用于 AGY 画布 Agent、配置节点文本、提示词逆推；Nano Banana 生图将自动调度内置 image-generator
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!status?.installed || !status?.loggedIn}
                onChange={(e) => {
                  const next = e.target.checked;
                  setEnabled(next);
                  void handleSaveConfig(next);
                }}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="font-medium">启用本地 AGY</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedModel}
              disabled={!status?.loggedIn || (status?.models.length ?? 0) === 0}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="AGY 默认推理模型"
              className="h-8 min-w-[220px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-50"
            >
              {(status?.models ?? []).length === 0 ? (
                <option value="">请先完成安装并登录以获取模型列表</option>
              ) : (
                status?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id})
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              disabled={!status?.installed || !status?.loggedIn || busy !== null}
              onClick={() => void handleTest()}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium hover:bg-[var(--hover)] disabled:opacity-45"
            >
              {busy === "test" ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              disabled={!status?.installed || !status?.loggedIn || busy !== null}
              onClick={() => void handleSaveConfig(true)}
              className="h-8 rounded-lg bg-[var(--accent)] px-3 font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-45"
            >
              {busy === "save" ? "保存中…" : "保存并启用"}
            </button>
          </div>

          {testResult ? (
            <div
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                testResult.ok
                  ? "border-[var(--teal)]/40 bg-[var(--teal)]/10 text-[var(--teal)]"
                  : "border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]"
              }`}
            >
              {testResult.ok
                ? `${testResult.message ?? "连接成功"}${testResult.latencyMs != null ? `（${testResult.latencyMs}ms）` : ""}`
                : `测试失败：${testResult.error ?? "未知错误"}`}
            </div>
          ) : null}
        </div>
      </div>
    </DialogShell>
  );
}
