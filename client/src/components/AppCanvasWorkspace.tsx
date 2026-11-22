import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import logoUrl from "../assets/logo.png";
import type { computeAppViewState } from "../canvas-derived";
import type { Viewport } from "../hooks/gesture-math";
import { IconPlus } from "../icons";
import { ASSET_DRAG_MIME, type Asset, type CanvasNode, type InsertAssetPayload } from "../types";
import { BottomToolbarSection } from "./BottomToolbarSection";
import { CanvasControlsOverlay } from "./CanvasControlsOverlay";
import { CanvasStage } from "./CanvasStage";
import type { CanvasTool } from "./CanvasToolbar";
import { DetailEditor } from "./DetailEditor";
import { HoverMediaPreview } from "./HoverMediaPreview";
import { SidePanel } from "./SidePanel";

export type AppViewState = ReturnType<typeof computeAppViewState>;

type StageProps = ComponentProps<typeof CanvasStage>;
type ControlsProps = ComponentProps<typeof CanvasControlsOverlay>;
type DetailProps = ComponentProps<typeof DetailEditor>;
type ToolbarProps = ComponentProps<typeof BottomToolbarSection>;

export type AppCanvasWorkspaceProps = {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  panelWidth: number;
  setPanelWidth: (w: number) => void;
  projectId: string | null;
  nodes: CanvasNode[];
  selectedIds: Set<string>;
  selectedEdgeId: string | null;
  hoveredId: string | null;
  flashId: string | null;
  connectTargetId: string | null;
  tapConnect: ControlsProps["tapConnect"];
  connecting: StageProps["connecting"];
  mouseWorld: StageProps["mouseWorld"];
  nodeDragging: boolean;
  keyboardUp: boolean;
  directGenId: string | null;
  genBusyId: string | null;
  runFeedback: DetailProps["runFeedback"];
  showMediaInfo: boolean;
  panelFlash: boolean;
  viewport: Viewport;
  canvasSize: { width: number; height: number };
  canvasRef: RefObject<HTMLDivElement | null>;
  detailEditorRef: RefObject<HTMLDivElement | null>;
  spaceDown: boolean;
  canvasTool: CanvasTool;
  multiSelectMode: boolean;
  setMultiSelectMode: Dispatch<SetStateAction<boolean>>;
  projectsPending: boolean;
  projectPending: boolean;
  loadedProjectId: string | null;
  view: AppViewState;
  toolbarHandlers: StageProps["toolbarHandlers"];
  onFocusNode: (nodeId: string) => void;
  onPreviewNode: (node: CanvasNode) => void;
  onPreviewAsset: (asset: Asset) => void;
  onHoverNode: (id: string | null) => void;
  onHoverAsset: (asset: Asset | null) => void;
  onInsertAsset: (payload: InsertAssetPayload, worldPos?: { x: number; y: number }) => void;
  onUpdateNode: StageProps["updateNode"];
  onCanvasPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onCanvasContextMenu: React.MouseEventHandler<HTMLDivElement>;
  onCanvasDoubleClick: React.MouseEventHandler<HTMLDivElement>;
  screenToWorld: (cx: number, cy: number) => { x: number; y: number };
  showToast: (msg: string) => void;
  onOpenCreateDialog: () => void;
  updateSelectedEdgeId: StageProps["updateSelectedEdgeId"];
  updateSelectedIds: StageProps["updateSelectedIds"];
  setCreateMenu: StageProps["setCreateMenu"];
  setContextMenu: StageProps["setContextMenu"];
  handleLiveResize: StageProps["handleLiveResize"];
  scheduleSave: StageProps["scheduleSave"];
  runGeneration: DetailProps["runGeneration"];
  stopGeneration: StageProps["stopGeneration"];
  runTool: DetailProps["runTool"];
  openComposer: StageProps["openComposer"];
  groupSelection: StageProps["groupSelection"];
  ungroupSelection: StageProps["ungroupSelection"];
  onMergeVideos: StageProps["onMergeVideos"];
  onExportVideos: StageProps["onExportVideos"];
  bottomToolbar: Omit<ToolbarProps, "keyboardUp" | "canvasTool" | "multiSelectMode" | "setMultiSelectMode" | "hasSelection" | "showMediaInfo">;
  zoomTo: ControlsProps["zoomTo"];
  fitView: ControlsProps["fitView"];
  applyViewport: ControlsProps["applyViewport"];
  openTapConnectCreateMenu: ControlsProps["openTapConnectCreateMenu"];
  clearTapConnect: ControlsProps["clearTapConnect"];
  deleteNodes: DetailProps["deleteNodes"];
  deleteEdge: DetailProps["deleteEdge"];
  addConnection: DetailProps["addConnection"];
};

export function AppCanvasWorkspace(p: AppCanvasWorkspaceProps) {
  const { view } = p;
  return (
    <div className="relative flex min-h-0 flex-1">
      {p.panelOpen ? (
        <div className="fixed inset-0 z-50 flex md:static md:z-auto">
          <div className="panel-in flex max-w-[88vw]">
            <SidePanel
              projectId={p.projectId ?? ""}
              nodes={p.nodes}
              selectedNodeIds={p.selectedIds}
              onFocusNode={p.onFocusNode}
              onPreviewNode={p.onPreviewNode}
              onPreviewAsset={p.onPreviewAsset}
              onHoverNode={p.onHoverNode}
              onHoverAsset={p.onHoverAsset}
              onInsertAsset={p.onInsertAsset}
              onRenameNode={(nodeId, title) => p.onUpdateNode(nodeId, { title })}
              width={p.panelWidth}
              onWidthChange={p.setPanelWidth}
            />
          </div>
          <button
            type="button"
            aria-label="关闭面板"
            className="flex-1 bg-black/50 md:hidden"
            onClick={() => p.setPanelOpen(false)}
          />
        </div>
      ) : null}

      <div
        ref={p.canvasRef}
        data-canvas-root
        className="relative min-w-0 flex-1 touch-none overscroll-none overflow-hidden bg-[var(--board)]"
        style={{
          ...view.canvasBackgroundStyle,
          cursor: p.spaceDown || p.canvasTool === "pan" ? "grab" : undefined,
        }}
        onPointerDown={p.onCanvasPointerDown}
        onContextMenu={p.onCanvasContextMenu}
        onDoubleClick={p.onCanvasDoubleClick}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(ASSET_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(ASSET_DRAG_MIME);
          if (!raw) return;
          e.preventDefault();
          try {
            const payload = JSON.parse(raw) as InsertAssetPayload;
            p.onInsertAsset(payload, p.screenToWorld(e.clientX, e.clientY));
          } catch {
            p.showToast("插入资产失败，请稍后重试");
          }
        }}
        role="application"
        aria-label="画布区域"
      >
        {!p.projectId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <img src={logoUrl} alt="" className="h-20 w-20 rounded-3xl opacity-90" />
            <p className="text-sm text-[var(--dim)]">
              {p.projectsPending
                ? "加载中"
                : "还没有项目。新建一个项目，开始在画布上连线与编组"}
            </p>
            <button
              type="button"
              onClick={p.onOpenCreateDialog}
              className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-ink)]"
            >
              <IconPlus size={15} /> 新建项目
            </button>
          </div>
        ) : p.projectPending && p.loadedProjectId !== p.projectId ? (
          <p className="flex h-full items-center justify-center text-sm text-[var(--dim)]">
            加载项目中…
          </p>
        ) : (
          <>
            <CanvasStage
              viewport={p.viewport}
              renderEdges={view.renderEdges}
              renderNodes={view.renderNodes}
              nodeById={view.nodeById}
              inputsByNodeId={view.inputsByNodeId}
              selectedIds={p.selectedIds}
              selectedEdgeId={p.selectedEdgeId}
              hoveredId={p.hoveredId}
              flashId={p.flashId}
              connectTargetId={p.connectTargetId}
              tapConnectNodeId={p.tapConnect?.nodeId ?? null}
              connecting={p.connecting}
              connectingOrigin={view.connectingOrigin}
              mouseWorld={p.mouseWorld}
              connectTargetNode={view.connectTargetNode}
              boxRect={view.boxRect}
              multiBounds={view.multiBounds}
              selectionPadWorld={view.selectionPadWorld}
              selectedNode={view.selectedNode}
              nodeDragging={p.nodeDragging}
              keyboardUp={p.keyboardUp}
              directGenId={p.directGenId}
              runFeedback={p.runFeedback}
              showMediaInfo={p.showMediaInfo}
              hasAnyNodes={p.nodes.length > 0}
              toolbarHandlers={p.toolbarHandlers}
              multiCanGroup={view.multiCanGroup}
              multiCanUngroup={view.multiCanUngroup}
              multiCanMergeVideos={view.multiCanMergeVideos}
              multiCanExportVideos={view.multiCanExportVideos}
              updateSelectedEdgeId={p.updateSelectedEdgeId}
              updateSelectedIds={p.updateSelectedIds}
              setCreateMenu={p.setCreateMenu}
              setContextMenu={p.setContextMenu}
              handleLiveResize={p.handleLiveResize}
              scheduleSave={p.scheduleSave}
              openNodePreview={p.onPreviewNode}
              updateNode={p.onUpdateNode}
              runGeneration={p.runGeneration}
              stopGeneration={p.stopGeneration}
              runTool={p.runTool}
              openComposer={p.openComposer}
              groupSelection={p.groupSelection}
              ungroupSelection={p.ungroupSelection}
              onMergeVideos={p.onMergeVideos}
              onExportVideos={p.onExportVideos}
            />
            <HoverMediaPreview
              data={view.hoverData}
              canvasWidth={p.canvasSize.width}
              canvasHeight={p.canvasSize.height}
            />
            <BottomToolbarSection
              {...p.bottomToolbar}
              keyboardUp={p.keyboardUp}
              canvasTool={p.canvasTool}
              multiSelectMode={p.multiSelectMode}
              setMultiSelectMode={p.setMultiSelectMode}
              hasSelection={p.selectedIds.size > 0 || Boolean(p.selectedEdgeId)}
              showMediaInfo={p.showMediaInfo}
            />
            <CanvasControlsOverlay
              keyboardUp={p.keyboardUp}
              viewport={p.viewport}
              zoomTo={p.zoomTo}
              fitView={p.fitView}
              visibleNodes={view.visibleNodes}
              canvasSize={p.canvasSize}
              applyViewport={p.applyViewport}
              tapConnect={p.tapConnect}
              openTapConnectCreateMenu={p.openTapConnectCreateMenu}
              clearTapConnect={p.clearTapConnect}
              multiSelectMode={p.multiSelectMode}
              selectedCount={p.selectedIds.size}
              onDeleteSelected={() => p.deleteNodes(new Set(p.selectedIds))}
              exitMultiSelect={() => p.setMultiSelectMode(false)}
            />
          </>
        )}

        {view.showDetailEditor && view.selectedNode ? (
          <DetailEditor
            detailEditorRef={p.detailEditorRef}
            detailEditorStyle={view.detailEditorStyle}
            panelFlash={p.panelFlash}
            selectedNode={view.selectedNode}
            selectedReferences={view.selectedReferences}
            nodes={p.nodes}
            genBusyId={p.genBusyId}
            runFeedback={p.runFeedback}
            updateNode={p.onUpdateNode}
            deleteNodes={p.deleteNodes}
            deleteEdge={p.deleteEdge}
            addConnection={p.addConnection}
            runGeneration={p.runGeneration}
            runTool={p.runTool}
          />
        ) : null}
      </div>
    </div>
  );
}
