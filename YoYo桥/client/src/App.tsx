// YoYo桥设置页：配对状态、任务计数、配对表单、最近任务。
// 调 bridgeStatus / bridgeSetConfig / bridgeClearFailed 三个动作；
// bridgeStatus 每 5 秒自动轮询（与后台同步节奏对齐），标签页切到
// 后台时自动暂停；保存与清除后也会立即刷新状态。

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";

const FIELDS = actionFields<typeof Actions>();
type Status = ApiResponse<typeof api, "bridgeStatus">;
type Job = Status["recentJobs"][number];

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function shortJobId(jobId: string): string {
  return jobId.length > 14 ? `${jobId.slice(0, 8)}…${jobId.slice(-4)}` : jobId;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "待处理",
  working: "执行中",
  done: "待回送",
  failed: "失败",
  delivered: "已回送",
  cleaned: "已完成",
};

export function App() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["bridge-status"],
    queryFn: () => api.bridgeStatus({}),
    // 每 5 秒自动刷新状态，让待处理/执行中/待回送这些短命状态
    // 不刷新页面也能被看到；切到后台标签页时暂停轮询。
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmClearPairing, setConfirmClearPairing] = useState(false);
  const [clearPairingInput, setClearPairingInput] = useState("");
  const [confirmClearFailed, setConfirmClearFailed] = useState(false);
  const [clearFailedError, setClearFailedError] = useState<string | null>(null);
  const [lastCleared, setLastCleared] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: async (args: { baseUrl: string; token?: string }) =>
      api.bridgeSetConfig(args),
    onSuccess: () => {
      setToken("");
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["bridge-status"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : String(err));
    },
  });

  const clear = useMutation({
    mutationFn: async () => api.bridgeSetConfig({ baseUrl: "", clear: true }),
    onSuccess: () => {
      setBaseUrl(null);
      setToken("");
      setFormError(null);
      setConfirmClearPairing(false);
      setClearPairingInput("");
      queryClient.invalidateQueries({ queryKey: ["bridge-status"] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : String(err));
    },
  });

  const clearFailed = useMutation({
    mutationFn: async () => api.bridgeClearFailed({}),
    onSuccess: (res) => {
      setConfirmClearFailed(false);
      setClearFailedError(null);
      setLastCleared(res.deleted);
      queryClient.invalidateQueries({ queryKey: ["bridge-status"] });
    },
    onError: (err) => {
      setClearFailedError(err instanceof Error ? err.message : String(err));
    },
  });

  const data = status.data;
  const urlValue = baseUrl ?? data?.baseUrl ?? "";

  const onSave = () => {
    if (!urlValue.trim()) {
      setFormError("请填写隧道地址");
      return;
    }
    save.mutate({
      baseUrl: urlValue.trim(),
      ...(token.trim() ? { token: token.trim() } : {}),
    });
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        <h1 className="pt-6 text-2xl font-semibold">YoYo桥</h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          本地画布经 Cloudflare 隧道把生成任务交给这里执行，结果再回送本地。
        </p>

        {status.isPending ? (
          <p className="mt-8 text-sm text-[var(--dim)]">加载中…</p>
        ) : status.error ? (
          <div className="mt-8">
            <p className="text-sm text-red-600">
              状态加载失败：{String(status.error)}
            </p>
            <button
              type="button"
              className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
              onClick={() => status.refetch()}
            >
              重试
            </button>
          </div>
        ) : data ? (
          <>
            {/* 配对状态 */}
            <section
              aria-label="配对状态"
              className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block h-2.5 w-2.5 rounded-full ${data.configured ? "bg-emerald-600" : "bg-zinc-400"}`}
                />
                <span className="font-medium">
                  {data.configured ? "已配对" : "未配对"}
                </span>
                <span className="ml-auto text-xs text-[var(--dim)]">
                  同步租约：{data.leaseHeld ? "持有中" : "空闲"}
                </span>
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex gap-3">
                  <dt className="w-24 shrink-0 text-[var(--dim)]">隧道地址</dt>
                  <dd className="min-w-0 break-all font-mono text-[13px]">
                    {data.baseUrl || "—"}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-24 shrink-0 text-[var(--dim)]">桥令牌</dt>
                  <dd className="font-mono text-[13px]">
                    {data.tokenMasked || "—"}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-24 shrink-0 text-[var(--dim)]">本地最后在线</dt>
                  <dd>{formatTime(data.lastOnlineAt)}</dd>
                </div>
                {data.lastError ? (
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-[var(--dim)]">最近错误</dt>
                    <dd className="min-w-0 break-words text-amber-700 dark:text-amber-500">
                      {data.lastError}
                      {data.lastErrorAt
                        ? `（${formatTime(data.lastErrorAt)}）`
                        : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>

            {/* 计数 */}
            <section
              aria-label="任务计数"
              className="mt-4 grid grid-cols-4 gap-3"
            >
              {(
                [
                  ["待处理", data.pending],
                  ["在途", data.inFlight],
                  ["失败", data.failed],
                  ["已完成", data.cleaned],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-center"
                >
                  <div className="font-mono text-xl font-semibold">{value}</div>
                  <div className="mt-0.5 text-xs text-[var(--dim)]">{label}</div>
                </div>
              ))}
            </section>

            {/* 失败记录清除 */}
            {data.clearableFailed > 0 || lastCleared != null ? (
              <section
                aria-label="失败记录"
                className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
              >
                {data.clearableFailed > 0 ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-sm">
                        有{" "}
                        <span className="font-mono font-semibold">
                          {data.clearableFailed}
                        </span>{" "}
                        条失败记录
                        <span className="text-[var(--dim)]">
                          （含已完成但仍带失败原因的记录）
                        </span>
                      </p>
                      {!confirmClearFailed ? (
                        <button
                          type="button"
                          className="ml-auto rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
                          disabled={clearFailed.isPending}
                          onClick={() => {
                            setClearFailedError(null);
                            setLastCleared(null);
                            setConfirmClearFailed(true);
                          }}
                        >
                          清除失败记录
                        </button>
                      ) : null}
                    </div>
                    {confirmClearFailed ? (
                      <div className="mt-3">
                        <p className="text-sm text-[var(--dim)]">
                          确认清除这 {data.clearableFailed}{" "}
                          条失败记录？清除后无法恢复，成功和进行中的任务不受影响。
                        </p>
                        <div className="mt-3 flex gap-3">
                          <button
                            type="button"
                            className="rounded-lg bg-red-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                            disabled={clearFailed.isPending}
                            onClick={() => clearFailed.mutate()}
                          >
                            {clearFailed.isPending ? "清除中…" : "确认清除"}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--border)] px-5 py-2 text-sm disabled:opacity-50"
                            disabled={clearFailed.isPending}
                            onClick={() => setConfirmClearFailed(false)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : lastCleared != null ? (
                  <p className="text-sm text-[var(--dim)]">
                    已清除 {lastCleared} 条失败记录。
                  </p>
                ) : null}
                {clearFailedError ? (
                  <p role="alert" className="mt-3 text-sm text-red-600">
                    清除失败：{clearFailedError}
                  </p>
                ) : null}
              </section>
            ) : null}

            {/* 配对表单 */}
            <section
              aria-label="配对设置"
              className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <h2 className="font-medium">配对设置</h2>
              <label
                htmlFor="bridge-base-url"
                className="mt-4 block text-sm text-[var(--dim)]"
              >
                隧道地址
              </label>
              <input
                id="bridge-base-url"
                {...FIELDS.bridgeSetConfig.baseUrl}
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
                placeholder="https://yoyo-bridge.example.com"
                value={urlValue}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <label
                htmlFor="bridge-token"
                className="mt-4 block text-sm text-[var(--dim)]"
              >
                桥令牌（留空表示不改）
              </label>
              <input
                id="bridge-token"
                {...FIELDS.bridgeSetConfig.token}
                type="password"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
                placeholder={data.tokenMasked || "请输入桥令牌"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              {formError ? (
                <p role="alert" className="mt-3 text-sm text-red-600">
                  {formError}
                </p>
              ) : null}
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                  disabled={save.isPending}
                  onClick={onSave}
                >
                  {save.isPending ? "保存中…" : "保存配对"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] px-5 py-2 text-sm disabled:opacity-50"
                  disabled={clear.isPending || !data.configured}
                  onClick={() => {
                    setFormError(null);
                    setClearPairingInput("");
                    setConfirmClearPairing(true);
                  }}
                >
                  清除配对
                </button>
              </div>
            </section>

            {/* 最近任务 */}
            <section aria-label="最近任务" className="mt-6">
              <h2 className="font-medium">最近任务</h2>
              {data.recentJobs.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--dim)]">
                  还没有桥任务。本地画布配对后，生成的任务会出现在这里。
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                  {data.recentJobs.map((job: Job) => (
                    <li key={job.jobId} className="px-4 py-3">
                      <div className="flex items-baseline gap-2 text-sm">
                        <span className="font-mono text-[13px]">
                          {shortJobId(job.jobId)}
                        </span>
                        <span className="text-[var(--dim)]">{job.kind}</span>
                        <span className="ml-auto shrink-0">
                          {STATUS_LABEL[job.status] ?? job.status}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--dim)]">
                        {job.genSize ? (
                          <span className="font-mono">{job.genSize}</span>
                        ) : null}
                        <span>更新于 {formatTime(job.updatedAt)}</span>
                      </div>
                      {job.error ? (
                        <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-500">
                          {job.error}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 清除配对二次确认弹窗：须手动输入 yes 才能执行 */}
            {confirmClearPairing ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
                onClick={() => {
                  if (!clear.isPending) {
                    setConfirmClearPairing(false);
                    setClearPairingInput("");
                  }
                }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="clear-pairing-title"
                  className="w-full max-w-md rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h2 id="clear-pairing-title" className="font-medium">
                    确认清除配对？
                  </h2>
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    清除后隧道地址和桥令牌会被一起抹掉，桥回到未配对状态，本地任务不再被领取。恢复配对需要回本地
                    bridge-admin 重新拿令牌。
                  </p>
                  <label
                    htmlFor="clear-pairing-confirm"
                    className="mt-4 block text-sm text-[var(--dim)]"
                  >
                    请输入 <span className="font-mono font-semibold text-[var(--text)]">yes</span> 确认删除
                  </label>
                  <input
                    id="clear-pairing-confirm"
                    type="text"
                    autoComplete="off"
                    autoFocus
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
                    placeholder="yes"
                    value={clearPairingInput}
                    onChange={(e) => setClearPairingInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        clearPairingInput.trim().toLowerCase() === "yes" &&
                        !clear.isPending
                      ) {
                        clear.mutate();
                      }
                    }}
                  />
                  {clear.error ? (
                    <p role="alert" className="mt-3 text-sm text-red-600">
                      清除失败：
                      {clear.error instanceof Error
                        ? clear.error.message
                        : String(clear.error)}
                    </p>
                  ) : null}
                  <div className="mt-4 flex gap-3">
                    <button
                      type="button"
                      className="rounded-lg bg-red-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
                      disabled={
                        clear.isPending ||
                        clearPairingInput.trim().toLowerCase() !== "yes"
                      }
                      onClick={() => clear.mutate()}
                    >
                      {clear.isPending ? "清除中…" : "确认清除配对"}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--border)] px-5 py-2 text-sm disabled:opacity-50"
                      disabled={clear.isPending}
                      onClick={() => {
                        setConfirmClearPairing(false);
                        setClearPairingInput("");
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
