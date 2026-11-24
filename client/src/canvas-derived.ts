import type { CSSProperties } from "react";
import type { HoverPreviewData } from "./components/HoverMediaPreview";
import type { PreviewTarget } from "./components/MediaPreviewDialog";
import { NARROW_BREAKPOINT_PX } from "./device";
import type { Viewport, ContextMenuState } from "./hooks/gesture-math";
import { canGroupSelectedNodes, canUngroupSelectedNodes, nodeBounds } from "./canvas-geometry";
import { isMediaUrl } from "./node-utils";
import {
  NODE_TYPE_LABEL,
  type Asset,
  type CanvasEdge,
  type CanvasNode,
  type ConnectingState,
  type ReferenceInfo,
  type SelectionBoxState,
} from "./types";

export function nodePreviewTarget(node: CanvasNode): PreviewTarget {
  return {
    title: node.title,
    type: node.type,
    mediaUrl: node.mediaUrl ?? (isMediaUrl(node.content) ? node.content : null),
    proxyUrl: node.proxyUrl,
    posterUrl: node.posterUrl,
    color: node.color,
    text: node.content || node.prompt || "",
    meta: `${NODE_TYPE_LABEL[node.type]} · ${Math.round(node.width)}×${Math.round(node.height)} · 状态 ${node.status}${node.genSize ? ` · 成品实测 ${node.genSize}` : ""}`,
    filePath: node.filePath,
  };
}

export function assetPreviewTarget(asset: Asset): PreviewTarget {
  return {
    title: asset.title,
    type: asset.kind,
    mediaUrl: asset.mediaUrl ?? (isMediaUrl(asset.content) ? asset.content : null),
    posterUrl: asset.posterUrl,
    color: asset.color,
    text: asset.content || asset.prompt || "",
    meta: `资产 · ${NODE_TYPE_LABEL[asset.kind]}${asset.tags.length ? ` · ${asset.tags.join(" · ")}` : ""}`,
    filePath: asset.filePath,
  };
}

export function buildInputsByNodeId(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): Map<string, CanvasNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const map = new Map<string, CanvasNode[]>();
  for (const e of edges) {
    const src = byId.get(e.fromNodeId);
    if (!src) continue;
    const list = map.get(e.toNodeId) ?? [];
    if (src.type === "group") {
      for (const m of nodes) {
        if (m.groupId === src.id && m.type !== "group" && !list.some((x) => x.id === m.id)) {
          list.push(m);
        }
      }
    } else if (!list.some((x) => x.id === src.id)) {
      list.push(src);
    }
    map.set(e.toNodeId, list);
  }
  return map;
}

export function collectNodeReferences(
  targetNode: CanvasNode | null,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): ReferenceInfo[] {
  if (!targetNode) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: ReferenceInfo[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.toNodeId !== targetNode.id) continue;
    const src = byId.get(e.fromNodeId);
    if (!src) continue;
    if (src.type === "group") {
      for (const m of nodes) {
        if (m.groupId === src.id && m.type !== "group" && !seen.has(m.id)) {
          seen.add(m.id);
          out.push({ node: m, edgeId: e.id });
        }
      }
    } else if (!seen.has(src.id)) {
      seen.add(src.id);
      out.push({ node: src, edgeId: e.id });
    }
  }
  return out;
}

export function computeAnchoredPanelStyle(opts: {
  node: CanvasNode | null;
  canvasSize: { width: number; height: number };
  viewport: Viewport;
  kbInset: number;
  maxWidth: number;
  maxHeightCap: string;
  narrowMaxHeight: string;
  fixedOffset?: { left: number; top: number };
}): CSSProperties | undefined {
  const { node, canvasSize, viewport, kbInset, maxWidth, maxHeightCap, narrowMaxHeight, fixedOffset } = opts;
  if (!node || canvasSize.width === 0) return undefined;
  const cw = canvasSize.width;
  const ch = canvasSize.height;
  const ox = fixedOffset?.left ?? 0;
  const oy = fixedOffset?.top ?? 0;
  if (cw < NARROW_BREAKPOINT_PX) {
    return {
      ...(fixedOffset ? { position: "fixed" as const } : {}),
      left: ox + 8,
      width: cw - 16,
      bottom: `calc(${8 + kbInset}px + env(safe-area-inset-bottom, 0px))`,
      maxHeight: narrowMaxHeight,
    };
  }
  const w = Math.min(maxWidth, cw * 0.94);
  const cx = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const left = ox + Math.max(8, Math.min(cx - w / 2, cw - w - 8));
  const nodeBottom = viewport.y + (node.y + node.height) * viewport.zoom;
  const roomBelow = ch - (nodeBottom + 10) - 8;
  return {
    ...(fixedOffset ? { position: "fixed" as const } : {}),
    left,
    width: w,
    top: oy + nodeBottom + 10,
    maxHeight: `min(${maxHeightCap}, ${Math.max(200, roomBelow)}px)`,
  };
}

export function computeCanvasBackgroundStyle(
  backgroundMode: string,
  viewport: Viewport,
): CSSProperties {
  if (backgroundMode === "blank") return { backgroundImage: "none" };
  const gridSize = 48 * viewport.zoom;
  const dotSize = viewport.zoom < 0.12 ? 0.8 : 1.15;
  const backgroundPosition = `${viewport.x % gridSize}px ${viewport.y % gridSize}px`;
  if (backgroundMode === "lines") {
    return {
      backgroundImage:
        "linear-gradient(var(--dot) 1px, transparent 1px), linear-gradient(90deg, var(--dot) 1px, transparent 1px)",
      backgroundSize: `${gridSize}px ${gridSize}px`,
      backgroundPosition,
    };
  }
  return {
    backgroundImage: `radial-gradient(circle, var(--dot) ${dotSize}px, transparent ${dotSize + 0.2}px)`,
    backgroundSize: `${gridSize}px ${gridSize}px`,
    backgroundPosition,
  };
}

export function computeSelectionBoxRect(selectionBox: SelectionBoxState | null) {
  if (!selectionBox) return null;
  return {
    x: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
    y: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
    w: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
    h: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
  };
}

export function computeHoverPreviewData(opts: {
  canvasWidth: number;
  hoveredAsset: Asset | null;
  hoveredId: string | null;
  nodeById: Map<string, CanvasNode>;
}): HoverPreviewData | null {
  const { canvasWidth, hoveredAsset, hoveredId, nodeById } = opts;
  if (canvasWidth === 0) return null;
  if (hoveredAsset) {
    if (hoveredAsset.kind === "image") {
      const src = hoveredAsset.mediaUrl ?? (isMediaUrl(hoveredAsset.content) ? hoveredAsset.content : null);
      return src ? { title: hoveredAsset.title, kind: "image", src, poster: null } : null;
    }
    if (hoveredAsset.kind === "video") {
      const poster = hoveredAsset.posterUrl ?? null;
      const src = hoveredAsset.mediaUrl ?? (isMediaUrl(hoveredAsset.content) ? hoveredAsset.content : null);
      return poster || src ? { title: hoveredAsset.title, kind: "video", src, poster } : null;
    }
    return null;
  }
  const n = hoveredId ? nodeById.get(hoveredId) : null;
  if (!n) return null;
  if (n.type === "image") {
    const src = n.mediaUrl ?? (isMediaUrl(n.content) ? n.content : null);
    if (!src) return null;
    const measured = n.genSize?.match(/^(\d+)x(\d+)$/);
    return {
      title: n.title,
      kind: "image",
      src,
      poster: null,
      natW: measured ? Number(measured[1]) : n.width,
      natH: measured ? Number(measured[2]) : n.height,
    };
  }
  if (n.type === "video") {
    const poster = n.posterUrl;
    const src = n.mediaUrl ?? (isMediaUrl(n.content) ? n.content : null);
    if (!poster && !src) return null;
    const measured = n.genSize?.match(/^(\d+)x(\d+)$/);
    return {
      title: n.title,
      kind: "video",
      src,
      poster,
      natW: measured ? Number(measured[1]) : n.width,
      natH: measured ? Number(measured[2]) : n.height,
    };
  }
  return null;
}

export function computeAppViewState(args: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedIds: Set<string>;
  nodeDragging: boolean;
  suppressedEditorId: string | null;
  canvasSize: { width: number; height: number };
  viewport: Viewport;
  kbInset: number;
  composerNodeId: string | null;
  composerRect: DOMRect | undefined;
  connecting: ConnectingState | null;
  connectTargetId: string | null;
  contextMenu: ContextMenuState | null;
  backgroundMode: Parameters<typeof computeCanvasBackgroundStyle>[0];
  selectionBox: SelectionBoxState | null;
  hoveredAsset: Asset | null;
  hoveredId: string | null;
}) {
  const {
    nodes,
    edges,
    selectedIds,
    nodeDragging,
    suppressedEditorId,
    canvasSize,
    viewport,
    kbInset,
    composerNodeId,
    composerRect,
    connecting,
    connectTargetId,
    contextMenu,
    backgroundMode,
    selectionBox,
    hoveredAsset,
    hoveredId,
  } = args;
  const visibleNodes = nodes.filter((n) => !n.hidden);
  const renderNodes = [...visibleNodes].sort(
    (a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1),
  );
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const inputsByNodeId = buildInputsByNodeId(nodes, edges);
  const renderEdges = edges.filter((e) => {
    const from = nodeById.get(e.fromNodeId);
    const to = nodeById.get(e.toNodeId);
    return Boolean(from && to && !from.hidden && !to.hidden);
  });
  const selectedNode =
    selectedIds.size === 1 ? (nodes.find((n) => selectedIds.has(n.id)) ?? null) : null;
  const showDetailEditor =
    selectedNode !== null && !nodeDragging && suppressedEditorId !== selectedNode.id;
  const detailEditorStyle = computeAnchoredPanelStyle({
    node: selectedNode,
    canvasSize,
    viewport,
    kbInset,
    maxWidth: 620,
    maxHeightCap: "560px, 72vh",
    narrowMaxHeight: "min(62dvh, 560px)",
  });
  const selectedReferences = collectNodeReferences(selectedNode, nodes, edges);
  const composerNode = composerNodeId
    ? (nodes.find((n) => n.id === composerNodeId) ?? null)
    : null;
  const composerReferences = collectNodeReferences(composerNode, nodes, edges);
  const composerStyle = composerRect
    ? computeAnchoredPanelStyle({
        node: composerNode,
        canvasSize,
        viewport,
        kbInset,
        maxWidth: 512,
        maxHeightCap: "560px, 80vh",
        narrowMaxHeight: "min(70dvh, 640px)",
        fixedOffset: { left: composerRect.left, top: composerRect.top },
      })
    : undefined;
  const connectingOrigin = connecting ? nodeById.get(connecting.nodeId) : undefined;
  const connectTargetNode = connectTargetId ? nodeById.get(connectTargetId) : undefined;
  const menuCanGroup =
    contextMenu?.type === "node" ? canGroupSelectedNodes(selectedIds, nodes) : false;
  const menuCanUngroup =
    contextMenu?.type === "node" ? canUngroupSelectedNodes(selectedIds, nodes) : false;
  const menuTargetNode =
    contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) : undefined;
  const menuCanExtractFrames = Boolean(
    menuTargetNode &&
      menuTargetNode.type === "video" &&
      (menuTargetNode.mediaUrl || menuTargetNode.mediaBlobKey || menuTargetNode.filePath),
  );
  const canvasBackgroundStyle = computeCanvasBackgroundStyle(backgroundMode, viewport);
  const boxRect = computeSelectionBoxRect(selectionBox);
  const multiSelectedNodes =
    selectedIds.size >= 2
      ? nodes.filter((n) => selectedIds.has(n.id) && !n.hidden)
      : [];
  const multiBounds =
    multiSelectedNodes.length >= 2 ? nodeBounds(multiSelectedNodes) : null;
  const multiCanGroup = canGroupSelectedNodes(selectedIds, nodes);
  const multiCanUngroup = canUngroupSelectedNodes(selectedIds, nodes);
  const multiSelectedVideos = multiSelectedNodes
    .filter(
      (n) =>
        n.type === "video" && (n.mediaUrl || n.mediaBlobKey || n.filePath),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const multiCanMergeVideos = multiSelectedVideos.length >= 2;
  const multiCanExportVideos = multiSelectedVideos.some((n) => Boolean(n.mediaUrl));
  const selectionPadWorld = 14 / viewport.zoom;
  const hoverData = computeHoverPreviewData({
    canvasWidth: canvasSize.width,
    hoveredAsset,
    hoveredId,
    nodeById,
  });
  return {
    visibleNodes,
    renderNodes,
    nodeById,
    inputsByNodeId,
    renderEdges,
    selectedNode,
    showDetailEditor,
    detailEditorStyle,
    selectedReferences,
    composerNode,
    composerReferences,
    composerStyle,
    connectingOrigin,
    connectTargetNode,
    menuCanGroup,
    menuCanUngroup,
    menuTargetNode,
    menuCanExtractFrames,
    canvasBackgroundStyle,
    boxRect,
    multiSelectedNodes,
    multiBounds,
    multiCanGroup,
    multiCanUngroup,
    multiSelectedVideos,
    multiCanMergeVideos,
    multiCanExportVideos,
    selectionPadWorld,
    hoverData,
  };
}
