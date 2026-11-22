import type { NodeRunFeedback } from "./run-feedback";
import { activeEdgePathD } from "../canvas-geometry";
import type { Viewport } from "../hooks/gesture-math";
import type { CanvasEdge, CanvasNode, ConnectingState } from "../types";
import { EdgePath } from "./EdgePath";
import { HoverToolbar, type ToolbarHandlers } from "./HoverToolbar";
import { NodeCard } from "./NodeCard";
import { SelectionToolbar } from "./SelectionToolbar";
import type { ContextMenuState } from "../hooks/use-canvas-gestures";

const NO_INPUTS: CanvasNode[] = [];

export function CanvasStage(props: {
  viewport: Viewport;
  renderEdges: CanvasEdge[];
  renderNodes: CanvasNode[];
  nodeById: Map<string, CanvasNode>;
  inputsByNodeId: Map<string, CanvasNode[]>;
  selectedIds: Set<string>;
  selectedEdgeId: string | null;
  hoveredId: string | null;
  flashId: string | null;
  connectTargetId: string | null;
  tapConnectNodeId: string | null;
  connecting: ConnectingState | null;
  connectingOrigin: CanvasNode | undefined;
  mouseWorld: { x: number; y: number };
  connectTargetNode: CanvasNode | undefined;
  boxRect: { x: number; y: number; w: number; h: number } | null;
  multiBounds: { left: number; top: number; right: number; bottom: number } | null;
  selectionPadWorld: number;
  selectedNode: CanvasNode | null;
  nodeDragging: boolean;
  keyboardUp: boolean;
  directGenId: string | null;
  runFeedback: Record<string, NodeRunFeedback | undefined>;
  showMediaInfo: boolean;
  hasAnyNodes: boolean;
  toolbarHandlers: ToolbarHandlers;
  multiCanGroup: boolean;
  multiCanUngroup: boolean;
  multiCanMergeVideos: boolean;
  multiCanExportVideos: boolean;
  updateSelectedEdgeId: (id: string | null) => void;
  updateSelectedIds: (next: Set<string>) => void;
  setCreateMenu: (v: null) => void;
  setContextMenu: (v: ContextMenuState | null) => void;
  handleLiveResize: (id: string, width: number, height: number) => void;
  scheduleSave: () => void;
  openNodePreview: (node: CanvasNode) => void;
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  runGeneration: (node: CanvasNode) => void;
  stopGeneration: (node: CanvasNode) => void;
  runTool: (node: CanvasNode, options?: Record<string, unknown>) => void;
  openComposer: (node: CanvasNode) => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  onMergeVideos: () => void;
  onExportVideos: () => void;
}) {
  const {
    viewport,
    renderEdges,
    renderNodes,
    nodeById,
    inputsByNodeId,
    selectedIds,
    selectedEdgeId,
    hoveredId,
    flashId,
    connectTargetId,
    tapConnectNodeId,
    connecting,
    connectingOrigin,
    mouseWorld,
    connectTargetNode,
    boxRect,
    multiBounds,
    selectionPadWorld,
    selectedNode,
    nodeDragging,
    keyboardUp,
    directGenId,
    runFeedback,
    showMediaInfo,
    hasAnyNodes,
    toolbarHandlers,
    multiCanGroup,
    multiCanUngroup,
    multiCanMergeVideos,
    multiCanExportVideos,
    updateSelectedEdgeId,
    updateSelectedIds,
    setCreateMenu,
    setContextMenu,
    handleLiveResize,
    scheduleSave,
    openNodePreview,
    updateNode,
    runGeneration,
    stopGeneration,
    runTool,
    openComposer,
    groupSelection,
    ungroupSelection,
    onMergeVideos,
    onExportVideos,
  } = props;

  return (
    <>
      <div
        className="absolute left-0 top-0 h-full w-full"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="absolute left-0 top-0"
          width={10000}
          height={10000}
          style={{ overflow: "visible", pointerEvents: "none", zIndex: 0 }}
          aria-hidden="true"
        >
          {renderEdges.map((edge) => {
            const from = nodeById.get(edge.fromNodeId);
            const to = nodeById.get(edge.toNodeId);
            if (!from || !to) return null;
            const active =
              selectedEdgeId === edge.id ||
              selectedIds.has(edge.fromNodeId) ||
              selectedIds.has(edge.toNodeId);
            return (
              <EdgePath
                key={edge.id}
                edge={edge}
                from={from}
                to={to}
                active={active}
                onSelect={() => {
                  updateSelectedEdgeId(edge.id);
                  updateSelectedIds(new Set());
                }}
                onContextMenu={(clientX, clientY) => {
                  updateSelectedEdgeId(edge.id);
                  updateSelectedIds(new Set());
                  setCreateMenu(null);
                  setContextMenu({
                    type: "connection",
                    edgeId: edge.id,
                    x: clientX,
                    y: clientY,
                  });
                }}
              />
            );
          })}
          {connecting && connectingOrigin ? (
            <path
              d={activeEdgePathD(
                connectingOrigin,
                connecting.handleType,
                mouseWorld,
                connectTargetNode,
              )}
              fill="none"
              style={{
                stroke: "var(--accent)",
                strokeWidth: 2,
                strokeDasharray: "5,5",
                pointerEvents: "none",
              }}
            />
          ) : null}
          {boxRect ? (
            <rect
              x={boxRect.x}
              y={boxRect.y}
              width={boxRect.w}
              height={boxRect.h}
              style={{
                fill: "rgba(var(--accent-rgb),0.08)",
                stroke: "var(--accent)",
                strokeOpacity: 0.55,
                strokeWidth: 1 / viewport.zoom,
                strokeDasharray: `${6 / viewport.zoom} ${4 / viewport.zoom}`,
              }}
            />
          ) : null}
        </svg>
        {renderNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            inputs={inputsByNodeId.get(node.id) ?? NO_INPUTS}
            selected={selectedIds.has(node.id)}
            hovered={hoveredId === node.id}
            flashing={flashId === node.id}
            connectTarget={connectTargetId === node.id || tapConnectNodeId === node.id}
            showHandles={Boolean(connecting)}
            generating={directGenId === node.id}
            feedback={runFeedback[node.id]}
            showMediaInfo={showMediaInfo}
            onLiveResize={handleLiveResize}
            onResizeCommit={scheduleSave}
            onPreview={openNodePreview}
            onPatchNode={updateNode}
            onGenerateNode={runGeneration}
            onStopNode={stopGeneration}
            onRunToolNode={runTool}
            onOpenComposer={openComposer}
          />
        ))}
        {multiBounds ? (
          <div
            className="pointer-events-none absolute z-[5] rounded-2xl"
            style={{
              left: multiBounds.left - selectionPadWorld,
              top: multiBounds.top - selectionPadWorld,
              width: multiBounds.right - multiBounds.left + selectionPadWorld * 2,
              height: multiBounds.bottom - multiBounds.top + selectionPadWorld * 2,
              border: `${1.5 / viewport.zoom}px dashed rgba(var(--accent-rgb),0.55)`,
              background: "rgba(var(--accent-rgb),0.05)",
            }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      {selectedNode && !nodeDragging && !keyboardUp ? (
        <HoverToolbar node={selectedNode} viewport={viewport} handlers={toolbarHandlers} />
      ) : null}
      {multiBounds && !keyboardUp ? (
        <SelectionToolbar
          bounds={multiBounds}
          viewport={viewport}
          canGroup={multiCanGroup}
          canUngroup={multiCanUngroup}
          canMergeVideos={multiCanMergeVideos}
          canExportVideos={multiCanExportVideos}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onMergeVideos={onMergeVideos}
          onExportVideos={onExportVideos}
        />
      ) : null}
      {!hasAnyNodes ? (
        <p className="pointer-events-none absolute inset-x-0 top-16 px-4 text-center text-sm text-[var(--dim)]">
          画布是空的——在画布上右键新建节点，或用底部工具条添加，也可以从左侧面板插入资产 / 提示词。
        </p>
      ) : null}
    </>
  );
}
