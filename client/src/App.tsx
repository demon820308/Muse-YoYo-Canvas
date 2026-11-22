// YoYo画布 — the upstream canvas body + both right-click menu sets, ported
// per source spec (infinite-canvas.tsx, canvas-connections.tsx,
// canvas-create-menus.tsx, canvas-context-menu.tsx, canvas-zoom-controls.tsx,
// canvas-mini-map.tsx, pages/canvas/project.tsx wiring), hosted next to the
// v1 side panel. Viewport model {x, y, zoom}; wheel zoom uses the upstream
// anchor formula; nodes and edges persist server-side via saveGraph.

import {
useCallback,
useEffect,
useRef,
useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectActions } from "./hooks/use-project-actions";
import { useProjectSync } from "./hooks/use-project-sync";
import { useWorkspaceUi } from "./hooks/use-workspace-ui";
import { useCanvasView } from "./hooks/use-canvas-view";
import { useHistory } from "./hooks/use-history";
import { usePackageIo } from "./hooks/use-package-io";
import {
  useCanvasGestures,
  type ContextMenuState,
  type CreateMenuState,
} from "./hooks/use-canvas-gestures";
import { useGeneration } from "./hooks/use-generation";
import { useNodeOps } from "./hooks/use-node-ops";
import { CanvasMenusAndQueue } from "./components/CanvasMenusAndQueue";
import {
type CanvasTool,
} from "./components/CanvasToolbar";
import {
  toEdgeInput,
  toNodeInput,
} from "./app-helpers";
import { useToolbarActions } from "./hooks/use-toolbar-actions";
import { AppDialogs } from "./components/AppDialogs";
import { AppCanvasWorkspace } from "./components/AppCanvasWorkspace";
import { TopProjectBar } from "./components/TopProjectBar";
import { type PreviewTarget } from "./components/MediaPreviewDialog";
import {
type Asset,
type CanvasEdge,
type CanvasNode,
} from "./types";
import {
  assetPreviewTarget,
  computeAppViewState,
  nodePreviewTarget,
} from "./canvas-derived";

type Viewport = { x: number; y: number; zoom: number };

export function App() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Asset row hovered in the side panel — feeds the SAME shared
  // hover preview as canvas rows (see hoverData below).
  const [hoveredAsset, setHoveredAsset] = useState<Asset | null>(null);
  // Config node whose 组装提示词 composer dialog is open.
  const [composerNodeId, setComposerNodeId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const openNodePreview = useCallback((node: CanvasNode) => setPreviewTarget(nodePreviewTarget(node)), []);
  const openAssetPreview = useCallback((asset: Asset) => setPreviewTarget(assetPreviewTarget(asset)), []);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const {
    panelOpen, setPanelOpen, panelWidth, setPanelWidth,
    queueOpen, setQueueOpen, projectMenuOpen, setProjectMenuOpen, projectMenuRef,
    projectSwitchOpen, setProjectSwitchOpen, projectSwitchRef,
    infoNode, setInfoNode, editorDialog, setEditorDialog,
    panelFlash, setPanelFlash, uploading, setUploading,
    dialog, setDialog, dialogName, setDialogName, dialogDir, setDialogDir,
    pickingDir, setPickingDir, toast, showToast,
    kbInset, keyboardUp, recomputePanelTextFocus,
    backgroundMode, setBackgroundMode, themeMode, setThemeMode, showMediaInfo, setShowMediaInfo,
    clearConfirmOpen, setClearConfirmOpen, openDialog, saveAsAsset,
  } = useWorkspaceUi();
  // Base tool for background drags; Ctrl / Space temporarily inverts it.
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("pan");
  // Multi-select mode (toolbar toggle): taps toggle node selection,
  // dragging a selected node moves the whole selection, background
  // taps keep the selection. Desktop Ctrl-click / box select are
  // independent and keep working with the mode off.
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const nodesRef = useRef<CanvasNode[]>([]);
  const edgesRef = useRef<CanvasEdge[]>([]);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const selectedEdgeIdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarUploadRef = useRef<HTMLInputElement | null>(null);
  const toolbarUploadTargetRef = useRef<string | null>(null);
  const detailEditorRef = useRef<HTMLDivElement | null>(null);

  projectIdRef.current = projectId;


  // (hooks/use-history.ts: autosave scheduling, undo/redo, apply*)
  const {
    canUndo,
    canRedo,
    loadedProjectRef,
    knownNodeIdsRef,
    intentionalEmptyRef,
    adoptSeqs,
    scheduleSave,
    flushSave,
    recordHistory,
    applyNodes,
    applyEdges,
    applyGraph,
    applyViewport,
    undoGraph,
    redoGraph,
    cancelPendingSave,
    resetHistory,
  } = useHistory({
    projectIdRef,
    nodesRef,
    edgesRef,
    viewportRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    setNodes,
    setEdges,
    setViewport,
    setSelectedIds,
    setSelectedEdgeId,
    showToast,
    toInput: toNodeInput,
    toEdgeInput,
  });

  const { projectsQ, projectQ } = useProjectSync({
    projectId,
    setProjectId,
    canvasRef,
    loadedProjectRef,
    intentionalEmptyRef,
    knownNodeIdsRef,
    nodesRef,
    edgesRef,
    viewportRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    setNodes,
    setEdges,
    setViewport,
    setSelectedIds,
    setSelectedEdgeId,
    setHoveredId,
    setCanvasSize,
  });

  const updateSelectedIds = useCallback((next: Set<string>) => {
    selectedIdsRef.current = next;
    setSelectedIds(next);
  }, []);

  const updateSelectedEdgeId = useCallback((next: string | null) => {
    selectedEdgeIdRef.current = next;
    setSelectedEdgeId(next);
  }, []);

  // (hooks/use-node-ops.ts: node creation / mutation handlers)
  const {
    buildNode,
    persistAddedNode,
    createNodeAt,
    addNodeOfType,
    insertAsset,
    updateNode,
    deleteNodes,
    deleteEdge,
    duplicateNode,
    groupSelection,
    ungroupSelection,
    createGeneratorNode,
  } = useNodeOps({
    projectIdRef,
    nodesRef,
    edgesRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    canvasRef,
    viewportRef,
    setNodes,
    setFlashId,
    setContextMenu,
    applyNodes,
    applyEdges,
    applyGraph,
    adoptSeqs,
    flushSave,
    showToast,
    toInput: toNodeInput,
    updateSelectedIds,
    updateSelectedEdgeId,
  });

  // (hooks/use-generation.ts: run dispatch, run feedback, queue)
  const {
    genBusyId,
    setGenBusyId,
    directGenId,
    setDirectGenId,
    runFeedback,
    beginRunFeedback,
    settleRunFeedback,
    inFlightRunsRef,
    refreshGraphFromServer,
    runGeneration,
    runTool,
    stopGeneration,
    queueQ,
    recordsQ,
    stopRequestMut,
    processQueueMut,
    handleUploadFiles,
  } = useGeneration({
    projectId,
    projectIdRef,
    loadedProjectRef,
    knownNodeIdsRef,
    nodesRef,
    edgesRef,
    nodes,
    queueOpen,
    canvasRef,
    viewportRef,
    setNodes,
    setEdges,
    setFlashId,
    setUploading,
    flushSave,
    showToast,
    updateSelectedIds,
  });

  // (hooks/use-canvas-gestures.ts: pointer / pinch / connect layer)
  const {
    nodeDragging,
    setNodeDragging,
    suppressedEditorId,
    suppressedEditorRef,
    setEditorSuppressed,
    connecting,
    setConnecting,
    pendingConnect,
    setPendingConnect,
    connectTargetId,
    mouseWorld,
    selectionBox,
    spaceDown,
    tapConnect,
    setTapConnect,
    connectingRef,
    pendingConnectRef,
    tapConnectRef,
    pinchRef,
    activePointersRef,
    pinchStaleRef,
    longPressRef,
    screenToWorld,
    addConnection,
    createConnectedNode,
    cancelPendingConnect,
    clearTapConnect,
    openTapConnectCreateMenu,
    onCanvasPointerDown,
    onCanvasContextMenu,
    onCanvasDoubleClick,
  } = useCanvasGestures({
    projectIdRef,
    nodesRef,
    edgesRef,
    viewportRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    canvasRef,
    canvasTool,
    multiSelectMode,
    setNodes,
    setContextMenu,
    setCreateMenu,
    applyViewport,
    applyEdges,
    applyGraph,
    recordHistory,
    scheduleSave,
    showToast,
    updateSelectedIds,
    updateSelectedEdgeId,
    buildNode,
    persistAddedNode,
    deleteNodes,
    deleteEdge,
    undoGraph,
    redoGraph,
  });

  const {
    switchProject,
    createProject,
    renameProject,
    moveProjectDir,
    deleteProject,
  } = useProjectActions({
    projectId,
    projectIdRef,
    loadedProjectRef,
    intentionalEmptyRef,
    knownNodeIdsRef,
    nodesRef,
    edgesRef,
    connectingRef,
    pendingConnectRef,
    tapConnectRef,
    pinchRef,
    activePointersRef,
    pinchStaleRef,
    longPressRef,
    queryClient,
    cancelPendingSave,
    resetHistory,
    setProjectId,
    setNodes,
    setEdges,
    updateSelectedIds,
    updateSelectedEdgeId,
    setEditorSuppressed,
    setNodeDragging,
    setContextMenu,
    setCreateMenu,
    setConnecting,
    setPendingConnect,
    setTapConnect,
    setDialog,
    showToast,
    refreshGraphFromServer,
  });
  // (hooks/use-package-io.ts: export download, import + report)
  const {
    exporting,
    importing,
    importReport,
    setImportReport,
    importInputRef,
    handleExportPackage,
    handleImportPackageFile,
  } = usePackageIo({ projectId, showToast, switchProject });

  const {
    toolbarHandlers,
    handleToolbarUpload,
    handleCropConfirm,
    handleSplitConfirm,
    handleUpscaleConfirm,
    handleAngleConfirm,
    handleMaskConfirm,
  } = useToolbarActions({
    projectIdRef,
    nodesRef,
    edgesRef,
    inFlightRunsRef,
    toolbarUploadRef,
    toolbarUploadTargetRef,
    detailEditorRef,
    queryClient,
    setNodes,
    setInfoNode,
    setEditorDialog,
    setPanelFlash,
    setGenBusyId,
    setDirectGenId,
    showToast,
    updateSelectedIds,
    deleteNodes,
    ungroupSelection,
    updateNode,
    buildNode,
    applyGraph,
    createGeneratorNode,
    flushSave,
    refreshGraphFromServer,
    openNodePreview,
    runTool,
    runGeneration,
    saveAsAssetMutate: (node) => saveAsAsset.mutate(node),
    beginRunFeedback,
    settleRunFeedback,
  });

  const {
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
  } = useCanvasView({
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
  });

  const projects = projectsQ.data?.projects ?? [];
  const currentProject = projects.find((p) => p.id === projectId) ?? null;
  const composerRect =
    composerNodeId && canvasSize.width > 0 ? canvasRef.current?.getBoundingClientRect() : undefined;
  const view = computeAppViewState({
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
  });
  const {
    showDetailEditor, composerNode, composerReferences, composerStyle,
    menuCanGroup, menuCanUngroup, menuCanExtractFrames, multiSelectedVideos,
  } = view;
  const anyPanelOpen = showDetailEditor || composerNode !== null;
  useEffect(() => {
    recomputePanelTextFocus();
  }, [anyPanelOpen, recomputePanelTextFocus]);


  return (
    <div className="app-root relative flex flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* --------------------- top floating cluster (upstream
          canvas-top-bar pattern, per the user's call: NO bar of its
          own — the canvas fills the whole screen and the controls
          float over it in two transparent clusters, left: panel
          toggle, logo, project menu button, project switcher; right: the queue icon. Fully transparent, no capsule
          background: nodes sliding under the cluster overlap it,
          exactly like the upstream original. The header itself is
          pointer-events-none so the canvas stays draggable through
          the gaps; each interactive child re-enables its own events.
          Every project action lives in the 项目菜单 dropdown. The
          left cluster rides with the side panel on desktop widths:
          panel open, it starts just right of the panel's edge (the
          panel's tabs own the top-left row); panel closed, it returns
          to the screen's left edge. On narrow widths the panel is an
          overlay above this header, so the cluster stays put. The
          right queue button never moves.) */}
      <TopProjectBar
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
        panelWidth={panelWidth}
        projectMenuRef={projectMenuRef}
        projectMenuOpen={projectMenuOpen}
        setProjectMenuOpen={setProjectMenuOpen}
        openDialog={openDialog}
        importing={importing}
        importInputRef={importInputRef}
        currentProject={currentProject ?? undefined}
        exporting={exporting}
        handleExportPackage={handleExportPackage}
        handleImportPackageFile={handleImportPackageFile}
        projectSwitchRef={projectSwitchRef}
        projectSwitchOpen={projectSwitchOpen}
        setProjectSwitchOpen={setProjectSwitchOpen}
        projects={projects}
        projectId={projectId}
        switchProject={switchProject}
        openQueue={() => setQueueOpen(true)}
        queueCount={queueQ.data?.requests.length ?? 0}
        importReport={importReport}
        dismissImportReport={() => setImportReport(null)}
      />

      {/* ------------------------------------------------ main row:
          full-bleed — the canvas fills the whole screen under the
          floating top cluster; the side panel rises to full screen
          height flush with the left edge, its tab row at the very
          top in the same row as the floating cluster (which shifts
          to the panel's right edge on desktop while it is open) */}
      <AppCanvasWorkspace
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
        panelWidth={panelWidth}
        setPanelWidth={setPanelWidth}
        projectId={projectId}
        nodes={nodes}
        selectedIds={selectedIds}
        selectedEdgeId={selectedEdgeId}
        hoveredId={hoveredId}
        flashId={flashId}
        connectTargetId={connectTargetId}
        tapConnect={tapConnect}
        connecting={connecting}
        mouseWorld={mouseWorld}
        nodeDragging={nodeDragging}
        keyboardUp={keyboardUp}
        directGenId={directGenId}
        genBusyId={genBusyId}
        runFeedback={runFeedback}
        showMediaInfo={showMediaInfo}
        panelFlash={panelFlash}
        viewport={viewport}
        canvasSize={canvasSize}
        canvasRef={canvasRef}
        detailEditorRef={detailEditorRef}
        spaceDown={spaceDown}
        canvasTool={canvasTool}
        multiSelectMode={multiSelectMode}
        setMultiSelectMode={setMultiSelectMode}
        projectsPending={projectsQ.isPending}
        projectPending={projectQ.isPending}
        loadedProjectId={loadedProjectRef.current}
        view={view}
        toolbarHandlers={toolbarHandlers}
        onFocusNode={focusNode}
        onPreviewNode={openNodePreview}
        onPreviewAsset={openAssetPreview}
        onHoverNode={(id) => { setHoveredId(id); if (id) setHoveredAsset(null); }}
        onHoverAsset={(asset) => { setHoveredAsset(asset); if (asset) setHoveredId(null); }}
        onInsertAsset={insertAsset}
        onUpdateNode={updateNode}
        onCanvasPointerDown={onCanvasPointerDown}
        onCanvasContextMenu={onCanvasContextMenu}
        onCanvasDoubleClick={onCanvasDoubleClick}
        screenToWorld={screenToWorld}
        showToast={showToast}
        onOpenCreateDialog={() => openDialog({ mode: "create" })}
        updateSelectedEdgeId={updateSelectedEdgeId}
        updateSelectedIds={updateSelectedIds}
        setCreateMenu={setCreateMenu}
        setContextMenu={setContextMenu}
        handleLiveResize={handleLiveResize}
        scheduleSave={scheduleSave}
        runGeneration={runGeneration}
        stopGeneration={(n) => void stopGeneration(n)}
        runTool={runTool}
        openComposer={(n) => setComposerNodeId(n.id)}
        groupSelection={groupSelection}
        ungroupSelection={ungroupSelection}
        onMergeVideos={() => mergeSelectedVideos(multiSelectedVideos)}
        onExportVideos={() => exportSelectedVideos(multiSelectedVideos)}
        bottomToolbar={{
          canUndo,
          canRedo,
          disabled: !projectId || uploading,
          themeMode,
          backgroundMode,
          setCanvasTool,
          undoGraph,
          redoGraph,
          focusSelection,
          addNodeOfType,
          uploadInputRef,
          toolbarUploadRef,
          onDeleteSelected: () => {
            if (selectedIds.size > 0) deleteNodes(new Set(selectedIds));
            else if (selectedEdgeId) deleteEdge(selectedEdgeId);
          },
          onClear: () => setClearConfirmOpen(true),
          setThemeMode,
          setBackgroundMode,
          setShowMediaInfo,
          handleUploadFiles,
          handleToolbarUpload,
        }}
        zoomTo={zoomTo}
        fitView={fitView}
        applyViewport={applyViewport}
        openTapConnectCreateMenu={openTapConnectCreateMenu}
        clearTapConnect={clearTapConnect}
        deleteNodes={deleteNodes}
        deleteEdge={deleteEdge}
        addConnection={addConnection}
      />

      <CanvasMenusAndQueue
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        createMenu={createMenu}
        setCreateMenu={setCreateMenu}
        pendingConnect={pendingConnect}
        cancelPendingConnect={cancelPendingConnect}
        createConnectedNode={createConnectedNode}
        menuCanGroup={menuCanGroup}
        menuCanUngroup={menuCanUngroup}
        menuCanExtractFrames={menuCanExtractFrames}
        runExtractVideoFrame={runExtractVideoFrame}
        duplicateNode={duplicateNode}
        groupSelection={groupSelection}
        ungroupSelection={ungroupSelection}
        deleteNodes={deleteNodes}
        deleteEdge={deleteEdge}
        createNodeAt={createNodeAt}
        setTapConnect={setTapConnect}
        tapConnectRef={tapConnectRef}
        queueOpen={queueOpen}
        closeQueue={() => setQueueOpen(false)}
        projectId={projectId}
        requests={queueQ.data?.requests ?? []}
        queueLoading={queueQ.isPending}
        records={recordsQ.data?.records ?? []}
        recordsLoading={recordsQ.isPending}
        onProcessQueue={() => processQueueMut.mutate()}
        processingQueue={processQueueMut.isPending}
        onLocateNode={locateQueueNode}
        onStopRequest={(pid, nodeId) => stopRequestMut.mutate({ projectId: pid, nodeId })}
        stoppingNodeId={stopRequestMut.isPending ? (stopRequestMut.variables?.nodeId ?? null) : null}
        onPreviewRecord={openRecordPreview}
        showToast={showToast}
      />

      <AppDialogs
        clearConfirmOpen={clearConfirmOpen}
        setClearConfirmOpen={setClearConfirmOpen}
        clearCanvas={clearCanvas}
        dialog={dialog}
        setDialog={setDialog}
        dialogName={dialogName}
        setDialogName={setDialogName}
        dialogDir={dialogDir}
        setDialogDir={setDialogDir}
        pickingDir={pickingDir}
        setPickingDir={setPickingDir}
        createProject={createProject}
        renameProject={renameProject}
        moveProjectDir={moveProjectDir}
        deleteProject={deleteProject}
        showToast={showToast}
        previewTarget={previewTarget}
        setPreviewTarget={setPreviewTarget}
        composerNode={composerNode ?? null}
        composerReferences={composerReferences}
        composerStyle={composerStyle}
        runFeedback={runFeedback}
        updateNode={updateNode}
        closeComposer={() => setComposerNodeId(null)}
        runGeneration={(n) => void runGeneration(n)}
        infoNode={infoNode}
        setInfoNode={setInfoNode}
        editorDialog={editorDialog}
        setEditorDialog={setEditorDialog}
        onCropConfirm={(n, rect) => void handleCropConfirm(n, rect)}
        onSplitConfirm={(n, params) => void handleSplitConfirm(n, params)}
        onUpscaleConfirm={(n, params) => void handleUpscaleConfirm(n, params)}
        onAngleConfirm={(n, params) => void handleAngleConfirm(n, params)}
        onMaskConfirm={(n, payload) => void handleMaskConfirm(n, payload)}
        toast={toast}
      />
    </div>
  );
}
