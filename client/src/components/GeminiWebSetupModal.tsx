import { useEffect, useState } from "react";
import { DialogShell } from "./DialogShell";
import { useGeminiWebStatus } from "../hooks/use-gemini-web";

export function GeminiWebSetupModal({
  open,
  onClose,
  showToast,
}: {
  open: boolean;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const { status, refresh } = useGeminiWebStatus();
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
    if (!status) return;
    setEnabled(status.enabled);
    if (status.loggedIn && waitingLogin) {
      setWaitingLogin(false);
      showToast("Gemini 网页账号已登录，可直接生图");
    }
  }, [status, waitingLogin, showToast]);

  useEffect(() => {
    if (!open || !waitingLogin) return;
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, waitingLogin, refresh]);

  if (!open) return null;

  const handleLogin = async () => {
    setErrorMsg(null);
    setBusy("login");
    try {
      const res = await fetch("/gemini-web/login", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.message ?? data.error ?? "启动登录窗口失败");
      }
      setWaitingLogin(true);
      showToast(data.message ?? "请在弹出的浏览器窗口登录 Google 账号");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "启动登录失败");
    } finally {
      setBusy(null);
    }
  };

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    setErrorMsg(null);
    setBusy("save");
    try {
      const res = await fetch("/gemini-web/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "保存配置失败");
      setEnabled(nextEnabled);
      await refresh(false);
      showToast(nextEnabled ? "Gemini 网页生图已启用" : "Gemini 网页生图已停用");
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
      const res = await fetch("/gemini-web/test", { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        error?: string;
        latencyMs?: number;
      };
      setTestResult(data);
      await refresh(false);
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
    ? {
        cls: "bg-[var(--teal-soft)] text-[var(--teal)]",
        dot: "bg-[var(--ok)]",
        text: "已就绪 · 可选切换",
      }
    : status?.loggedIn
      ? {
          cls: "bg-[var(--accent-soft)] text-[var(--accent)]",
          dot: "bg-[var(--accent)]",
          text: "已登录 · 待启用",
        }
      : status?.browserFound
        ? {
            cls: "bg-[var(--accent-soft)] text-[var(--accent)]",
            dot: "bg-[var(--accent)]",
            text: "待登录",
          }
        : {
            cls: "bg-[var(--surface-3)] text-[var(--dim)]",
            dot: "bg-[var(--dim)]",
            text: "未检测到浏览器",
          };

  return (
    <DialogShell
      title="Gemini 网页版生图（Pro 会员直连）"
      description="免 Python、免 API Key，直接复用本机 Chrome / Edge 独立档案在后台静默调用 gemini.google.com 生图；平时不常驻打开网页窗口。"
      onClose={onClose}
      wide
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusPill.cls}`}
        >
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
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">1. 本机浏览器与 Google 账号授权</div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                {!status?.browserFound
                  ? "未检测到 Google Chrome 或 Microsoft Edge"
                  : status.loggedIn
                    ? `已就绪（驱动：${status.browserName}，独立登录档案保存在 ./data/）`
                    : waitingLogin
                      ? `已打开 ${status.browserName} 窗口，登录进入对话界面后将自动保存并关闭…`
                      : `已自动检测到 ${status.browserName}；点击右侧按钮登录一次 Google AI Pro 账号即可`}
              </div>
            </div>
            <button
              type="button"
              disabled={!status?.browserFound || busy !== null}
              onClick={() => void handleLogin()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-45"
            >
              {waitingLogin
                ? "等待登录中…"
                : status?.loggedIn
                  ? "重新登录"
                  : "一键登录 Gemini"}
            </button>
          </div>
          {!status?.loggedIn && status?.lastError ? (
            <p className="mt-2 text-[11px] text-[var(--dim)]">
              状态说明：{status.lastError}
            </p>
          ) : null}
        </div>

        <div className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">2. 启用开关与状态测试</div>
              <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                启用后可在图片节点与配置节点的生成通道中选择「Gemini 网页版 (Pro)」
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!status?.browserFound || !status?.loggedIn || busy !== null}
                  onChange={(e) => void handleToggleEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="font-medium">启用 Gemini 网页生图</span>
              </label>
              <button
                type="button"
                disabled={!status?.browserFound || busy !== null}
                onClick={() => void handleTest()}
                className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium hover:bg-[var(--hover)] disabled:opacity-45"
              >
                {busy === "test" ? "测试中…" : "测试登录态"}
              </button>
            </div>
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
                : `检测失败：${testResult.error ?? "未知错误"}`}
            </div>
          ) : null}
        </div>
      </div>
    </DialogShell>
  );
}
