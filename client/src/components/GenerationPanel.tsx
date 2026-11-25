import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ChipPromptInput, referenceLabels } from "./ChipPromptInput";
import { VideoDurationSelect } from "./VideoDurationSelect";
import {
  IconArrowUp,
  IconBookOpen,
  IconCheck,
  IconConfig,
  IconMaximize,
  IconMinimize,
  IconPlus,
  IconX,
  NODE_TYPE_ICON,
} from "../icons";
import {
  EMPTY_RUN_FEEDBACK,
  RUN_DONE,
  RUN_FAILED,
  RUN_FAILED_OUTLINE,
  RUN_PRESS,
  RUN_RUNNING,
  RunSpinner,
  msOf,
  useElapsedSeconds,
  type NodeRunFeedback,
} from "./run-feedback";
import {
  CONFIG_MODES,
  IMAGE_RATIOS,
  NODE_TYPE_LABEL,
  VIDEO_SECONDS_DEFAULT,
  type CanvasNode,
  type GenMode,
  type ReferenceInfo,
} from "../types";
import { RatioSelect } from "./RatioSelect";
import { useAgyStatus, type AgyEngine } from "../hooks/use-agy";
import { useGeminiWebStatus } from "../hooks/use-gemini-web";
import {
  closestImageRatio,
  getMaskEditModeMeta,
  MASK_EDIT_MODES,
  parseGenSize,
  readNodeMaskMode,
  writeNodeMaskMode,
  type MaskEditMode,
} from "./mask-helpers";


// Generation panel for image / video / audio / config nodes, shaped
// after the upstream composer that sits under the node: a 参考内容
// reference strip on top (connected inputs as tiles, a + tile that
// connects another canvas node in), the prompt input (chip input for
// config nodes, plain textarea otherwise) with a per-mode placeholder,
// and one bottom bar — expand toggle, 提示词库 insert, the model
// picker, the params controls (video ratio + duration and image
// ratio sit inline in the bar: the ratio is the shared RatioSelect
// dropdown, the image pixel size following the selected ratio as
// plain text; the remaining modes keep a summary chip that opens
// the mode / duration controls), and the round send button. Below
// the bar, the run state: queued/working progress, failed reason
// with retry, done summary.


export function GenerationPanel({
  node,
  references,
  candidates,
  inputsByNodeId,
  onPatch,
  onDisconnect,
  onConnectNode,
  onGenerate,
  busy,
  feedback,
}: {
  node: CanvasNode;
  references: ReferenceInfo[];
  /** Other canvas nodes the + tile can connect in as references. */
  candidates: CanvasNode[];
  inputsByNodeId?: Map<string, CanvasNode[]>;
  onPatch: (patch: Partial<CanvasNode>) => void;
  onDisconnect: (edgeId: string) => void;
  onConnectNode: (nodeId: string) => void;
  onGenerate: () => void;
  busy: boolean;
  feedback?: NodeRunFeedback;
}) {
  const agy = useAgyStatus();
  const geminiWeb = useGeminiWebStatus();
  const isConfig = node.type === "config";
  const mode: GenMode = isConfig ? (node.genMode ?? "image") : node.type === "video" ? "video" : node.type === "audio" ? "audio" : "image";
  const maskRef =
    mode === "image"
      ? references.find((r) => r.node.type === "image-mask") ?? null
      : null;
  const [maskMode, setMaskMode] = useState<MaskEditMode>(() =>
    readNodeMaskMode(node.id),
  );
  useEffect(() => {
    setMaskMode(readNodeMaskMode(node.id));
  }, [node.id]);
  const selectMaskMode = (next: MaskEditMode) => {
    setMaskMode(next);
    writeNodeMaskMode(node.id, next);
  };
  const maskUpstreams = maskRef ? inputsByNodeId?.get(maskRef.node.id) ?? [] : [];
  const maskUpstreamBase =
    maskUpstreams.find((u) => u.type === "image" && Boolean(u.mediaUrl)) ?? null;
  const imageRefs = references.filter((r) => r.node.type === "image");
  const directBaseRef = maskRef
    ? (maskUpstreamBase
        ? imageRefs.find((r) => r.node.id === maskUpstreamBase.id) ?? null
        : imageRefs[0] ?? null)
    : null;
  const autoBaseNode = maskRef && !directBaseRef ? maskUpstreamBase : null;
  const baseId = directBaseRef?.node.id ?? autoBaseNode?.id ?? null;
  const extraMaskRefImages = maskRef
    ? imageRefs.filter((r) => r.node.id !== baseId)
    : [];
  const activeMaskModeMeta = getMaskEditModeMeta(maskMode);
  const maskTargetRatio = (() => {
    if (!maskRef) return null;
    const srcNode = maskUpstreamBase ?? directBaseRef?.node ?? null;
    if (srcNode) {
      const parsed = parseGenSize(srcNode.genSize);
      if (parsed) return closestImageRatio(parsed.w, parsed.h);
      if (srcNode.genRatio) return srcNode.genRatio;
      if (srcNode.width > 0 && srcNode.height > 0) {
        return closestImageRatio(srcNode.width, srcNode.height);
      }
    }
    const maskParsed = parseGenSize(maskRef.node.genSize);
    return maskParsed ? closestImageRatio(maskParsed.w, maskParsed.h) : null;
  })();
  const autoMaskRatioKeyRef = useRef<string>("");
  useEffect(() => {
    if (!maskRef || !maskTargetRatio || node.mediaUrl) {
      if (!maskRef) autoMaskRatioKeyRef.current = "";
      return;
    }
    const key = `${node.id}:${maskRef.node.id}:${maskTargetRatio}`;
    if (autoMaskRatioKeyRef.current === key) return;
    autoMaskRatioKeyRef.current = key;
    if (node.genRatio !== maskTargetRatio) {
      onPatch({ genRatio: maskTargetRatio });
    }
  }, [node.id, node.genRatio, node.mediaUrl, maskRef, maskTargetRatio, onPatch]);
  const showRatio = mode === "image" || mode === "video";
  // Video placeholder nodes get ratio + duration inlined into the
  // bottom bar (where the params summary chip used to sit) — no
  // popover to open first. Config nodes keep the chip + popover:
  // theirs also carries the mode tabs, so it is not the same
  // structure.
  const inlineVideoParams = mode === "video" && !isConfig;
  // Image mode inlines its ratio dropdown into the bottom bar as
  // well — placeholder image nodes and config nodes alike: the
  // RatioSelect sits beside the model picker and the pixel size
  // follows the selected ratio as plain text (Wei 2026-11-15 定版：
  // ratio picking is a dropdown everywhere, five ratios). Config
  // nodes keep their params chip beside the dropdown: its popover
  // also carries the mode tabs, which stay reachable there.
  const inlineImageParams = mode === "image";
  const running = node.genStatus === "working" || node.genStatus === "queued";
  // Send-button lifecycle (run-feedback.tsx): live from the local
  // click, elapsed seconds from the server's run clock when known.
  const fb = feedback ?? EMPTY_RUN_FEEDBACK;
  const sendRunning = busy || running || fb.activeKey != null;
  const sendElapsed = useElapsedSeconds(
    msOf(node.genStartedAt) ?? fb.startedAt,
    sendRunning,
  );
  const [expanded, setExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const plainPromptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = plainPromptRef.current;
    if (!el) return;
    if (expanded) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [node.id, node.prompt, expanded]);

  // When a text or sticky-note node is connected and this node's prompt
  // is still empty, auto-fill it once per (node, connectedText) pair so
  // the user can still clear the prompt manually without it snapping back.
  const connectedText = references
    .filter((r) => r.node.type === "text" || r.node.type === "sticky-note")
    .map((r) => r.node.content.trim())
    .filter(Boolean)
    .join("\n");
  const autoFilledKeyRef = useRef<string>("");
  useEffect(() => {
    const key = `${node.id}:${connectedText}`;
    if (!connectedText) {
      autoFilledKeyRef.current = "";
      return;
    }
    if (!node.prompt.trim() && autoFilledKeyRef.current !== key) {
      autoFilledKeyRef.current = key;
      onPatch({ prompt: connectedText });
    }
  }, [node.id, node.prompt, connectedText, onPatch]);
  const [showPicker, setShowPicker] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const promptsQ = useQuery({
    queryKey: ["prompts"],
    queryFn: () => api.listPrompts({}),
    enabled: showPrompts,
  });
  const connectedIds = new Set(references.map((r) => r.node.id));
  const addable = candidates.filter(
    (c) => c.id !== node.id && !connectedIds.has(c.id),
  );
  // No stored ratio yet: the default selection is 16:9 for image
  // and video alike (new nodes are also born storing 16:9).
  const ratio = node.genRatio ?? "16:9";
  const ratioSize = IMAGE_RATIOS.find((r) => r.ratio === ratio)?.size;
  const paramsSummary =
    mode === "image"
      ? isConfig
        ? // The ratio + size already sit inline in the bar; the
          // config chip (kept for the mode tabs) summarizes the
          // mode instead of repeating them.
          "生图"
        : `${ratio}${ratioSize ? ` · ${ratioSize}` : ""}`
      : mode === "video"
        ? `${ratio} · ${node.genDuration ?? VIDEO_SECONDS_DEFAULT} 秒`
        : mode === "audio"
          ? "音频生成"
          : "文本生成";
  const promptPlaceholder =
    maskRef
      ? activeMaskModeMeta.placeholder
      : mode === "image"
        ? "描述要生成的图片内容"
        : mode === "video"
          ? "描述要生成的视频内容"
          : mode === "audio"
            ? "描述要生成的音频内容"
            : "描述要生成的内容";
  const sendLabel =
    node.genStatus === "queued"
      ? "立即生成"
      : node.genStatus === "failed"
        ? "重新生成"
        : "生成";
  // Config nodes follow the reference gate; when an image-mask is connected,
  // remove mode permits empty prompts and outfit/face permit ref-only runs.
  const maskAllowsEmptyPrompt =
    Boolean(maskRef) &&
    (maskMode === "remove" ||
      ((maskMode === "outfit" || maskMode === "face") &&
        extraMaskRefImages.length > 0));
  const configCanGenerate =
    maskAllowsEmptyPrompt ||
    !isConfig ||
    node.prompt.trim().length > 0 ||
    (mode === "audio"
      ? references.some((r) => r.node.type === "text")
      : references.length > 0);
  const labelById = referenceLabels(references);
  const insertRefMention = (ref: ReferenceInfo) => {
    const useChipToken = isConfig || node.type === "image" || node.type === "video";
    const mention = useChipToken
      ? `@[node:${ref.node.id}]`
      : `@${labelById.get(ref.node.id) ?? ref.node.title}`;
    const cur = node.prompt;
    const sep = cur && !/\s$/.test(cur) ? " " : "";
    onPatch({ prompt: `${cur}${sep}${mention} ` });
  };
  const insertPrompt = (content: string) => {
    onPatch({
      prompt: node.prompt.trim()
        ? `${node.prompt.replace(/\s+$/, "")}\n${content}`
        : content,
    });
    setShowPrompts(false);
  };

  return (
    <div className="space-y-2.5">
      {/* ------------------------------------------------ top row: refs + expand */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {references.map((ref) => {
            const Icon = NODE_TYPE_ICON[ref.node.type];
            const label = labelById.get(ref.node.id) ?? ref.node.title;
            const thumb =
              ref.node.type === "image" || ref.node.type === "image-mask"
                ? ref.node.mediaUrl
                : ref.node.type === "video"
                  ? ref.node.posterUrl
                  : null;
            const roleTag = maskRef
              ? ref.node.id === maskRef.node.id
                ? "蒙版"
                : ref.node.id === directBaseRef?.node.id
                  ? "底图"
                  : ref.node.type === "image"
                    ? "参考"
                    : null
              : null;
            return (
              <div
                key={`${ref.edgeId}:${ref.node.id}`}
                role="button"
                tabIndex={0}
                onClick={() => insertRefMention(ref)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    insertRefMention(ref);
                  }
                }}
                className="group/ref relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-3)] transition-colors hover:border-[var(--accent)]"
                title={`点击插入 @${label}（${ref.node.title}）`}
                aria-label={`插入参考 @${label}`}
              >
                {thumb ? (
                  <img src={thumb} alt={ref.node.title} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 text-[var(--dim)]">
                    {Icon ? <Icon size={15} /> : null}
                    <span className="max-w-full truncate px-0.5 text-[9px]">
                      {NODE_TYPE_LABEL[ref.node.type]}
                    </span>
                  </span>
                )}
                {roleTag ? (
                  <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/70 px-0.5 text-center text-[9px] leading-3 text-white">
                    {roleTag}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDisconnect(ref.edgeId);
                  }}
                  className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-black/75 text-white opacity-0 transition-opacity hover:bg-black focus-visible:opacity-100 group-hover/ref:opacity-100"
                  aria-label={`断开参考 ${ref.node.title}`}
                >
                  <IconX size={10} />
                </button>
              </div>
            );
          })}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowPicker((v) => !v);
                setShowPrompts(false);
              }}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              aria-label="添加参考内容"
              aria-expanded={showPicker}
              title="添加参考内容（或从画布连入左侧端口）"
            >
              <IconPlus size={18} />
            </button>
            {showPicker ? (
              <div className="absolute left-0 top-full z-30 mt-1 max-h-56 w-60 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1.5 shadow-[var(--shadow)]">
                {addable.length === 0 ? (
                  <p className="px-2 py-2 text-xs leading-5 text-[var(--dim)]">
                    画布上没有可添加的节点了。
                  </p>
                ) : (
                  addable.map((c) => {
                    const Icon = NODE_TYPE_ICON[c.type];
                    const thumb =
                      c.type === "image"
                        ? c.mediaUrl
                        : c.type === "video"
                          ? c.posterUrl
                          : null;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onConnectNode(c.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                        aria-label={`添加参考 ${c.title}`}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-3)] text-[var(--dim)]">
                          {thumb ? (
                            <img src={thumb} alt="" className="h-full w-full object-cover" />
                          ) : Icon ? (
                            <Icon size={15} />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {c.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--dim)]">
                          {NODE_TYPE_LABEL[c.type]}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          aria-label={expanded ? "收起输入区" : "展开输入区"}
          aria-pressed={expanded}
          title={expanded ? "收起" : "展开"}
        >
          {expanded ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
        </button>
      </div>

      {/* ------------------------------------------------ mask modes (only when an image-mask is connected) */}
      {maskRef ? (
        <div className="space-y-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="蒙版改图模式">
              {MASK_EDIT_MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  onClick={() => selectMaskMode(m.mode)}
                  aria-pressed={maskMode === m.mode}
                  className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                    maskMode === m.mode
                      ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                      : "bg-[var(--surface-3)] text-[var(--dim)] hover:text-[var(--text)]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {autoBaseNode ? (
              <span
                className="max-w-[160px] truncate text-[11px] text-[var(--dim)]"
                title={`自动关联蒙版上游原图：${autoBaseNode.title}`}
              >
                原图：{autoBaseNode.title}
              </span>
            ) : null}
          </div>
          {!maskRef.node.mediaUrl ? (
            <p className="text-[11px] text-[#fbbf24]">
              连入的蒙版尚未绘制，请先在蒙版节点上点击「绘制蒙版」。
            </p>
          ) : activeMaskModeMeta.tip ? (
            <p className="text-[11px] leading-4 text-[var(--dim)]">
              {activeMaskModeMeta.tip}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ prompt input */}
      <div>
        {isConfig || node.type === "image" || node.type === "video" ? (
          <ChipPromptInput
            value={node.prompt}
            references={references}
            onChange={(serialized) => onPatch({ prompt: serialized })}
            ariaLabel={isConfig ? "配置提示词（可 @ 引用连入节点）" : "生成提示词（可 @ 引用参考图或节点）"}
            placeholder={isConfig ? "输入提示词，按 @ 或点击上方参考图引用" : `${promptPlaceholder}（按 @ 或点上方参考图引用）`}
            expanded={expanded}
            minimal
          />
        ) : (
          <textarea
            ref={plainPromptRef}
            value={node.prompt}
            onChange={(e) => onPatch({ prompt: e.target.value })}
            aria-label="生成提示词"
            placeholder={promptPlaceholder}
            rows={3}
            className={`${expanded ? "h-[240px]" : "min-h-[76px] max-h-[280px]"} w-full resize-none bg-transparent px-0.5 py-1 text-sm leading-6 outline-none placeholder:text-[var(--dim)]`}
          />
        )}
      </div>

      {/* ------------------------------------------------ bottom bar */}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowPrompts((v) => !v);
              setShowPicker(false);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label="从提示词库插入"
            aria-expanded={showPrompts}
            title="提示词库"
          >
            <IconBookOpen size={17} />
          </button>
          {showPrompts ? (
            <div className="absolute bottom-full left-0 z-30 mb-1 max-h-56 w-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1.5 shadow-[var(--shadow)]">
              {promptsQ.isPending ? (
                <p className="px-2 py-2 text-xs text-[var(--dim)]">加载中…</p>
              ) : (promptsQ.data?.prompts ?? []).length === 0 ? (
                <p className="px-2 py-2 text-xs leading-5 text-[var(--dim)]">
                  提示词库还是空的，在左侧面板「提示词库」里新建后可从这里插入。
                </p>
              ) : (
                (promptsQ.data?.prompts ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => insertPrompt(p.content)}
                    className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                    aria-label={`插入提示词 ${p.title}`}
                  >
                    <span className="block truncate text-[13px] font-medium">
                      {p.title}
                    </span>
                    <span className="line-clamp-1 block truncate text-[11px] text-[var(--dim)]">
                      {p.content}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        {inlineVideoParams ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <RatioSelect
              value={ratio}
              onChange={(r) => onPatch({ genRatio: r })}
            />
            <label className="flex items-center gap-1 text-xs text-[var(--dim)]">
              时长
              <VideoDurationSelect
                value={node.genDuration ?? VIDEO_SECONDS_DEFAULT}
                onChange={(seconds) => onPatch({ genDuration: seconds })}
                inputClassName="w-[4.5rem] rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[var(--text)]"
              />
            </label>
          </span>
        ) : null}
        {inlineImageParams ? (
          <RatioSelect
            value={ratio}
            onChange={(r) => onPatch({ genRatio: r })}
            showSize
          />
        ) : null}
        {mode === "image" || (isConfig && mode === "text") ? (
          <select
            value={agy.effectiveEngineFor(
              node.id,
              mode === "image"
                ? geminiWeb.ready
                  ? "gemini-web"
                  : agy.ready
                    ? "agy"
                    : "muse"
                : "muse",
              mode === "image" ? geminiWeb.ready : false,
            )}
            onChange={(e) => {
              const next = e.target.value as AgyEngine;
              void agy.setNodeEngine(node.id, next);
            }}
            aria-label="选择生成通道"
            title={
              agy.ready || geminiWeb.ready
                ? "选择本节点走 Muse 桥、本地 AGY 或 Gemini 网页版"
                : "需先在顶部「AGY 引擎」或「Gemini 网页」完成登录后才可切换"
            }
            className="h-9 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          >
            <option value="muse">
              {mode === "image" && (agy.ready || geminiWeb.ready)
                ? "Muse 桥"
                : "Muse 桥（默认）"}
            </option>
            <option value="agy" disabled={!agy.ready}>
              {mode === "image"
                ? `Nano Banana · AGY${!geminiWeb.ready && agy.ready ? "（默认）" : ""}`
                : agy.ready
                  ? `${agy.shortModelName} · AGY`
                  : "AGY"}
              {!agy.ready ? "（未就绪）" : ""}
            </option>
            {mode === "image" ? (
              <option value="gemini-web" disabled={!geminiWeb.ready}>
                Gemini 网页版 (Pro)
                {geminiWeb.ready ? "（默认）" : "（需登录）"}
              </option>
            ) : null}
          </select>
        ) : null}
        {!inlineVideoParams && (!inlineImageParams || isConfig) ? (
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs text-[var(--text)] hover:border-[var(--accent)]"
            aria-label="生成参数"
            aria-expanded={showSettings}
            title={`生成参数：${paramsSummary}`}
          >
            <IconConfig size={14} className="shrink-0 text-[var(--dim)]" />
            <span className="max-w-[7rem] truncate">{paramsSummary}</span>
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy || node.genStatus === "working" || !configCanGenerate}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow ${RUN_PRESS} ${
            !configCanGenerate ? "opacity-40" : ""
          } ${
            fb.flash?.kind === "done"
              ? RUN_DONE
              : fb.flash?.kind === "failed"
                ? RUN_FAILED
                : sendRunning
                  ? RUN_RUNNING
                  : ""
          } ${
            node.genStatus === "failed" && !fb.flash && !sendRunning
              ? RUN_FAILED_OUTLINE
              : ""
          }`}
          aria-label={sendLabel}
          title={sendLabel}
        >
          {fb.flash?.kind === "done" ? (
            <IconCheck size={18} />
          ) : sendRunning ? (
            <RunSpinner size={17} />
          ) : (
            <IconArrowUp size={18} />
          )}
        </button>
      </div>

      {/* --------------------------------------- params (chip 打开) */}
      {showSettings && !inlineVideoParams ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] px-2.5 py-2 text-xs">
          {isConfig ? (
            <span className="flex items-center gap-1" role="group" aria-label="生成模式">
              {CONFIG_MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  onClick={() => onPatch({ genMode: m.mode })}
                  className={`rounded-full px-2.5 py-1 ${
                    mode === m.mode
                      ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                      : "bg-[var(--surface-3)] text-[var(--dim)] hover:text-[var(--text)]"
                  }`}
                  aria-pressed={mode === m.mode}
                  aria-label={`模式 ${m.label}`}
                >
                  {m.label}
                </button>
              ))}
            </span>
          ) : null}
          {/* The ratio dropdown lives here only when it is not
           * already inline in the bottom bar (config video mode);
           * image mode's ratio is inline now, so the popover never
           * repeats it. */}
          {showRatio && !inlineImageParams ? (
            <RatioSelect
              value={ratio}
              onChange={(r) => onPatch({ genRatio: r })}
            />
          ) : null}
          {mode === "video" ? (
            <label className="flex items-center gap-1 text-[var(--dim)]">
              时长
              <VideoDurationSelect
                value={node.genDuration ?? VIDEO_SECONDS_DEFAULT}
                onChange={(seconds) => onPatch({ genDuration: seconds })}
                inputClassName="w-[4.5rem] rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ run state */}
      {busy && !running ? (
        <p className="mt-2.5 flex items-center gap-2 rounded bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--dim)]" role="status">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#f59e0b]" aria-hidden="true" />
          生成中……{sendElapsed >= 1 ? `已运行 ${sendElapsed} 秒` : ""}
        </p>
      ) : null}
      {node.genStatus === "queued" ? (
        <p className="mt-2.5 flex items-center gap-2 rounded bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--dim)]" role="status">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#f59e0b]" aria-hidden="true" />
          已加入队列，等待队列处理（状态条「生成队列」可立即处理）。
        </p>
      ) : node.genStatus === "working" ? (
        <p className="mt-2.5 flex items-center gap-2 rounded bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--dim)]" role="status">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#f59e0b]" aria-hidden="true" />
          {isConfig
            ? "生成中……在后台生成，完成后结果节点会自动出现在旁边。"
            : "生成中……在后台生成，完成后结果会直接填入本节点。"}
          {sendElapsed >= 1 ? `已运行 ${sendElapsed} 秒。` : ""}
        </p>
      ) : node.genStatus === "failed" ? (
        <div
          className={`mt-2.5 rounded bg-[var(--danger-soft)] px-2 py-1.5 text-xs text-[var(--danger)] ${
            fb.flash?.kind === "failed" ? RUN_FAILED_OUTLINE : ""
          }`}
          role="alert"
        >
          <p>生成失败：{node.genError || "未知原因"}</p>
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy}
            className={`mt-1 rounded bg-[var(--danger)] px-2 py-1 font-medium text-white disabled:opacity-40 ${RUN_PRESS}`}
            aria-label="重试生成"
          >
            重试
          </button>
        </div>
      ) : node.genStatus === "done" && !busy ? (
        <p className="mt-2.5 rounded bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--dim)]" role="status">
          {isConfig
            ? "已生成，结果节点在右侧，尺寸为成品文件实测像素。"
            : "已生成，结果已填入本节点，尺寸为成品文件实测像素。"}
        </p>
      ) : null}
    </div>
  );
}
