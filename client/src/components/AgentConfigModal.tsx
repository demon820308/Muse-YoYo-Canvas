import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconPlus, IconTrash, IconX } from "../icons";
import { formatAgyModelShortName, useAgyStatus } from "../hooks/use-agy";

export type AgentProvider = "muse" | "openai" | "anthropic" | "agy";

export type MaskedAgentProfile = {
  id: string;
  name: string;
  provider: AgentProvider;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  builtin?: boolean;
  ready?: boolean;
  modelLabel?: string;
};

type TestResult = {
  ok: boolean;
  message?: string;
  error?: string;
  latencyMs?: number;
};

export function AgentConfigModal({
  open,
  profiles,
  activeProfileId,
  onClose,
  onRefresh,
  showToast,
}: {
  open: boolean;
  profiles: MaskedAgentProfile[];
  activeProfileId: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  showToast: (msg: string) => void;
}) {
  const agy = useAgyStatus();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingMaskedKey, setEditingMaskedKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const fetchSeqRef = useRef(0);

  const resolveSubmitApiKey = useCallback(
    (rawKey: string) =>
      editingId && rawKey.trim() === editingMaskedKey ? "" : rawKey,
    [editingId, editingMaskedKey],
  );

  const fetchModels = useCallback(
    async (opts: {
      id?: string | null;
      provider: "openai" | "anthropic";
      baseUrl: string;
      apiKey: string;
    }) => {
      const urlTrimmed = opts.baseUrl.trim();
      if (!/^https?:\/\/.+/i.test(urlTrimmed)) return;
      const seq = ++fetchSeqRef.current;
      setLoadingModels(true);
      setModelsError(null);
      try {
        const resp = await fetch("/agent/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(opts.id ? { id: opts.id } : {}),
            provider: opts.provider,
            baseUrl: urlTrimmed,
            apiKey: opts.apiKey,
          }),
        });
        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          models?: string[];
          error?: string;
        };
        if (seq !== fetchSeqRef.current) return;
        if (!resp.ok || !data.ok || !Array.isArray(data.models)) {
          setModels([]);
          setModelsError(data.error ?? "拉取模型列表失败");
          return;
        }
        setModels(data.models);
        setModel((prev) =>
          prev && data.models!.includes(prev) ? prev : (data.models![0] ?? prev),
        );
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : "拉取模型列表失败");
      } finally {
        if (seq === fetchSeqRef.current) {
          setLoadingModels(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setFormOpen(false);
    setEditingId(null);
    setEditingMaskedKey("");
    setModels([]);
    setModelsError(null);
    void onRefresh();
  }, [open, onRefresh]);

  useEffect(() => {
    if (!open || !formOpen) return;
    const urlTrimmed = baseUrl.trim();
    const submitKey = resolveSubmitApiKey(apiKey);
    const hasKey = Boolean(editingId) || Boolean(submitKey.trim());
    if (!/^https?:\/\/.+/i.test(urlTrimmed) || !hasKey) return;
    const timer = setTimeout(() => {
      void fetchModels({
        id: editingId,
        provider,
        baseUrl: urlTrimmed,
        apiKey: submitKey,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [open, formOpen, editingId, provider, baseUrl, apiKey, resolveSubmitApiKey, fetchModels]);

  if (!open) return null;

  const startNew = () => {
    setEditingId(null);
    setName("");
    setProvider("openai");
    setBaseUrl("https://api.openai.com/v1");
    setApiKey("");
    setEditingMaskedKey("");
    setModel("gpt-4o-mini");
    setModels([]);
    setModelsError(null);
    setTestResult(null);
    setFormOpen(true);
  };

  const startEdit = (p: MaskedAgentProfile) => {
    if (p.builtin || p.provider === "muse" || p.provider === "agy") return;
    setEditingId(p.id);
    setName(p.name);
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setApiKey(p.apiKeyMasked);
    setEditingMaskedKey(p.apiKeyMasked);
    setModel(p.model);
    setModels([]);
    setModelsError(null);
    setTestResult(null);
    setFormOpen(true);
  };

  const handleActivate = async (id: string) => {
    const resp = await fetch("/agent/config/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      showToast(err.error ?? "切换模型失败");
      return;
    }
    await onRefresh();
    showToast("已切换当前 Agent 模型");
  };

  const handleDelete = async (id: string) => {
    const resp = await fetch("/agent/config/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({}))) as { error?: string };
      showToast(err.error ?? "删除失败");
      return;
    }
    if (editingId === id) {
      setFormOpen(false);
      setEditingId(null);
    }
    await onRefresh();
    showToast("已删除模型配置");
  };

  const handleTest = async (payload: {
    id?: string;
    provider: AgentProvider;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }) => {
    setTesting(true);
    setTestResult(null);
    try {
      const resp = await fetch("/agent/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "测试请求失败",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const resp = await fetch("/agent/config/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          name,
          provider,
          baseUrl,
          apiKey: resolveSubmitApiKey(apiKey),
          model,
          activate: true,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        showToast(data.error ?? "保存失败");
        return;
      }
      await onRefresh();
      setFormOpen(false);
      setEditingId(null);
      showToast("模型配置已保存并设为当前");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)] shadow-[var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Agent 模型设置"
      >
        <div className="mb-3 flex items-center justify-between border-b border-[var(--border)] pb-2.5">
          <div>
            <h3 className="text-sm font-semibold">Agent 模型配置</h3>
            <p className="text-[11px] text-[var(--dim)]">
              支持 Muse (YoYo桥)、本地 AGY CLI 与自定义 OpenAI / Anthropic 端点
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="关闭模型设置"
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
          {profiles.map((p) => {
            const active = p.id === activeProfileId;
            const agyReady = p.provider === "agy" ? (agy.status ? agy.ready : Boolean(p.ready)) : true;
            const titleText =
              p.provider === "muse"
                ? p.name
                : p.provider === "agy"
                  ? agyReady
                    ? `${formatAgyModelShortName(agy.status?.model || p.model, agy.status?.models, p.modelLabel)} · AGY`
                    : "AGY（未就绪）"
                  : p.model.trim() || p.name;
            return (
              <div
                key={p.id}
                className={`flex items-center gap-2 rounded-xl border p-2.5 text-xs transition-colors ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]/40"
                    : "border-[var(--border)] bg-[var(--surface-2)]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{titleText}</span>
                    <span className="rounded bg-[var(--hover)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--dim)]">
                      {p.provider}
                    </span>
                    {active ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-medium text-white">
                        <IconCheck size={10} /> 当前
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[var(--dim)]">
                    {p.provider === "muse"
                      ? "通过 YoYo桥 调用 Muse 账号推理（免 API Key）"
                      : p.provider === "agy"
                        ? agyReady
                          ? `使用本机 AGY CLI（${agy.status?.model || p.model}，免 API Key）`
                          : "未就绪：请先在顶部「AGY 引擎」完成部署、登录并启用"
                        : `${p.name ? `${p.name} · ` : ""}${p.baseUrl}${p.hasApiKey ? ` · ${p.apiKeyMasked}` : ""}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={testing || (p.provider === "agy" && !agyReady)}
                    onClick={() => handleTest({ id: p.id, provider: p.provider })}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--hover)] disabled:opacity-50"
                  >
                    测试
                  </button>
                  {!active ? (
                    <button
                      type="button"
                      disabled={p.provider === "agy" && !agyReady}
                      onClick={() => handleActivate(p.id)}
                      className="rounded-lg bg-[var(--text)] px-2 py-1 text-[11px] text-[var(--bg)] hover:opacity-90 disabled:opacity-40"
                    >
                      使用
                    </button>
                  ) : null}
                  {!p.builtin ? (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--hover)]"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                        aria-label="删除配置"
                      >
                        <IconTrash size={12} />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {testResult ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
              testResult.ok
                ? "border-[var(--teal)]/40 bg-[var(--teal)]/10 text-[var(--teal)]"
                : "border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]"
            }`}
          >
            {testResult.ok
              ? `${testResult.message ?? "连接成功"}${testResult.latencyMs != null ? `（${testResult.latencyMs}ms）` : ""}`
              : `连接失败：${testResult.error ?? "未知错误"}`}
          </div>
        ) : null}

        {formOpen ? (
          <div className="mt-3 space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {editingId ? "编辑自定义模型" : "添加自定义模型"}
              </span>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="text-[11px] text-[var(--dim)] hover:text-[var(--text)]"
              >
                取消
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="block text-[11px] text-[var(--dim)]">配置名称</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Claude 中转 / DeepSeek"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-[11px] text-[var(--dim)]">接口格式</span>
                <select
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as "openai" | "anthropic";
                    setProvider(next);
                    if (!editingId) {
                      if (next === "anthropic") {
                        setBaseUrl("https://api.anthropic.com");
                        setModel("claude-sonnet-4-20250514");
                      } else {
                        setBaseUrl("https://api.openai.com/v1");
                        setModel("gpt-4o-mini");
                      }
                    }
                  }}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                >
                  <option value="openai">OpenAI 兼容格式</option>
                  <option value="anthropic">Anthropic 格式</option>
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="block text-[11px] text-[var(--dim)]">Base URL（自定义端点）</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  provider === "anthropic"
                    ? "https://api.anthropic.com"
                    : "https://api.openai.com/v1"
                }
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
              />
            </label>
            <div className="grid grid-cols-2 items-start gap-2">
              <label className="block space-y-1">
                <span className="flex h-4 items-center text-[11px] text-[var(--dim)]">
                  API Key{editingId ? "（留空或保持不变则保留原 Key）" : ""}
                </span>
                <input
                  type={
                    editingId && editingMaskedKey && apiKey === editingMaskedKey
                      ? "text"
                      : "password"
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onFocus={(e) => {
                    if (editingId && editingMaskedKey && apiKey === editingMaskedKey) {
                      e.currentTarget.select();
                    }
                  }}
                  placeholder="sk-..."
                  className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs outline-none focus:border-[var(--accent)]"
                />
              </label>
              <div className="space-y-1">
                <div className="flex h-4 items-center justify-between">
                  <span className="text-[11px] text-[var(--dim)]">Model 名称</span>
                  <button
                    type="button"
                    disabled={loadingModels || !/^https?:\/\/.+/i.test(baseUrl.trim())}
                    onClick={() =>
                      void fetchModels({
                        id: editingId,
                        provider,
                        baseUrl,
                        apiKey: resolveSubmitApiKey(apiKey),
                      })
                    }
                    className="text-[11px] leading-none text-[var(--accent)] hover:underline disabled:opacity-40"
                  >
                    {loadingModels ? "拉取中…" : "刷新列表"}
                  </button>
                </div>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={loadingModels && models.length === 0}
                  aria-label="Model 名称"
                  className="h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-60"
                >
                  {model && !models.includes(model) ? (
                    <option value={model}>{model}</option>
                  ) : null}
                  {models.length === 0 && !model ? (
                    <option value="">请先填写地址与 Key 拉取模型</option>
                  ) : null}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                {modelsError ? (
                  <p className="truncate text-[10px] text-[var(--danger)]" title={modelsError}>
                    {modelsError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={testing}
                onClick={() =>
                  handleTest({
                    ...(editingId ? { id: editingId } : {}),
                    provider,
                    baseUrl,
                    apiKey: resolveSubmitApiKey(apiKey),
                    model,
                  })
                }
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--hover)] disabled:opacity-50"
              >
                {testing ? "测试中…" : "测试连接"}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSave}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存并启用"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={startNew}
              className="inline-flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--hover)]"
            >
              <IconPlus size={13} /> 添加自定义模型（OpenAI / Anthropic）
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
