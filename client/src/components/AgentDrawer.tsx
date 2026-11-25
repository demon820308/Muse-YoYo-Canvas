import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { IconTrash, IconX } from "../icons";
import type { Asset, CanvasEdge, CanvasNode } from "../types";
import {
  AgentConfigModal,
  type MaskedAgentProfile,
} from "./AgentConfigModal";
import { formatAgyModelShortName, useAgyStatus } from "../hooks/use-agy";
import { AgentOrbIcon } from "./AgentOrbIcon";
import {
  AgentSkillsPanel,
  type StoredAgentSkill,
} from "./AgentSkillsPanel";

export type AgentOperation = {
  op:
    | "create_node"
    | "insert_asset"
    | "update_node"
    | "delete_node"
    | "connect"
    | "disconnect"
    | "trigger_generate"
    | "group_nodes"
    | "save_prompt";
  tempId?: string;
  nodeId?: string;
  nodeIds?: string[];
  assetId?: string;
  type?: CanvasNode["type"];
  title?: string;
  prompt?: string;
  content?: string;
  genRatio?: string;
  genDuration?: number;
  genMode?: "image" | "video" | "audio" | "text";
  nearNodeId?: string;
  x?: number;
  y?: number;
  source?: string;
  target?: string;
};

type AgentLogEntry = {
  id: string;
  at: number;
  profileName: string;
  provider: string;
  status: "ok" | "error" | "stopped";
  durationMs: number;
  promptPreview: string;
  summary: string;
  detail?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  operations?: AgentOperation[];
  appliedSummary?: string;
  pendingGenerateNodeIds?: string[];
  generateTriggered?: boolean;
  error?: boolean;
};

type MentionCandidate = {
  key: string;
  source: "node" | "asset";
  id: string;
  title: string;
  kind: string;
  mediaUrl: string | null;
  seq: number | null;
};

type StoredAgentSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

function makeSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type ApplyAgentOpsResult = {
  summary: string;
  deferredGenerateNodeIds: string[];
};

const QUICK_PROMPTS = [
  "分析当前画布节点和连线，给出优化建议",
  "帮我创建一个 16:9 的生图工作流：1 个文本提示词节点连向 1 个生图节点",
  "根据我选中的或现有的节点，帮我扩写更专业的画面提示词",
];

function serializeCanvasContext(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  selectedIds: Set<string>,
  assets: Asset[],
): string {
  const nodeLines = nodes.slice(0, 80).map((n) => {
    const sel = selectedIds.has(n.id) ? " [已选中]" : "";
    const seq = n.seq != null ? `#${n.seq} ` : "";
    const title = n.title || "未命名";
    const prompt = n.prompt ? ` | prompt="${n.prompt.slice(0, 240)}"` : "";
    const content = n.content && !n.content.startsWith("/blobs/")
      ? ` | content="${n.content.slice(0, 240)}"`
      : "";
    const ratio = n.genRatio ? ` | ratio=${n.genRatio}` : "";
    return `- ${seq}id=${n.id} type=${n.type} title="${title}" pos=(${Math.round(n.x)},${Math.round(n.y)}) status=${n.status}${ratio}${prompt}${content}${sel}`;
  });
  const edgeLines = edges
    .slice(0, 120)
    .map((e) => `- ${e.fromNodeId} -> ${e.toNodeId}`);
  const assetLines = assets.slice(0, 60).map((a) => {
    const tags = a.tags?.length ? ` tags=[${a.tags.join(",")}]` : "";
    return `- assetId=${a.id} kind=${a.kind} title="${a.title || "未命名资产"}"${tags}`;
  });
  return [
    `节点总数：${nodes.length}${nodes.length > 80 ? "（仅列前 80 个）" : ""}`,
    ...nodeLines,
    `连线总数：${edges.length}${edges.length > 120 ? "（仅列前 120 条）" : ""}`,
    ...edgeLines,
    `项目资产库（可通过 insert_asset 插入画布）：${assets.length}${assets.length > 60 ? "（仅列前 60 项）" : ""}`,
    ...assetLines,
  ].join("\n");
}

function formatMessageForDisplay(text: string): string {
  return text.replace(/@\[asset:[^:\]]+:([^\]]+)\]/g, "@$1");
}

function mentionToken(item: { title: string; seq: number | null }): string {
  return `@${item.title}${item.seq != null ? `#${item.seq}` : ""}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderTokenizedText(
  text: string,
  isUserBubble = false,
  knownTokens: string[] = [],
) {
  const uniqueTokens = [...new Set(knownTokens.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = uniqueTokens.length
    ? new RegExp(
        `(${uniqueTokens.map(escapeRegExp).join("|")}|@[^\\s，。,.!?！？:：]+|\\$[a-zA-Z0-9_-]+)`,
        "g",
      )
    : /(@[^\s，。,.!?！？:：]+|\$[a-zA-Z0-9_-]+)/g;
  const parts = text.split(pattern);
  return parts.map((part, i) => {
    if (part.startsWith("@") && part.length > 1) {
      return (
        <span
          key={i}
          className={
            isUserBubble
              ? "rounded-sm bg-white/20 font-medium text-white"
              : "rounded-sm bg-[var(--accent-soft)] text-[var(--accent)]"
          }
        >
          {part}
        </span>
      );
    }
    if (part.startsWith("$") && part.length > 1) {
      return (
        <span
          key={i}
          className={
            isUserBubble
              ? "rounded-sm bg-black/20 font-medium text-white"
              : "rounded-sm bg-[var(--teal)]/15 text-[var(--teal)]"
          }
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

const AGENT_WIDTH_KEY = "yoyohua-bu-agent-width";
const AGENT_WIDTH_MIN = 320;
const AGENT_WIDTH_MAX = 720;

export function AgentDrawer({
  open,
  width = 380,
  onClose,
  projectId,
  nodes,
  edges,
  selectedIds,
  onApplyOperations,
  onTriggerGenerateNodes,
  onLocateNode,
  showToast,
  onBusyChange,
}: {
  open: boolean;
  width?: number;
  onClose: () => void;
  projectId: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedIds: Set<string>;
  onApplyOperations: (
    ops: AgentOperation[],
    options: { autoTriggerGenerate: boolean },
  ) => Promise<ApplyAgentOpsResult>;
  onTriggerGenerateNodes: (nodeIds: string[]) => Promise<void>;
  onLocateNode?: (nodeId: string) => void;
  showToast: (msg: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const agy = useAgyStatus();
  const [profiles, setProfiles] = useState<MaskedAgentProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("muse-bridge");
  const [configOpen, setConfigOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<StoredAgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => makeSessionId());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const appendLog = useCallback((entry: Omit<AgentLogEntry, "id" | "at">) => {
    setLogs((prev) =>
      [{ id: `log-${Date.now()}`, at: Date.now(), ...entry }, ...prev].slice(0, 50),
    );
  }, []);
  const [skills, setSkills] = useState<StoredAgentSkill[]>([]);
  const turnMetaRef = useRef<{ startedAt: number; profileName: string; provider: string; promptPreview: string } | null>(null);
  const [attachedRefs, setAttachedRefs] = useState<MentionCandidate[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyHint, setBusyHint] = useState("");
  const [autoTriggerGenerate, setAutoTriggerGenerate] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmRegenMsgId, setConfirmRegenMsgId] = useState<string | null>(null);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [skillRange, setSkillRange] = useState<{ start: number; end: number; query: string } | null>(null);
  const [skillIdx, setSkillIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  const queryClient = useQueryClient();
  const assetsQ = useQuery({
    queryKey: ["assets", projectId],
    queryFn: () => api.listAssets({ projectId: projectId! }),
    enabled: Boolean(projectId) && open,
  });
  const assets = useMemo(() => assetsQ.data?.assets ?? [], [assetsQ.data]);
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const nodeSeqById = new Map<string, number>();
    for (const n of nodes) {
      if (n.seq != null) nodeSeqById.set(n.id, n.seq);
    }
    const nodeItems: MentionCandidate[] = [...nodes]
      .reverse()
      .map((n) => ({
        key: `node:${n.id}`,
        source: "node",
        id: n.id,
        title: n.title || "未命名节点",
        kind: n.type,
        mediaUrl: n.posterUrl || n.mediaUrl || null,
        seq: n.seq ?? null,
      }));
    const assetItems: MentionCandidate[] = assets.map((a) => ({
      key: `asset:${a.id}`,
      source: "asset",
      id: a.id,
      title: a.title || "未命名资产",
      kind: a.kind,
      mediaUrl: a.posterUrl || a.mediaUrl || null,
      seq: a.sourceNodeId ? (nodeSeqById.get(a.sourceNodeId) ?? null) : null,
    }));
    return [...nodeItems, ...assetItems];
  }, [nodes, assets]);

  const filteredMentions = useMemo(() => {
    if (!mentionRange) return [];
    const q = mentionRange.query.trim().toLowerCase();
    const list = q
      ? mentionCandidates.filter(
          (m) =>
            m.title.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q) ||
            (m.seq != null && `#${m.seq}`.includes(q)),
        )
      : mentionCandidates;
    return list.slice(0, 24);
  }, [mentionCandidates, mentionRange]);
  const filteredSkills = useMemo(() => {
    if (!skillRange) return [];
    const enabled = skills.filter((s) => s.enabled);
    const q = skillRange.query.trim().toLowerCase();
    return (
      q
        ? enabled.filter(
            (s) =>
              s.slug.toLowerCase().includes(q) ||
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q),
          )
        : enabled
    ).slice(0, 20);
  }, [skills, skillRange]);
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const saved = Number(localStorage.getItem(AGENT_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= AGENT_WIDTH_MIN) {
      return Math.min(AGENT_WIDTH_MAX, saved);
    }
    return Math.max(AGENT_WIDTH_MIN, Math.min(480, width + 40));
  });
  const [resizing, setResizing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<number | null>(null);

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    const maxWidth = Math.min(AGENT_WIDTH_MAX, window.innerWidth - 24);
    let nextWidth = startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      // Docked on the right: dragging the left edge leftward widens the drawer.
      nextWidth = Math.min(
        maxWidth,
        Math.max(AGENT_WIDTH_MIN, startWidth + (startX - moveEvent.clientX)),
      );
      setDrawerWidth(nextWidth);
    };
    const onUp = () => {
      localStorage.setItem(AGENT_WIDTH_KEY, String(Math.round(nextWidth)));
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
    };
    setResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const loadConfig = useCallback(async () => {
    try {
      const resp = await fetch("/agent/config");
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        activeProfileId: string;
        profiles: MaskedAgentProfile[];
      };
      setProfiles(data.profiles ?? []);
      setActiveProfileId(data.activeProfileId || "muse-bridge");
    } catch {
      // ignore
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const resp = await fetch("/agent/skills");
      if (!resp.ok) return;
      const data = (await resp.json()) as { skills?: StoredAgentSkill[] };
      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadSkills();
  }, [loadConfig, loadSkills]);

  const loadHistory = useCallback(async (pid: string | null) => {
    if (!pid) {
      setSessions([]);
      setMessages([]);
      setSessionId(makeSessionId());
      return;
    }
    try {
      const resp = await fetch(`/agent/history?projectId=${encodeURIComponent(pid)}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        activeSessionId: string | null;
        sessions: StoredAgentSession[];
      };
      const list = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(list);
      const active = list.find((s) => s.id === data.activeSessionId) ?? list[0];
      if (active) {
        setSessionId(active.id);
        setMessages(active.messages ?? []);
      } else {
        setSessionId(makeSessionId());
        setMessages([]);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setHistoryOpen(false);
    void loadHistory(projectId);
  }, [projectId, loadHistory]);

  const persistSession = useCallback(
    async (nextMessages: ChatMessage[], sid = sessionIdRef.current) => {
      if (!projectId || nextMessages.length === 0) return;
      const firstUser = nextMessages.find((m) => m.role === "user");
      const title = firstUser
        ? formatMessageForDisplay(firstUser.content).trim().slice(0, 28) || "新对话"
        : "新对话";
      const session: StoredAgentSession = {
        id: sid,
        title,
        updatedAt: Date.now(),
        messages: nextMessages,
      };
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== sid)].slice(0, 30));
      await fetch("/agent/history/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, session }),
      }).catch(() => {});
    },
    [projectId],
  );

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !configOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, configOpen, onClose]);

  useEffect(() => {
    if (!listRef.current) return;
    requestAnimationFrame(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    });
  }, [messages, busy, confirmRegenMsgId]);

  const profileDisplayName = useCallback(
    (p: MaskedAgentProfile) => {
      if (p.provider === "muse") return p.name;
      if (p.provider === "agy") {
        const ready = agy.status ? agy.ready : Boolean(p.ready);
        if (!ready) return "AGY（未就绪）";
        const modelId = agy.status?.model || p.model;
        const shortName = formatAgyModelShortName(
          modelId,
          agy.status?.models,
          p.modelLabel,
        );
        return `${shortName} · AGY`;
      }
      return p.model.trim() || p.name;
    },
    [agy.ready, agy.status],
  );

  const switchProfile = async (id: string) => {
    const prev = activeProfileId;
    setActiveProfileId(id);
    try {
      const resp = await fetch("/agent/config/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!resp.ok) {
        setActiveProfileId(prev);
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        showToast(err.error ?? "切换模型失败");
      }
    } catch {
      setActiveProfileId(prev);
      showToast("切换模型失败");
    }
  };

  const finishTurn = useCallback(
    async (reply: string, operations: AgentOperation[]) => {
      activeTurnIdRef.current = null;
      let appliedSummary = "";
      let pendingGenerateNodeIds: string[] = [];
      if (operations.length > 0) {
        const res = await onApplyOperations(operations, { autoTriggerGenerate });
        appliedSummary = res.summary;
        pendingGenerateNodeIds = res.deferredGenerateNodeIds;
      }
      const meta = turnMetaRef.current;
      if (meta) {
        appendLog({
          profileName: meta.profileName,
          provider: meta.provider,
          status: "ok",
          durationMs: Date.now() - meta.startedAt,
          promptPreview: meta.promptPreview,
          summary: appliedSummary || "纯文字回复",
        });
        turnMetaRef.current = null;
      }
      setMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: reply,
            operations,
            appliedSummary,
            pendingGenerateNodeIds,
          },
        ];
        void persistSession(next);
        return next;
      });
      setBusy(false);
      setBusyHint("");
    },
    [autoTriggerGenerate, onApplyOperations, persistSession],
  );

  const stopGenerating = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    const turnId = activeTurnIdRef.current;
    activeTurnIdRef.current = null;
    if (turnId) {
      void fetch("/agent/turn/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId }),
      }).catch(() => {});
    }
    setBusy(false);
    setBusyHint("");
    const meta = turnMetaRef.current;
    if (meta) {
      appendLog({
        profileName: meta.profileName,
        provider: meta.provider,
        status: "stopped",
        durationMs: Date.now() - meta.startedAt,
        promptPreview: meta.promptPreview,
        summary: "用户手动停止",
      });
      turnMetaRef.current = null;
    }
    setMessages((prev) => {
      const next: ChatMessage[] = [
        ...prev,
        {
          id: `s-${Date.now()}`,
          role: "assistant",
          content: "已停止当前生成。",
        },
      ];
      void persistSession(next);
      return next;
    });
  }, [persistSession]);

  const pollMuseTurn = useCallback(
    async (turnId: string, startedAt: number) => {
      try {
        const resp = await fetch(`/agent/turn?turnId=${encodeURIComponent(turnId)}`);
        const data = (await resp.json()) as {
          status: "pending" | "done" | "failed";
          reply?: string;
          operations?: AgentOperation[];
          error?: string;
        };
        if (data.status === "done") {
          await finishTurn(data.reply ?? "", data.operations ?? []);
          return;
        }
        if (data.status === "failed") {
          setMessages((prev) => [
            ...prev,
            {
              id: `e-${Date.now()}`,
              role: "assistant",
              content: `Muse Agent 执行失败：${data.error ?? "未知错误"}`,
              error: true,
            },
          ]);
          setBusy(false);
          setBusyHint("");
          return;
        }
        if (Date.now() - startedAt > 180_000) {
          setMessages((prev) => [
            ...prev,
            {
              id: `e-${Date.now()}`,
              role: "assistant",
              content: "等待 Muse 桥响应超时，请检查顶部「YoYo桥」是否在线。",
              error: true,
            },
          ]);
          setBusy(false);
          setBusyHint("");
          return;
        }
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        setBusyHint(`正在等待 YoYo桥 回传 Muse 推理（已等待 ${elapsedSec}s）…`);
        pollTimerRef.current = window.setTimeout(() => {
          void pollMuseTurn(turnId, startedAt);
        }, 2000);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            content: `轮询失败：${err instanceof Error ? err.message : String(err)}`,
            error: true,
          },
        ]);
        setBusy(false);
        setBusyHint("");
      }
    },
    [finishTurn],
  );

  const sendMessage = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    if (!projectId) {
      showToast("请先打开或创建一个画布项目");
      return;
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };
    const nextHistory = [...messages, userMsg];
    const currentAttached = attachedRefs;
    setMessages(nextHistory);
    setHistoryOpen(false);
    setSkillsOpen(false);
    void persistSession(nextHistory);
    if (!textOverride) {
      setInput("");
      setAttachedRefs([]);
    }
    setBusy(true);

    const activeProfile = profiles.find((p) => p.id === activeProfileId);
    const activeLabel = activeProfile
      ? profileDisplayName(activeProfile)
      : activeProfileId;
    turnMetaRef.current = {
      startedAt: Date.now(),
      profileName: activeLabel,
      provider: activeProfile?.provider ?? "unknown",
      promptPreview: formatMessageForDisplay(text).slice(0, 60),
    };
    setBusyHint(
      activeProfile?.provider === "muse"
        ? "已发送到 YoYo桥队列，等待云端 Muse 拉取…"
        : `正在请求 ${activeLabel}…`,
    );

    const controller = new AbortController();
    abortRef.current = controller;

    const apiMessages = nextHistory
      .filter((m) => !m.error)
      .map((m, idx, arr) => {
        if (idx === arr.length - 1 && m.role === "user" && currentAttached.length > 0) {
          const refsText = currentAttached
            .map((ref) =>
              ref.source === "node"
                ? `- @${ref.title}${ref.seq != null ? ` #${ref.seq}` : ""} => 画布已有节点 nodeId=${ref.id}, type=${ref.kind}`
                : `- @${ref.title}${ref.seq != null ? ` #${ref.seq}` : ""} => 项目资产库 assetId=${ref.id}, kind=${ref.kind}`,
            )
            .join("\n");
          return {
            role: m.role,
            content: `${m.content}\n\n[已引用画布节点/资产映射：\n${refsText}\n]`,
          };
        }
        return { role: m.role, content: m.content };
      });

    const imageRefs: { label: string; mediaUrl: string }[] = [];
    const seenUrls = new Set<string>();
    for (const ref of currentAttached) {
      if (ref.kind === "image" && ref.mediaUrl && !seenUrls.has(ref.mediaUrl)) {
        seenUrls.add(ref.mediaUrl);
        imageRefs.push({ label: ref.title, mediaUrl: ref.mediaUrl });
      }
    }
    for (const n of nodes) {
      if (
        selectedIds.has(n.id) &&
        n.type === "image" &&
        n.mediaUrl &&
        !seenUrls.has(n.mediaUrl)
      ) {
        seenUrls.add(n.mediaUrl);
        imageRefs.push({ label: n.title || "选中图片", mediaUrl: n.mediaUrl });
      }
    }

    try {
      const resp = await fetch("/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          profileId: activeProfileId,
          messages: apiMessages,
          canvasContext: serializeCanvasContext(nodes, edges, selectedIds, assets),
          imageRefs: imageRefs.slice(0, 4),
          stream: activeProfile?.provider !== "muse",
        }),
      });
      if (!resp.ok) {
        const errData = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error ?? `请求失败 (${resp.status})`);
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let doneReply = "";
        let doneOps: AgentOperation[] = [];
        let gotDone = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              const raw = line.slice(5).trim();
              if (!raw) continue;
              let payload: Record<string, unknown>;
              try {
                payload = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (currentEvent === "thinking") {
                const chars = Number(payload.chars ?? 0);
                setBusyHint(`${activeProfile?.name ?? "模型"} 思考中（已输出 ${chars} 字）…`);
              } else if (currentEvent === "delta") {
                const totalChars = Number(payload.totalChars ?? 0);
                setBusyHint(`${activeProfile?.name ?? "模型"} 正在生成回复（${totalChars} 字）…`);
              } else if (currentEvent === "error") {
                throw new Error(String(payload.error ?? "流式生成失败"));
              } else if (currentEvent === "done") {
                doneReply = String(payload.reply ?? "");
                doneOps = Array.isArray(payload.operations)
                  ? (payload.operations as AgentOperation[])
                  : [];
                gotDone = true;
              }
            }
          }
        }
        abortRef.current = null;
        if (gotDone) {
          await finishTurn(doneReply, doneOps);
        }
        return;
      }

      const data = (await resp.json()) as {
        status?: "pending" | "done";
        turnId?: string;
        reply?: string;
        operations?: AgentOperation[];
        error?: string;
      };
      if (data.status === "pending" && data.turnId) {
        activeTurnIdRef.current = data.turnId;
        pollTimerRef.current = window.setTimeout(() => {
          void pollMuseTurn(data.turnId!, Date.now());
        }, 1500);
        return;
      }
      abortRef.current = null;
      await finishTurn(data.reply ?? "", data.operations ?? []);
    } catch (err) {
      abortRef.current = null;
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const meta = turnMetaRef.current;
      if (meta) {
        appendLog({
          profileName: meta.profileName,
          provider: meta.provider,
          status: "error",
          durationMs: Date.now() - meta.startedAt,
          promptPreview: meta.promptPreview,
          summary: "请求失败",
          detail: errMsg,
        });
        turnMetaRef.current = null;
      }
      setMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            content: err instanceof Error ? err.message : String(err),
            error: true,
          },
        ];
        void persistSession(next);
        return next;
      });
      setBusy(false);
      setBusyHint("");
    }
  };

  if (!open) {
    return (
      <AgentConfigModal
        open={configOpen}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onClose={() => setConfigOpen(false)}
        onRefresh={loadConfig}
        showToast={showToast}
      />
    );
  }

  return (
    <>
      <aside
        data-ui
        data-canvas-no-zoom
        className="capsule-chrome safe-top-offset fixed bottom-3 right-3 top-16 z-[110] flex max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow)]"
        style={{ width: drawerWidth }}
        aria-label="画布 Agent"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="absolute inset-y-0 left-0 z-40 hidden w-3 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-5 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:transition-colors hover:after:bg-[var(--accent)]/70 data-[resizing=true]:after:bg-[var(--accent)] md:block"
          style={{ touchAction: "none" }}
          onPointerDown={startResize}
          aria-label="调整 Agent 面板宽度"
          data-resizing={resizing}
        />
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
          <AgentOrbIcon size={26} thinking={busy} />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-semibold">画布 Agent</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setSkillsOpen((v) => !v);
              setHistoryOpen(false);
              setLogsOpen(false);
            }}
            className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
              skillsOpen
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            }`}
          >
            技能{skills.filter((s) => s.enabled).length > 0 ? `(${skills.filter((s) => s.enabled).length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setHistoryOpen((v) => !v);
              setSkillsOpen(false);
              setLogsOpen(false);
            }}
            className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
              historyOpen
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            }`}
          >
            历史{sessions.length > 0 ? `(${sessions.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => {
              setLogsOpen((v) => !v);
              setSkillsOpen(false);
              setHistoryOpen(false);
            }}
            className={`rounded-lg border px-2 py-1 text-[11px] transition-colors ${
              logsOpen
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            }`}
          >
            日志{logs.length > 0 ? `(${logs.length})` : ""}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const nextId = makeSessionId();
              setSessionId(nextId);
              setMessages([]);
              setHistoryOpen(false);
              if (projectId) {
                void fetch("/agent/history/activate", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ projectId, sessionId: null }),
                }).catch(() => {});
              }
            }}
            className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40"
          >
            新对话
          </button>
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            className="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            模型配置
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="关闭 Agent 面板"
          >
            <IconX size={15} />
          </button>
        </div>

        {skillsOpen ? (
          <AgentSkillsPanel
            skills={skills}
            activeProfileId={activeProfileId}
            canvasContext={serializeCanvasContext(nodes, edges, selectedIds, assets)}
            messages={messages
              .filter((m) => !m.error)
              .map((m) => ({ role: m.role, content: m.content }))}
            onClose={() => setSkillsOpen(false)}
            onRefresh={loadSkills}
            onUseSkill={(skill) => {
              setInput(skill.defaultPrompt || `$${skill.slug} `);
              setSkillsOpen(false);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            showToast={showToast}
          />
        ) : logsOpen ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3.5 text-xs">
            <div className="flex items-center justify-between text-[var(--dim)]">
              <span>Agent 执行日志（最近 {logs.length} 条）</span>
              <div className="flex items-center gap-2">
                {logs.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setLogs([])}
                    className="hover:text-[var(--text)]"
                  >
                    清空
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setLogsOpen(false)}
                  className="hover:text-[var(--text)]"
                >
                  返回对话
                </button>
              </div>
            </div>
            {logs.length === 0 ? (
              <p className="py-8 text-center text-[var(--dim)]">暂无执行日志</p>
            ) : (
              logs.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        entry.status === "ok"
                          ? "bg-[var(--teal)]/15 text-[var(--teal)]"
                          : entry.status === "error"
                            ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                            : "bg-[var(--hover)] text-[var(--dim)]"
                      }`}
                    >
                      {entry.status === "ok" ? "成功" : entry.status === "error" ? "失败" : "已停止"}
                    </span>
                    <span className="truncate font-medium text-[var(--text)]">
                      {entry.profileName}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--dim)] tabular-nums">
                      {entry.durationMs}ms · {formatSessionTime(entry.at)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-[var(--dim)]">
                    提问：{entry.promptPreview}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--text)]">
                    结果：{entry.summary}
                  </p>
                  {entry.detail ? (
                    <p className="mt-1 whitespace-pre-wrap break-words rounded bg-[var(--surface)] p-1.5 text-[10px] text-[var(--danger)]">
                      {entry.detail}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : historyOpen ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3.5">
            <div className="flex items-center justify-between text-xs text-[var(--dim)]">
              <span>当前项目历史对话</span>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="hover:text-[var(--text)]"
              >
                返回当前对话
              </button>
            </div>
            {sessions.length === 0 ? (
              <p className="py-8 text-center text-xs text-[var(--dim)]">
                暂无历史对话记录
              </p>
            ) : (
              sessions.map((s) => {
                const active = s.id === sessionId;
                return (
                  <div
                    key={s.id}
                    className={`flex items-center gap-2 rounded-xl border p-2.5 text-xs transition-colors ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]/30"
                        : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)]/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSessionId(s.id);
                        setMessages(s.messages ?? []);
                        setHistoryOpen(false);
                        if (projectId) {
                          void fetch("/agent/history/activate", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ projectId, sessionId: s.id }),
                          }).catch(() => {});
                        }
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate font-medium text-[var(--text)]">
                        {s.title}
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--dim)]">
                        {formatSessionTime(s.updatedAt)} · {s.messages.length} 条消息
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!projectId) return;
                        void fetch("/agent/history/delete", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ projectId, sessionId: s.id }),
                        })
                          .then((r) => r.json())
                          .then((data: { activeSessionId?: string | null; sessions?: StoredAgentSession[] }) => {
                            const nextList = data.sessions ?? [];
                            setSessions(nextList);
                            if (s.id === sessionId) {
                              const nextActive = nextList.find((x) => x.id === data.activeSessionId) ?? nextList[0];
                              if (nextActive) {
                                setSessionId(nextActive.id);
                                setMessages(nextActive.messages ?? []);
                              } else {
                                setSessionId(makeSessionId());
                                setMessages([]);
                              }
                            }
                          })
                          .catch(() => {});
                      }}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                      aria-label="删除对话"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : (
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
          {messages.length === 0 ? (
            <div className="space-y-3 py-4">
              <div className="flex flex-col items-center gap-2 text-center">
                <AgentOrbIcon size={44} />
                <p className="text-xs font-medium text-[var(--text)]">
                  我可以读取画布节点与连线，帮你写提示词、搭工作流并触发生成
                </p>
                <p className="text-[11px] text-[var(--dim)]">
                  画布修改支持 Ctrl+Z 一键撤销
                </p>
              </div>
              <div className="space-y-1.5 pt-2">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void sendMessage(q)}
                    className="block w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left text-xs text-[var(--dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                  m.role === "user"
                    ? "bg-[var(--accent)] text-white"
                    : m.error
                      ? "border border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]"
                      : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]"
                }`}
              >
                {m.role === "user"
                  ? renderTokenizedText(
                      formatMessageForDisplay(m.content),
                      true,
                      mentionCandidates.map(mentionToken),
                    )
                  : m.content}
              </div>
              {m.operations &&
              m.operations.some((op) => (op.prompt && op.prompt.trim()) || (op.content && op.content.trim())) ? (
                <div className="mt-1.5 w-[90%] space-y-1.5">
                  {m.operations
                    .filter((op) => (op.prompt && op.prompt.trim()) || (op.content && op.content.trim()))
                    .map((op, idx) => {
                      const textToShow = (op.prompt || op.content || "").trim();
                      const copyKey = `${m.id}-${idx}`;
                      return (
                        <div
                          key={copyKey}
                          className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px]"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2 text-[var(--dim)]">
                            <span className="truncate font-medium text-[var(--text)]">
                              {op.title || (op.type ? `${op.type} 节点` : "节点提示词")}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  const title = (
                                    op.title ||
                                    textToShow.slice(0, 24) ||
                                    "Agent 提示词"
                                  ).slice(0, 80);
                                  void api
                                    .addPrompt({ title, content: textToShow })
                                    .then(() => {
                                      void queryClient.invalidateQueries({ queryKey: ["prompts"] });
                                      showToast("已保存到左侧「提示词库」");
                                    })
                                    .catch((err) => {
                                      showToast(
                                        `保存失败：${err instanceof Error ? err.message : String(err)}`,
                                      );
                                    });
                                }}
                                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                              >
                                存词库
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(textToShow).then(() => {
                                    setCopiedKey(copyKey);
                                    window.setTimeout(() => setCopiedKey(null), 1500);
                                  });
                                }}
                                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                              >
                                {copiedKey === copyKey ? "已复制" : "复制"}
                              </button>
                            </div>
                          </div>
                          <p className="whitespace-pre-wrap break-words leading-relaxed text-[var(--dim)]">
                            {textToShow}
                          </p>
                        </div>
                      );
                    })}
                </div>
              ) : null}
              {m.appliedSummary ? (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--dim)]">
                  <span className="rounded-md bg-[var(--hover)] px-2 py-0.5">
                    已执行：{m.appliedSummary}
                  </span>
                  {m.pendingGenerateNodeIds && m.pendingGenerateNodeIds.length > 0 ? (
                    <>
                      {onLocateNode ? (
                        <button
                          type="button"
                          onClick={() => onLocateNode(m.pendingGenerateNodeIds![0]!)}
                          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                          title="在画布上定位并高亮该节点"
                        >
                          定位
                        </button>
                      ) : null}
                      {m.generateTriggered ? (
                      confirmRegenMsgId === m.id ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent)]/50 bg-[var(--accent-soft)]/50 px-2 py-0.5 text-[11px] text-[var(--text)]">
                          <span>已经生成过，是否重新生成？</span>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmRegenMsgId(null);
                              void onTriggerGenerateNodes(m.pendingGenerateNodeIds!);
                            }}
                            className="rounded bg-[var(--accent)] px-1.5 py-0.2 font-medium text-white hover:opacity-90"
                          >
                            确认
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRegenMsgId(null)}
                            className="rounded border border-[var(--border)] px-1.5 py-0.2 text-[var(--dim)] hover:text-[var(--text)]"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRegenMsgId(m.id)}
                          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 font-medium text-[var(--text)] hover:border-[var(--accent)]"
                        >
                          重新生成（{m.pendingGenerateNodeIds.length}）
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          const ids = m.pendingGenerateNodeIds!;
                          setMessages((prev) => {
                            const next = prev.map((item) =>
                              item.id === m.id
                                ? { ...item, generateTriggered: true }
                                : item,
                            );
                            void persistSession(next);
                            return next;
                          });
                          void onTriggerGenerateNodes(ids);
                        }}
                        className="rounded-md bg-[var(--accent)] px-2 py-0.5 font-medium text-white hover:opacity-90"
                      >
                        立即触发生成（{m.pendingGenerateNodeIds.length}）
                      </button>
                    )}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}

          {busy ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--dim)]">
              <AgentOrbIcon size={18} thinking />
              <span>{busyHint || "思考中…"}</span>
            </div>
          ) : null}
        </div>
        )}

        <div className="relative shrink-0 p-3 pt-2">
          {mentionRange ? (
            <div
              className="absolute bottom-[calc(100%-2px)] left-3 right-3 z-20 max-h-56 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow)]"
              role="listbox"
              aria-label="选择项目资产"
            >
              <div className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--dim)]">
                <span>选择要引用的项目资产</span>
                <button
                  type="button"
                  onClick={() => setMentionRange(null)}
                  className="hover:text-[var(--text)]"
                >
                  关闭
                </button>
              </div>
              {filteredMentions.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-[var(--dim)]">
                  {mentionCandidates.length === 0 ? "当前画布与资产库均为空" : "没有匹配的节点或资产"}
                </div>
              ) : (
                filteredMentions.map((item, idx) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      const token = `@${item.title}${item.seq != null ? `#${item.seq}` : ""} `;
                      const before = input.slice(0, mentionRange.start);
                      const after = input.slice(mentionRange.end);
                      setInput(`${before}${token}${after}`);
                      setAttachedRefs((prev) =>
                        prev.some((x) => x.key === item.key) ? prev : [...prev, item],
                      );
                      setMentionRange(null);
                      requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (el) {
                          const pos = before.length + token.length;
                          el.focus();
                          el.setSelectionRange(pos, pos);
                        }
                      });
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      idx === mentionIdx
                        ? "bg-[var(--accent-soft)] text-[var(--text)]"
                        : "hover:bg-[var(--hover)]"
                    }`}
                  >
                    {item.mediaUrl ? (
                      <img
                        src={item.mediaUrl}
                        alt=""
                        className="h-7 w-7 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-[var(--surface-2)] text-[10px] uppercase text-[var(--dim)]">
                        {item.kind.slice(0, 3)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{item.title}</span>
                        {item.seq != null ? (
                          <span className="shrink-0 rounded bg-[var(--accent-soft)] px-1 py-0.2 text-[10px] font-semibold text-[var(--accent)]">
                            #{item.seq}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[10px] text-[var(--dim)]">
                        {item.source === "node" ? "画布节点" : "项目资产"} · {item.kind}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}

          {skillRange ? (
            <div
              className="absolute bottom-[calc(100%-2px)] left-3 right-3 z-20 max-h-56 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow)]"
              role="listbox"
              aria-label="选择 Skill"
            >
              <div className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--dim)]">
                <span>选择要调用的 Skill</span>
                <button
                  type="button"
                  onClick={() => setSkillRange(null)}
                  className="hover:text-[var(--text)]"
                >
                  关闭
                </button>
              </div>
              {filteredSkills.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-[var(--dim)]">
                  暂无已启用的 Skill，可点顶部「技能」新建或提取
                </div>
              ) : (
                filteredSkills.map((s, idx) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      const token = `$${s.slug} `;
                      const before = input.slice(0, skillRange.start);
                      const after = input.slice(skillRange.end);
                      setInput(`${before}${token}${after}`);
                      setSkillRange(null);
                      requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (el) {
                          const pos = before.length + token.length;
                          el.focus();
                          el.setSelectionRange(pos, pos);
                        }
                      });
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      idx === skillIdx
                        ? "bg-[var(--accent-soft)] text-[var(--text)]"
                        : "hover:bg-[var(--hover)]"
                    }`}
                  >
                    <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                      ${s.slug}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{s.name}</div>
                      {s.description ? (
                        <div className="truncate text-[10px] text-[var(--dim)]">
                          {s.description}
                        </div>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : null}

          <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] transition-colors focus-within:border-[var(--accent)]">
            {attachedRefs.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)]/60 px-3 pt-2.5 pb-2">
                {attachedRefs.map((item) => (
                  <span
                    key={item.key}
                    className="inline-flex max-w-[210px] items-center gap-1.5 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)]/50 py-0.5 pl-1 pr-1.5 text-[11px]"
                  >
                    {item.mediaUrl ? (
                      <img
                        src={item.mediaUrl}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="rounded bg-[var(--surface-2)] px-1 text-[9px] uppercase text-[var(--dim)]">
                        {item.kind.slice(0, 3)}
                      </span>
                    )}
                    <span className="truncate font-medium text-[var(--accent)]">
                      @{item.title}
                    </span>
                    {item.seq != null ? (
                      <span className="shrink-0 font-semibold text-[var(--accent)]">
                        #{item.seq}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setAttachedRefs((prev) => prev.filter((x) => x.key !== item.key));
                        const tok = mentionToken(item);
                        setInput((prev) =>
                          prev
                            .replace(new RegExp(`${escapeRegExp(tok)}\\s?`, "g"), "")
                            .replace(/\s{2,}/g, " "),
                        );
                      }}
                      className="shrink-0 text-[var(--dim)] hover:text-[var(--danger)]"
                      aria-label="移除引用"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="relative">
              <div
                ref={highlightRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3.5 pt-3 pb-2 text-xs leading-relaxed text-[var(--text)]"
              >
                {input
                  ? renderTokenizedText(
                      input,
                      false,
                      [...attachedRefs, ...mentionCandidates].map(mentionToken),
                    )
                  : null}
                {input.endsWith("\n") ? " " : ""}
              </div>
              <textarea
                ref={textareaRef}
                value={input}
                onScroll={(e) => {
                  if (highlightRef.current) {
                    highlightRef.current.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
                onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                setAttachedRefs((prev) =>
                  prev.filter((item) => val.includes(mentionToken(item))),
                );
                const caret = e.target.selectionStart ?? val.length;
                const upToCaret = val.slice(0, caret);
                const atMatch = upToCaret.match(/(?:^|[\s，。,.])@([^\s@\[\]]*)$/);
                if (atMatch && atMatch.index !== undefined) {
                  const atPos = upToCaret.lastIndexOf("@");
                  setMentionRange({ start: atPos, end: caret, query: atMatch[1] ?? "" });
                  setMentionIdx(0);
                  setSkillRange(null);
                  return;
                }
                setMentionRange(null);
                const dollarMatch = upToCaret.match(/(?:^|[\s，。,.])\$([^\s$]*)$/);
                if (dollarMatch && dollarMatch.index !== undefined) {
                  const dPos = upToCaret.lastIndexOf("$");
                  setSkillRange({ start: dPos, end: caret, query: dollarMatch[1] ?? "" });
                  setSkillIdx(0);
                } else {
                  setSkillRange(null);
                }
              }}
              onKeyDown={(e) => {
                if (mentionRange && filteredMentions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIdx((i) => (i + 1) % filteredMentions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIdx((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const picked = filteredMentions[mentionIdx] ?? filteredMentions[0];
                    if (picked) {
                      const token = `@${picked.title}${picked.seq != null ? `#${picked.seq}` : ""} `;
                      const before = input.slice(0, mentionRange.start);
                      const after = input.slice(mentionRange.end);
                      setInput(`${before}${token}${after}`);
                      setAttachedRefs((prev) =>
                        prev.some((x) => x.key === picked.key) ? prev : [...prev, picked],
                      );
                      setMentionRange(null);
                    }
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMentionRange(null);
                    return;
                  }
                }
                if (skillRange && filteredSkills.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSkillIdx((i) => (i + 1) % filteredSkills.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSkillIdx((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const picked = filteredSkills[skillIdx] ?? filteredSkills[0];
                    if (picked) {
                      const token = `$${picked.slug} `;
                      const before = input.slice(0, skillRange.start);
                      const after = input.slice(skillRange.end);
                      setInput(`${before}${token}${after}`);
                      setSkillRange(null);
                    }
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSkillRange(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              rows={3}
              placeholder="输入需求，@ 引用资产，$ 调用技能，Enter 发送…"
              className="relative z-10 min-h-[84px] max-h-[200px] w-full resize-y bg-transparent px-3.5 pt-3 pb-2 text-xs leading-relaxed text-transparent caret-[var(--text)] placeholder:text-[var(--dim)] outline-none"
            />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <select
                  value={activeProfileId}
                  onChange={(e) => void switchProfile(e.target.value)}
                  disabled={busy}
                  className="max-w-[210px] truncate rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--dim)] outline-none hover:border-[var(--accent)] hover:text-[var(--text)] focus:border-[var(--accent)]"
                  aria-label="选择 Agent 模型"
                  title={
                    (() => {
                      const cur = profiles.find((x) => x.id === activeProfileId);
                      return cur ? `当前：${profileDisplayName(cur)}（${cur.name}）` : "切换 Agent 模型";
                    })()
                  }
                >
                  {profiles.map((p) => {
                    const agyDisabled =
                      p.provider === "agy" &&
                      !(agy.status ? agy.ready : Boolean(p.ready));
                    return (
                      <option key={p.id} value={p.id} disabled={agyDisabled}>
                        {profileDisplayName(p)}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const el = textareaRef.current;
                    const caret = el?.selectionStart ?? input.length;
                    const needsSpace = caret > 0 && !/\s/.test(input[caret - 1] ?? "");
                    const insert = `${needsSpace ? " " : ""}@`;
                    const next = `${input.slice(0, caret)}${insert}${input.slice(caret)}`;
                    const atPos = caret + (needsSpace ? 1 : 0);
                    setInput(next);
                    setMentionRange({ start: atPos, end: atPos + 1, query: "" });
                    setMentionIdx(0);
                    requestAnimationFrame(() => {
                      if (el) {
                        el.focus();
                        el.setSelectionRange(atPos + 1, atPos + 1);
                      }
                    });
                  }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
                  title="引用项目资产库中的图片/视频/音频"
                >
                  @ 引用资产
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const el = textareaRef.current;
                    const caret = el?.selectionStart ?? input.length;
                    const needsSpace = caret > 0 && !/\s/.test(input[caret - 1] ?? "");
                    const insert = `${needsSpace ? " " : ""}$`;
                    const next = `${input.slice(0, caret)}${insert}${input.slice(caret)}`;
                    const dPos = caret + (needsSpace ? 1 : 0);
                    setInput(next);
                    setSkillRange({ start: dPos, end: dPos + 1, query: "" });
                    setSkillIdx(0);
                    setMentionRange(null);
                    requestAnimationFrame(() => {
                      if (el) {
                        el.focus();
                        el.setSelectionRange(dPos + 1, dPos + 1);
                      }
                    });
                  }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
                  title="调用本地 Skill 工作流"
                >
                  $ 技能
                </button>
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--text)]"
                  title="不勾选则建好节点后由你点击确认"
                >
                  <input
                    type="checkbox"
                    checked={autoTriggerGenerate}
                    onChange={(e) => setAutoTriggerGenerate(e.target.checked)}
                    className="rounded border-[var(--border)] accent-[var(--accent)]"
                  />
                  <span>自动触发生成</span>
                </label>
              </div>
              {busy ? (
                <button
                  type="button"
                  onClick={stopGenerating}
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--danger)] text-white transition-all hover:opacity-90 active:scale-95"
                  aria-label="停止生成"
                  title="停止当前 AI 工作"
                >
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect x="5" y="5" width="14" height="14" rx="2.5" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!input.trim()}
                  onClick={() => void sendMessage()}
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] transition-all hover:opacity-90 active:scale-95 disabled:cursor-default disabled:bg-[var(--surface-3)] disabled:text-[var(--dim)] disabled:opacity-60"
                  aria-label="发送给 Agent"
                >
                  <svg
                    width={15}
                    height={15}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>

      <AgentConfigModal
        open={configOpen}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onClose={() => setConfigOpen(false)}
        onRefresh={loadConfig}
        showToast={showToast}
      />
    </>
  );
}
