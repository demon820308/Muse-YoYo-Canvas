// The side panel's 资产 tab: the server-side asset library for the
// open project, grouped by kind. AssetRow is one library row — thumbnail, rename, preview, insert and delete.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api } from "../api";
import {
  ASSET_DRAG_MIME,
  NODE_TYPE_LABEL,
  type Asset,
  type CanvasNode,
  type InsertAssetPayload,
  type NodeType,
} from "../types";
import { isMediaUrl } from "../node-utils";
import {
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconGrid,
  IconInsert,
  IconList,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "../icons";
import { NodeThumb } from "./CanvasNodesTab";

// 资产 tab: server-side asset library grouped by kind — media first
// （图片 / 视频 / 音频） then text and the rest. Generated media lands
// here automatically (server-side, at delivery time); the tab also
// takes direct file uploads, save-from-node and hand-written text
// assets. Tag filter, insert / delete as before.

const KIND_ORDER: NodeType[] = ["image", "video", "audio", "text", "config", "group"];

export function AssetsTab({
  projectId,
  nodes,
  onInsert,
  onPreviewAsset,
  onHoverAsset,
}: {
  projectId: string;
  nodes: CanvasNode[];
  onInsert: (payload: InsertAssetPayload) => void;
  onPreviewAsset: (asset: Asset) => void;
  onHoverAsset: (asset: Asset | null) => void;
}) {
  const queryClient = useQueryClient();
  const assetsQ = useQuery({
    queryKey: ["assets", projectId],
    queryFn: () => api.listAssets({ projectId }),
  });
  const [keyword, setKeyword] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "image" | "video" | "audio" | "text">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageMulti, setManageMulti] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showTags, setShowTags] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [showTextForm, setShowTextForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textTags, setTextTags] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const addAsset = useMutation({
    mutationFn: (args: Parameters<typeof api.addAsset>[0]) => api.addAsset(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      setNotice("已存入资产库");
    },
  });
  const removeAsset = useMutation({
    mutationFn: (id: string) => api.removeAsset({ id, projectId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["assets"] }),
  });
  const renameAsset = useMutation({
    mutationFn: (args: { id: string; title: string }) =>
      api.renameAsset({ ...args, projectId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["assets"] }),
  });
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [assetEditTitle, setAssetEditTitle] = useState("");

  const assets = assetsQ.data?.assets ?? [];
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    assets.forEach((a) => a.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t]) => t);
  }, [assets]);

  const filtered = assets.filter((a) => {
    const query = keyword.trim().toLowerCase();
    const matchesQuery =
      !query ||
      [a.title, a.content, a.prompt, ...a.tags]
        .join(" ")
        .toLowerCase()
        .includes(query);
    const matchesKind = kindFilter === "all" || a.kind === kindFilter;
    const matchesTag = !tagFilter || a.tags.includes(tagFilter);
    return matchesQuery && matchesKind && matchesTag;
  });

  useEffect(() => {
    if (!manageOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (manageMulti) {
          setManageMulti(false);
          setSelectedIds(new Set());
        } else {
          setManageOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [manageOpen, manageMulti]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchInsertSelected = () => {
    filtered
      .filter((a) => selectedIds.has(a.id))
      .forEach((a) => onInsert(buildAssetInsertPayload(a)));
    setManageMulti(false);
    setSelectedIds(new Set());
    setManageOpen(false);
  };

  const batchDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => removeAsset.mutateAsync(id)));
    setSelectedIds(new Set());
    setManageMulti(false);
  };

  const saveNodeAsAsset = (node: CanvasNode) => {
    addAsset.mutate({
      projectId,
      kind: node.type,
      title: node.title,
      content: node.content,
      prompt: node.prompt,
      color: node.color,
      tags: [],
      sourceNodeId: node.id,
      // Media nodes keep their real bytes: the asset references the
      // node's blob (and its project file / poster), so inserting it
      // later restores the actual media, not a stale URL snapshot.
      mediaBlobKey: node.mediaBlobKey,
      mimeType: node.mimeType,
      filePath: node.filePath,
      posterBlobKey: node.posterBlobKey,
    });
    setShowNodePicker(false);
  };

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setNotice(null);
    let saved = 0;
    let skipped = 0;
    try {
      for (const file of Array.from(files)) {
        const kind = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "audio"
              : null;
        if (!kind) {
          skipped += 1;
          continue;
        }
        if (file.size > 256 * 1024 * 1024) {
          skipped += 1;
          continue;
        }
        const { dataBase64, mimeType } = await fileToBase64(file);
        await api.uploadAsset({
          projectId,
          kind,
          fileName: file.name,
          mimeType,
          dataBase64,
        });
        saved += 1;
      }
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      setNotice(
        saved > 0
          ? `已上传 ${saved} 个素材到资产${skipped > 0 ? `，跳过 ${skipped} 个不支持的文件` : ""}`
          : "没有可上传的素材（仅支持图片 / 视频 / 音频文件",
      );
    } catch {
      setNotice("上传失败，请稍后重试");
    } finally {
      setUploading(false);
    }
  };

  const saveTextAsset = () => {
    if (!textTitle.trim()) return;
    addAsset.mutate({
      projectId,
      kind: "text",
      title: textTitle.trim(),
      content: textContent,
      prompt: "",
      color: null,
      tags: textTags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      sourceNodeId: null,
    });
    setTextTitle("");
    setTextContent("");
    setTextTags("");
    setShowTextForm(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-3 pb-2">
        <div className="flex items-center gap-1.5">
          <label className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]">
              <IconSearch size={14} />
            </span>
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索资产"
              aria-label="搜索资产"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-1.5 pl-8 pr-2 text-[13px] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
            />
          </label>
          <button
            type="button"
            onClick={() => setViewMode((v) => (v === "grid" ? "list" : "grid"))}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--dim)] hover:text-[var(--text)]"
            aria-label={viewMode === "grid" ? "切换为列表视图" : "切换为宫格视图"}
            title={viewMode === "grid" ? "列表视图" : "宫格视图"}
          >
            {viewMode === "grid" ? <IconList size={15} /> : <IconGrid size={15} />}
          </button>
          <button
            type="button"
            onClick={() => {
              setManageOpen(true);
              setManageMulti(false);
              setSelectedIds(new Set());
            }}
            className="h-8 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs font-medium text-[var(--dim)] hover:text-[var(--text)]"
          >
            管理
          </button>
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="资产类型筛选">
          {(
            [
              { key: "all", label: "全部" },
              { key: "image", label: "图片" },
              { key: "video", label: "视频" },
              { key: "audio", label: "音频" },
              { key: "text", label: "文本" },
            ] as const
          ).map((item) => {
            const active = kindFilter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => setKindFilter(item.key)}
                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                  active
                    ? "bg-[var(--text)] font-medium text-[var(--bg)]"
                    : "bg-[var(--surface-2)] text-[var(--dim)] hover:text-[var(--text)]"
                }`}
              >
                {item.label}
              </button>
            );
          })}
          {allTags.length ? (
            <button
              type="button"
              onClick={() => setShowTags((v) => !v)}
              aria-expanded={showTags}
              className="ml-auto rounded-full px-2 py-0.5 text-xs text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              {tagFilter ? `#${tagFilter}` : "标签"}
            </button>
          ) : null}
        </div>

        {showTags && allTags.length ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="资产标签过滤">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={tagFilter === tag}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className="rounded-full px-2 py-0.5 text-xs"
                style={{
                  background:
                    tagFilter === tag ? "rgba(var(--accent-rgb),0.16)" : "var(--surface-2)",
                  color: tagFilter === tag ? "var(--accent)" : "var(--dim)",
                }}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40"
          >
            <IconUpload size={13} /> {uploading ? "上传中…" : "上传"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowNodePicker((v) => !v);
              setShowTextForm(false);
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-expanded={showNodePicker}
          >
            <IconBookmark size={13} /> 存节点
          </button>
          <button
            type="button"
            onClick={() => {
              setShowTextForm((v) => !v);
              setShowNodePicker(false);
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-expanded={showTextForm}
          >
            <IconPlus size={13} /> 建文本
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            className="hidden"
            aria-label="上传素材到资产库"
            onChange={(e) => {
              void handleUploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {showNodePicker ? (
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md bg-[var(--surface-2)] p-2">
            {nodes.length === 0 ? (
              <p className="text-xs text-[var(--dim)]">当前画布还没有节点。</p>
            ) : (
              nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => saveNodeAsAsset(node)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--hover)]"
                  aria-label={`把节点 ${node.title} 存为资产`}
                >
                  <NodeThumb node={node} size={24} />
                  <span className="truncate">{node.title}</span>
                  <span className="ml-auto shrink-0 text-[var(--dim)]">
                    {NODE_TYPE_LABEL[node.type]}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {showTextForm ? (
          <div className="space-y-2 rounded-md bg-[var(--surface-2)] p-2">
            <input
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
              placeholder="资产标题"
              aria-label="文本资产标题"
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
            />
            <textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="资产内容"
              aria-label="文本资产内容"
              rows={3}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
            />
            <input
              value={textTags}
              onChange={(e) => setTextTags(e.target.value)}
              placeholder="标签（逗号分隔，可空）"
              aria-label="文本资产标签"
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              disabled={!textTitle.trim() || addAsset.isPending}
              onClick={saveTextAsset}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-ink)] disabled:opacity-40"
            >
              保存资产
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="text-xs text-[var(--accent)]" role="status">
            {notice}
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {assetsQ.isPending ? (
          <p className="px-2 py-8 text-center text-[13px] text-[var(--dim)]">加载中…</p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-[13px] text-[var(--dim)]">
            {assets.length === 0
              ? "资产库还是空的。生成的图片 / 视频 / 音频会自动进来，也可以上传素材、把画布节点存为资产，或新建一条文本资产"
              : "没有匹配的资产"}
          </p>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-2 px-1 pt-1">
            {filtered.map((asset) => (
              <AssetGridCard
                key={asset.id}
                asset={asset}
                manageMode={false}
                selected={false}
                onToggleSelect={() => undefined}
                onPreview={() => onPreviewAsset(asset)}
                onHover={onHoverAsset}
                onInsert={() => onInsert(buildAssetInsertPayload(asset))}
                onDelete={() => removeAsset.mutate(asset.id)}
              />
            ))}
          </div>
        ) : (
          KIND_ORDER.map((kind) => {
            const group = filtered.filter((a) => a.kind === kind);
            if (!group.length) return null;
            const isCollapsed = collapsed.has(kind);
            return (
              <div key={kind} className="mb-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-xs font-semibold text-[var(--dim)]"
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "展开" : "折叠"}资产分组 ${NODE_TYPE_LABEL[kind]}`}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                >
                  {isCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                  {NODE_TYPE_LABEL[kind]}
                  <span className="font-normal">({group.length})</span>
                </button>
                {!isCollapsed &&
                  group.map((asset) => (
                    <AssetRow
                      key={asset.id}
                      asset={asset}
                      manageMode={false}
                      selected={false}
                      onToggleSelect={() => undefined}
                      editing={editingAssetId === asset.id}
                      editTitle={assetEditTitle}
                      onEditTitleChange={setAssetEditTitle}
                      onStartRename={() => {
                        setEditingAssetId(asset.id);
                        setAssetEditTitle(asset.title);
                      }}
                      onCommitRename={() => {
                        const title = assetEditTitle.trim();
                        setEditingAssetId(null);
                        if (title && title !== asset.title) {
                          renameAsset.mutate({ id: asset.id, title });
                        }
                      }}
                      onCancelRename={() => setEditingAssetId(null)}
                      onPreview={() => onPreviewAsset(asset)}
                      onHover={onHoverAsset}
                      onInsert={() => onInsert(buildAssetInsertPayload(asset))}
                      onDelete={() => removeAsset.mutate(asset.id)}
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>
      {manageOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              data-ui
              data-canvas-no-zoom
              className="fixed inset-0 z-[75] flex flex-col bg-[var(--bg)] text-[var(--text)]"
              role="dialog"
              aria-modal="true"
              aria-label="素材管理"
            >
              {/* Header */}
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
                <h2 className="text-sm font-semibold">素材管理</h2>
                <button
                  type="button"
                  onClick={() => {
                    setManageOpen(false);
                    setManageMulti(false);
                    setSelectedIds(new Set());
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  aria-label="关闭素材管理"
                >
                  <IconX size={16} />
                </button>
              </div>

              {/* Body */}
              <div className="flex min-h-0 flex-1">
                {/* Left categories */}
                <aside className="hidden w-52 shrink-0 flex-col gap-1 border-r border-[var(--border)] p-3 sm:flex">
                  <p className="px-2 pb-1 text-xs font-medium text-[var(--dim)]">素材分类</p>
                  {(
                    [
                      { key: "all", label: "全部素材", count: assets.length },
                      { key: "image", label: "图片", count: assets.filter((a) => a.kind === "image").length },
                      { key: "video", label: "视频", count: assets.filter((a) => a.kind === "video").length },
                      { key: "audio", label: "音频", count: assets.filter((a) => a.kind === "audio").length },
                      { key: "text", label: "文本", count: assets.filter((a) => a.kind === "text").length },
                    ] as const
                  ).map((cat) => {
                    const active = kindFilter === cat.key;
                    return (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => setKindFilter(cat.key)}
                        className={`flex items-center justify-between rounded-xl px-3 py-2 text-left text-xs transition-colors ${
                          active
                            ? "bg-[var(--surface-2)] font-medium text-[var(--text)]"
                            : "text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                        }`}
                      >
                        <span>{cat.label}</span>
                        <span className="tabular-nums">{cat.count}</span>
                      </button>
                    );
                  })}
                  {allTags.length ? (
                    <div className="mt-4 space-y-1">
                      <p className="px-2 pb-1 text-xs font-medium text-[var(--dim)]">标签</p>
                      <div className="flex flex-wrap gap-1 px-1">
                        {allTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                            className="rounded-full px-2.5 py-0.5 text-xs"
                            style={{
                              background:
                                tagFilter === tag ? "rgba(var(--accent-rgb),0.16)" : "var(--surface-2)",
                              color: tagFilter === tag ? "var(--accent)" : "var(--dim)",
                            }}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </aside>

                {/* Right main content */}
                <main className="flex min-w-0 flex-1 flex-col p-4">
                  <div className="flex flex-wrap items-center gap-2 pb-4">
                    <span className="text-sm font-medium">
                      {kindFilter === "all" ? "全部素材" : NODE_TYPE_LABEL[kindFilter]}
                      <span className="ml-1.5 text-xs text-[var(--dim)]">({filtered.length})</span>
                    </span>
                    <span className="flex-1" />
                    {manageMulti ? (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-[var(--dim)]">已选 {selectedIds.size}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedIds(
                              selectedIds.size === filtered.length
                                ? new Set()
                                : new Set(filtered.map((a) => a.id)),
                            )
                          }
                          className="rounded-full border border-[var(--border)] px-2.5 py-1 hover:bg-[var(--hover)]"
                        >
                          {selectedIds.size === filtered.length && filtered.length > 0 ? "全不选" : "全选"}
                        </button>
                        <button
                          type="button"
                          disabled={selectedIds.size === 0}
                          onClick={batchInsertSelected}
                          className="rounded-full bg-[var(--accent)] px-3 py-1 font-medium text-[var(--accent-ink)] disabled:opacity-40"
                        >
                          插入画布
                        </button>
                        <button
                          type="button"
                          disabled={selectedIds.size === 0 || removeAsset.isPending}
                          onClick={() => void batchDeleteSelected()}
                          className="rounded-full bg-[var(--danger)] px-3 py-1 font-medium text-white disabled:opacity-40"
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setManageMulti((v) => !v);
                        setSelectedIds(new Set());
                      }}
                      className={`h-8 rounded-full px-3.5 text-xs font-medium transition-colors ${
                        manageMulti
                          ? "bg-[var(--text)] text-[var(--bg)]"
                          : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--hover)]"
                      }`}
                    >
                      {manageMulti ? "完成" : "多选"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode((v) => (v === "grid" ? "list" : "grid"))}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--dim)] hover:text-[var(--text)]"
                      aria-label={viewMode === "grid" ? "切换为列表视图" : "切换为宫格视图"}
                    >
                      {viewMode === "grid" ? <IconList size={15} /> : <IconGrid size={15} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--dim)] hover:text-[var(--text)] disabled:opacity-40"
                      aria-label="上传素材"
                      title="上传素材"
                    >
                      <IconPlus size={15} />
                    </button>
                    <label className="relative w-48">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]">
                        <IconSearch size={14} />
                      </span>
                      <input
                        type="search"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        placeholder="在素材中搜索"
                        aria-label="在素材中搜索"
                        className="h-8 w-full rounded-full border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 text-xs outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
                      />
                    </label>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {filtered.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-[var(--dim)]">
                        <span>暂无内容</span>
                      </div>
                    ) : viewMode === "grid" ? (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                        {filtered.map((asset) => (
                          <AssetGridCard
                            key={asset.id}
                            asset={asset}
                            manageMode={manageMulti}
                            selected={selectedIds.has(asset.id)}
                            onToggleSelect={() => toggleSelect(asset.id)}
                            onPreview={() => onPreviewAsset(asset)}
                            onHover={onHoverAsset}
                            onInsert={() => {
                              onInsert(buildAssetInsertPayload(asset));
                              setManageOpen(false);
                            }}
                            onDelete={() => removeAsset.mutate(asset.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {filtered.map((asset) => (
                          <AssetRow
                            key={asset.id}
                            asset={asset}
                            manageMode={manageMulti}
                            selected={selectedIds.has(asset.id)}
                            onToggleSelect={() => toggleSelect(asset.id)}
                            editing={editingAssetId === asset.id}
                            editTitle={assetEditTitle}
                            onEditTitleChange={setAssetEditTitle}
                            onStartRename={() => {
                              setEditingAssetId(asset.id);
                              setAssetEditTitle(asset.title);
                            }}
                            onCommitRename={() => {
                              const title = assetEditTitle.trim();
                              setEditingAssetId(null);
                              if (title && title !== asset.title) {
                                renameAsset.mutate({ id: asset.id, title });
                              }
                            }}
                            onCancelRename={() => setEditingAssetId(null)}
                            onPreview={() => onPreviewAsset(asset)}
                            onHover={onHoverAsset}
                            onInsert={() => {
                              onInsert(buildAssetInsertPayload(asset));
                              setManageOpen(false);
                            }}
                            onDelete={() => removeAsset.mutate(asset.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </main>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function buildAssetInsertPayload(asset: Asset): InsertAssetPayload {
  return {
    mediaUrl: asset.mediaUrl ?? (isMediaUrl(asset.content) ? asset.content : null),
    mimeType: asset.mimeType,
    posterBlobKey: asset.posterBlobKey,
    posterUrl: asset.posterUrl,
    kind: asset.kind,
    title: asset.title,
    content: asset.content,
    prompt: asset.prompt,
    color: asset.color,
    assetId: asset.id,
    mediaBlobKey: asset.mediaBlobKey,
  };
}

function AssetGridCard({
  asset,
  manageMode,
  selected,
  onToggleSelect,
  onPreview,
  onHover,
  onInsert,
  onDelete,
}: {
  asset: Asset;
  manageMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onPreview: () => void;
  onHover: (asset: Asset | null) => void;
  onInsert: () => void;
  onDelete: () => void;
}) {
  const mediaUrl = asset.mediaUrl ?? (isMediaUrl(asset.content) ? asset.content : null);
  const draggableKind = !manageMode && (asset.kind === "image" || asset.kind === "video" || asset.kind === "audio");
  const hoverable =
    !manageMode && (asset.kind === "image" ? Boolean(mediaUrl) : asset.kind === "video" ? Boolean(asset.posterUrl ?? mediaUrl) : false);

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-xl border bg-[var(--surface-2)] transition-colors ${
        manageMode && selected ? "border-[var(--accent)] ring-1 ring-[var(--accent)]" : "border-[var(--border)]"
      }`}
      draggable={draggableKind}
      onDragStart={(e) => {
        if (!draggableKind) return;
        e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(buildAssetInsertPayload(asset)));
        e.dataTransfer.effectAllowed = "copy";
        onHover(null);
      }}
      onMouseEnter={() => {
        if (hoverable) onHover(asset);
      }}
      onMouseLeave={() => onHover(null)}
      title={draggableKind ? `${asset.title}（可拖到画布）` : asset.title}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={manageMode ? onToggleSelect : onPreview}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (manageMode) onToggleSelect();
            else onPreview();
          }
        }}
        className="relative aspect-square w-full cursor-pointer overflow-hidden bg-[var(--surface-3)]"
      >
        {asset.kind === "image" && mediaUrl ? (
          <img src={mediaUrl} alt={asset.title} className="h-full w-full object-cover" />
        ) : asset.kind === "video" && asset.posterUrl ? (
          <>
            <img src={asset.posterUrl} alt={asset.title} className="h-full w-full object-cover" />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/90">
              <IconPlay size={22} />
            </span>
          </>
        ) : asset.kind === "video" && mediaUrl ? (
          <>
            <video
              src={`${mediaUrl}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full bg-black object-cover"
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/90">
              <IconPlay size={22} />
            </span>
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-[var(--dim)]">
            <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px]">
              {NODE_TYPE_LABEL[asset.kind]}
            </span>
            {asset.content ? (
              <span className="line-clamp-3 text-[11px] leading-4">{asset.content}</span>
            ) : null}
          </div>
        )}
        {manageMode ? (
          <span
            className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
              selected
                ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                : "border-white/70 bg-black/50 text-transparent"
            }`}
            aria-hidden="true"
          >
            <IconCheck size={12} />
          </span>
        ) : (
          <div className="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInsert();
              }}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white hover:bg-black"
              aria-label={`插入资产 ${asset.title} 到画布`}
              title="插入到画布"
            >
              <IconInsert size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-white hover:bg-[var(--danger)]"
              aria-label={`删除资产 ${asset.title}`}
              title="删除"
            >
              <IconTrash size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{asset.title}</span>
        <span className="shrink-0 text-[10px] text-[var(--dim)]">{NODE_TYPE_LABEL[asset.kind]}</span>
      </div>
    </div>
  );
}

function AssetRow({
  asset,
  manageMode,
  selected,
  onToggleSelect,
  editing,
  editTitle,
  onEditTitleChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onPreview,
  onHover,
  onInsert,
  onDelete,
}: {
  asset: Asset;
  manageMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  editing: boolean;
  editTitle: string;
  onEditTitleChange: (title: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onPreview: () => void;
  /** Hover-to-view is the shared preview the canvas list uses —   * App renders it over the canvas (see HoverMediaPreview); this row
   * only reports which asset is hovered. */
  onHover: (asset: Asset | null) => void;
  onInsert: () => void;
  onDelete: () => void;
}) {
  // Media assets carry their real blob (generated results, uploads,
  // nodes saved with their media), so the thumb shows the actual
  // image / video frame just like a canvas row. Older assets saved
  // before media fields existed may still carry a media URL in
  // content — that fallback keeps their thumbs working.
  const pseudoNode: CanvasNode = {
    id: asset.id,
    projectId: "",
    seq: null,
    type: asset.kind,
    title: asset.title,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    content: asset.content,
    prompt: asset.prompt,
    status: "idle",
    hidden: false,
    groupId: null,
    color: asset.color,
    freeResize: false,
    fontSize: null,
    genStatus: "idle",
    genError: null,
    genStartedAt: null,
    genRatio: null,
    genSize: null,
    genDuration: null,
    genKind: null,
    genMode: null,
    mediaBlobKey: asset.mediaBlobKey,
    mediaUrl: asset.mediaUrl ?? (isMediaUrl(asset.content) ? asset.content : null),
    mimeType: asset.mimeType,
    filePath: asset.filePath,
    posterBlobKey: asset.posterBlobKey,
    posterUrl: asset.posterUrl,
    // Assets carry no playback proxy of their own (proxies belong to
    // canvas nodes); the pseudo node only feeds thumbnails/hover.
    proxyBlobKey: null,
    proxyUrl: null,
  };
  const hoverable =
    asset.kind === "image"
      ? Boolean(pseudoNode.mediaUrl)
      : asset.kind === "video"
        ? Boolean(asset.posterUrl ?? pseudoNode.mediaUrl)
        : false;
  // Media assets drag straight onto the canvas: the row carries the
  // insert payload in the drag data, and App's canvas drop handler
  // lands the new node at the drop point.
  const draggableKind =
    asset.kind === "image" || asset.kind === "video" || asset.kind === "audio";
  const insertPayload: InsertAssetPayload = {
    mediaUrl: pseudoNode.mediaUrl,
    mimeType: asset.mimeType,
    posterBlobKey: asset.posterBlobKey,
    posterUrl: asset.posterUrl,
    kind: asset.kind,
    title: asset.title,
    content: asset.content,
    prompt: asset.prompt,
    color: asset.color,
    assetId: asset.id,
    mediaBlobKey: asset.mediaBlobKey,
  };
  const iconBtnClass =
    "hit-40 flex h-8 w-7 shrink-0 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--hover-strong)] hover:text-[var(--text)]";
  return (
    <div
      className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--hover)] ${
        manageMode && selected ? "bg-[var(--hover-strong)]" : ""
      }`}
      onClick={manageMode ? onToggleSelect : undefined}
      draggable={!manageMode && draggableKind && !editing}
      onDragStart={(e) => {
        if (!draggableKind) return;
        e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(insertPayload));
        e.dataTransfer.effectAllowed = "copy";
        onHover(null);
      }}
      title={draggableKind ? "拖到画布上即可生成节点" : undefined}
    >
      <span
        onMouseEnter={() => {
          if (hoverable) onHover(asset);
        }}
        onMouseLeave={() => onHover(null)}
      >
        <NodeThumb node={pseudoNode} />
      </span>
      <span className="min-w-0 flex-1">
        {editing ? (
          <input
            value={editTitle}
            onChange={(e) => onEditTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={onCommitRename}
            autoFocus
            aria-label={`重命名资产 ${asset.title}`}
            className="w-full rounded border border-[var(--accent)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[13px] font-medium outline-none"
          />
        ) : (
          <span
            className="block truncate text-[13px] font-medium leading-5"
            onDoubleClick={onStartRename}
            title={`${asset.title}（双击改名）`}
          >
            {asset.title}
          </span>
        )}
        {/* Second row: the type/tags text takes the line, and the
         * four icon buttons (rename / preview / insert / delete) sit
         * tight together at its right end so the title row above
         * stays fully free for the name. */}
        <span className="flex items-center gap-0.5">
          <span className="min-w-0 flex-1 truncate text-xs leading-4 text-[var(--dim)]">
            {asset.tags.length
              ? asset.tags.join(" · ")
              : isMediaUrl(asset.content)
                ? NODE_TYPE_LABEL[asset.kind]
                : asset.content || NODE_TYPE_LABEL[asset.kind]}
          </span>
          {!editing ? (
            <button
              type="button"
              onClick={onStartRename}
              className={iconBtnClass}
              aria-label={`重命名资产 ${asset.title}`}
              title="重命"
            >
              <IconPencil size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPreview}
            className={iconBtnClass}
            aria-label={`预览资产 ${asset.title}`}
            title="预览"
          >
            <IconEye size={16} />
          </button>
          <button
            type="button"
            onClick={onInsert}
            className="hit-40 flex h-8 w-7 shrink-0 items-center justify-center rounded text-[var(--accent)] hover:bg-[var(--hover-strong)]"
            aria-label={`插入资产 ${asset.title} 到画布`}
            title="插入到画"
          >
            <IconInsert size={15} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="hit-40 flex h-8 w-7 shrink-0 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--hover-strong)] hover:text-[var(--danger)]"
            aria-label={`删除资产 ${asset.title}`}
            title="删除"
          >
            <IconTrash size={15} />
          </button>
        </span>
      </span>
    </div>
  );
}
