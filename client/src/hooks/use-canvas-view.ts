import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { nodeBounds } from "../canvas-geometry";
import { downloadMediaFile } from "../components/download-media";
import type { PreviewTarget } from "../components/MediaPreviewDialog";
import type { GenerationRecord } from "../components/QueueDrawer";
import { NARROW_BREAKPOINT_PX } from "../device";
import { NODE_TYPE_LABEL, type CanvasEdge, type CanvasNode } from "../types";
import { computeFitViewViewport, computeZoomToCenter, type Viewport } from "./gesture-math";
import type { ContextMenuState } from "./use-canvas-gestures";

export function useCanvasView(opts: {
  canvasRef: RefObject<HTMLDivElement | null>;
  projectIdRef: MutableRefObject<string | null>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  viewportRef: MutableRefObject<Viewport>;
  selectedIdsRef: MutableRefObject<Set<string>>;
  suppressedEditorRef: MutableRefObject<string | null>;
  queryClient: QueryClient;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setEditorSuppressed: (id: string | null) => void;
  updateSelectedIds: (next: Set<string>) => void;
  updateSelectedEdgeId: (next: string | null) => void;
  applyViewport: (vp: Viewport) => void;
  applyGraph: (nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => void;
  setFlashId: Dispatch<SetStateAction<string | null>>;
  setPanelOpen: (v: boolean) => void;
  setPreviewTarget: (t: PreviewTarget | null) => void;
  setClearConfirmOpen: (v: boolean) => void;
  setContextMenu: (v: ContextMenuState | null) => void;
  showToast: (msg: string) => void;
  flushSave: () => Promise<void>;
  refreshGraphFromServer: () => Promise<void>;
}) {
  const {
    canvasRef,
    projectIdRef,
    nodesRef,
    viewportRef,
    selectedIdsRef,
    suppressedEditorRef,
    queryClient,
    setNodes,
    setEditorSuppressed,
    updateSelectedIds,
    updateSelectedEdgeId,
    applyViewport,
    applyGraph,
    setFlashId,
    setPanelOpen,
    setPreviewTarget,
    setClearConfirmOpen,
    setContextMenu,
    showToast,
    flushSave,
    refreshGraphFromServer,
  } = opts;

  const handleLiveResize = useCallback(
    (id: string, width: number, height: number) => {
      const next = nodesRef.current.map((n) => (n.id === id ? { ...n, width, height } : n));
      nodesRef.current = next;
      setNodes(next);
    },
    [nodesRef, setNodes],
  );

  const focusNode = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id);
      const el = canvasRef.current;
      if (!node || !el) return;
      if (suppressedEditorRef.current === id) setEditorSuppressed(null);
      updateSelectedIds(new Set([id]));
      const rect = el.getBoundingClientRect();
      const zoom = viewportRef.current.zoom;
      applyViewport({
        x: rect.width / 2 - (node.x + node.width / 2) * zoom,
        y: rect.height / 2 - (node.y + node.height / 2) * zoom,
        zoom,
      });
      setFlashId(id);
      window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 3500);
      if (window.innerWidth < NARROW_BREAKPOINT_PX) setPanelOpen(false);
    },
    [applyViewport, canvasRef, nodesRef, setEditorSuppressed, setFlashId, setPanelOpen, suppressedEditorRef, updateSelectedIds, viewportRef],
  );

  const locateQueueNode = useCallback(
    (pid: string, nodeId: string) => {
      if (pid !== projectIdRef.current) {
        showToast("该节点在其它项目里，先切换到那个项目再定位");
        return;
      }
      if (!nodesRef.current.some((n) => n.id === nodeId)) {
        showToast("节点已不存在，无法定位");
        return;
      }
      focusNode(nodeId);
    },
    [focusNode, nodesRef, projectIdRef, showToast],
  );

  const openRecordPreview = useCallback(
    (record: GenerationRecord) => {
      setPreviewTarget({
        title: record.title,
        type: record.nodeType,
        mediaUrl: record.mediaUrl,
        posterUrl: null,
        color: null,
        text: record.prompt,
        meta: `生成记录 · ${NODE_TYPE_LABEL[record.nodeType]}${record.genSize ? ` · 成品实测 ${record.genSize}` : ""}`,
        filePath: record.filePath,
      });
    },
    [setPreviewTarget],
  );

  const focusSelection = useCallback(() => {
    const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    const el = canvasRef.current;
    if (!selected.length || !el) return;
    const bounds = nodeBounds(selected);
    const rect = el.getBoundingClientRect();
    const zoom = viewportRef.current.zoom;
    applyViewport({
      x: rect.width / 2 - ((bounds.left + bounds.right) / 2) * zoom,
      y: rect.height / 2 - ((bounds.top + bounds.bottom) / 2) * zoom,
      zoom,
    });
  }, [applyViewport, canvasRef, nodesRef, selectedIdsRef, viewportRef]);

  const clearCanvas = useCallback(() => {
    applyGraph([], []);
    updateSelectedIds(new Set());
    updateSelectedEdgeId(null);
    setClearConfirmOpen(false);
    showToast("画布已清空（点工具条的撤销可恢复）");
  }, [applyGraph, setClearConfirmOpen, showToast, updateSelectedEdgeId, updateSelectedIds]);

  const zoomTo = useCallback(
    (nextZoom: number) => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      applyViewport(computeZoomToCenter(viewportRef.current, rect.width, rect.height, nextZoom));
    },
    [applyViewport, canvasRef, viewportRef],
  );

  const fitView = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const visible = nodesRef.current.filter((n) => !n.hidden);
    applyViewport(computeFitViewViewport(visible, rect.width, rect.height));
  }, [applyViewport, canvasRef, nodesRef]);

  const runExtractVideoFrame = useCallback(
    (nodeId: string, mode: "first" | "last") => {
      setContextMenu(null);
      showToast(mode === "first" ? "正在提取首帧…" : "正在提取尾帧…");
      void (async () => {
        try {
          await flushSave();
          const res = await api.extractVideoFrame({ nodeId, mode });
          if (res.status === "done") {
            showToast(mode === "first" ? "首帧已提取并上板" : "尾帧已提取并上板");
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
            void refreshGraphFromServer();
          } else {
            showToast(`取帧失败：${res.error ?? "未知原因"}`);
          }
        } catch {
          showToast("取帧请求失败，请稍后重试");
        }
      })();
    },
    [flushSave, queryClient, refreshGraphFromServer, setContextMenu, showToast],
  );

  const mergeSelectedVideos = useCallback(
    (videos: CanvasNode[]) => {
      const pid = projectIdRef.current;
      if (!pid || videos.length < 2) return;
      showToast(`正在合并 ${videos.length} 段视频…`);
      void (async () => {
        try {
          await flushSave();
          const res = await api.mergeVideos({ projectId: pid, nodeIds: videos.map((n) => n.id) });
          if (res.status === "done") {
            showToast("视频合并完成，新视频已上板");
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
            void refreshGraphFromServer();
          } else {
            showToast(`合并失败：${res.error ?? "未知原因"}`);
          }
        } catch {
          showToast("合并视频请求失败，请稍后重试");
        }
      })();
    },
    [flushSave, projectIdRef, queryClient, refreshGraphFromServer, showToast],
  );

  const exportSelectedVideos = useCallback(
    (videos: CanvasNode[]) => {
      const targets = videos.filter((v) => Boolean(v.mediaUrl));
      if (targets.length === 0) {
        showToast("所选视频暂无可导出的文件");
        return;
      }
      void (async () => {
        let ok = 0;
        for (const v of targets) {
          if (!v.mediaUrl) continue;
          const r = await downloadMediaFile(v.mediaUrl, v.title || "video");
          if (r === "downloaded" || r === "shared") ok += 1;
        }
        showToast(ok > 0 ? `已导出 ${ok} 个视频` : "导出失败，请稍后重试");
      })();
    },
    [showToast],
  );

  return {
    handleLiveResize,
    focusNode,
    locateQueueNode,
    openRecordPreview,
    focusSelection,
    clearCanvas,
    zoomTo,
    fitView,
    runExtractVideoFrame,
    mergeSelectedVideos,
    exportSelectedVideos,
  };
}
