import { useState } from "react";
import { IconPlus, IconTrash } from "../icons";

export type StoredAgentSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  defaultPrompt: string;
  instructions: string;
  enabled: boolean;
  updatedAt: number;
};

export function AgentSkillsPanel({
  skills,
  activeProfileId,
  canvasContext,
  messages,
  onClose,
  onRefresh,
  onUseSkill,
  showToast,
}: {
  skills: StoredAgentSkill[];
  activeProfileId: string;
  canvasContext: string;
  messages: { role: "user" | "assistant"; content: string }[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onUseSkill: (skill: StoredAgentSkill) => void;
  showToast: (msg: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState<"canvas" | "conversation" | null>(null);

  const openNew = () => {
    setEditingId(null);
    setSlug("");
    setName("");
    setDescription("");
    setDefaultPrompt("");
    setInstructions("");
    setFormOpen(true);
  };

  const openEdit = (s: StoredAgentSkill) => {
    setEditingId(s.id);
    setSlug(s.slug);
    setName(s.name);
    setDescription(s.description);
    setDefaultPrompt(s.defaultPrompt);
    setInstructions(s.instructions);
    setFormOpen(true);
  };

  const handleExtract = async (mode: "canvas" | "conversation") => {
    if (mode === "conversation" && messages.length === 0) {
      showToast("当前对话为空，先聊几轮再提取");
      return;
    }
    setExtracting(mode);
    try {
      const resp = await fetch("/agent/skills/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          profileId: activeProfileId,
          canvasContext,
          messages,
        }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        draft?: Omit<StoredAgentSkill, "id" | "enabled" | "updatedAt">;
        error?: string;
      };
      if (!resp.ok || !data.draft) {
        showToast(data.error ?? "提取 Skill 失败");
        return;
      }
      setEditingId(null);
      setSlug(data.draft.slug);
      setName(data.draft.name);
      setDescription(data.draft.description);
      setDefaultPrompt(data.draft.defaultPrompt);
      setInstructions(data.draft.instructions);
      setFormOpen(true);
      showToast("已生成 Skill 草稿，检查后点击保存即可");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "提取失败");
    } finally {
      setExtracting(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const resp = await fetch("/agent/skills/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          slug,
          name,
          description,
          defaultPrompt,
          instructions,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        showToast(data.error ?? "保存失败");
        return;
      }
      await onRefresh();
      setFormOpen(false);
      showToast("Skill 已保存");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (s: StoredAgentSkill) => {
    await fetch("/agent/skills/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id, enabled: !s.enabled }),
    });
    await onRefresh();
  };

  const handleDelete = async (id: string) => {
    await fetch("/agent/skills/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await onRefresh();
    showToast("已删除 Skill");
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5 text-xs">
      <div className="flex items-center justify-between text-[var(--dim)]">
        <span>本地技能（输入 $标识 调用）</span>
        <button type="button" onClick={onClose} className="hover:text-[var(--text)]">
          返回对话
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium hover:border-[var(--accent)]"
        >
          <IconPlus size={12} /> 新建 Skill
        </button>
        <button
          type="button"
          disabled={extracting !== null}
          onClick={() => void handleExtract("canvas")}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {extracting === "canvas" ? "提取中…" : "从当前画布提取"}
        </button>
        <button
          type="button"
          disabled={extracting !== null}
          onClick={() => void handleExtract("conversation")}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {extracting === "conversation" ? "提取中…" : "从当前对话提取"}
        </button>
      </div>

      {formOpen ? (
        <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{editingId ? "编辑 Skill" : "新建 Skill"}</span>
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
              <span className="block text-[10px] text-[var(--dim)]">调用标识（$slug）</span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="例如 storyboard-3cut"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] text-[var(--dim)]">显示名称</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 三镜分镜工作流"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="block text-[10px] text-[var(--dim)]">一句话说明</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，说明该技能的适用场景"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[10px] text-[var(--dim)]">默认提示词（点击「使用」时填入）</span>
            <input
              type="text"
              value={defaultPrompt}
              onChange={(e) => setDefaultPrompt(e.target.value)}
              placeholder="例如：请用 $storyboard-3cut 帮我生成..."
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[10px] text-[var(--dim)]">Skill 规则正文（注入给 Agent 执行）</span>
            <textarea
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="写明节点结构、连线顺序、提示词风格等固定规范…"
              className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-xs outline-none focus:border-[var(--accent)]"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存 Skill"}
            </button>
          </div>
        </div>
      ) : null}

      {skills.length === 0 && !formOpen ? (
        <p className="py-6 text-center text-[var(--dim)]">
          暂无 Skill。可点击「新建 Skill」或从当前画布/对话一键提取。
        </p>
      ) : (
        <div className="space-y-2">
          {skills.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-[var(--text)]">{s.name}</span>
                <span className="rounded bg-[var(--hover)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                  ${s.slug}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => void handleToggle(s)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    s.enabled
                      ? "bg-[var(--teal)]/15 text-[var(--teal)]"
                      : "bg-[var(--hover)] text-[var(--dim)]"
                  }`}
                >
                  {s.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
              {s.description ? (
                <p className="mt-1 text-[11px] text-[var(--dim)]">{s.description}</p>
              ) : null}
              <div className="mt-2 flex items-center justify-end gap-1.5">
                {s.enabled ? (
                  <button
                    type="button"
                    onClick={() => onUseSkill(s)}
                    className="rounded-lg bg-[var(--text)] px-2 py-0.5 text-[11px] text-[var(--bg)] hover:opacity-90"
                  >
                    使用
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => openEdit(s)}
                  className="rounded-lg border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--hover)]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(s.id)}
                  className="flex h-6 w-6 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  aria-label="删除 Skill"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
