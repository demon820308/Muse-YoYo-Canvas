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
import { api } from "./api";
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
import { NODE_DEFAULTS, newId, useNodeOps } from "./hooks/use-node-ops";
import { applyGroupSelection, getGroupWrapRect } from "./canvas-geometry";
import { IconQueue } from "./icons";
import {
  AgentDrawer,
  type AgentOperation,
  type ApplyAgentOpsResult,
} from "./components/AgentDrawer";
import { AgentOrbIcon } from "./components/AgentOrbIcon";
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
import { BridgeSetupModal, type BridgeSummary } from "./components/BridgeSetupModal";
import { AgySetupModal } from "./components/AgySetupModal";
import { GeminiWebSetupModal } from "./components/GeminiWebSetupModal";
import { useAgyStatus } from "./hooks/use-agy";
import { useGeminiWebStatus } from "./hooks/use-gemini-web";
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
  const [bridgeModalOpen, setBridgeModalOpen] = useState(false);
  const [agyModalOpen, setAgyModalOpen] = useState(false);
  const { status: agyStatus } = useAgyStatus();
  const [geminiWebModalOpen, setGeminiWebModalOpen] = useState(false);
  const { status: geminiWebStatus } = useGeminiWebStatus();
  const [bridgeSummary, setBridgeSummary] = useState<BridgeSummary | null>(null);
  const [bridgeSummaryTimeout, setBridgeSummaryTimeout] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);

  const refreshBridgeSummary = useCallback(async () => {
    try {
      const res = await fetch("/bridge-admin/api/summary", {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        setBridgeSummaryTimeout(true);
        return;
      }
      const json = (await res.json()) as BridgeSummary;
      setBridgeSummary(json);
      setBridgeSummaryTimeout(false);
    } catch {
      setBridgeSummaryTimeout(true);
    }
  }, []);

  useEffect(() => {
    void refreshBridgeSummary();
  }, [refreshBridgeSummary]);

  useEffect(() => {
    const intervalMs = bridgeSummary?.state === "connecting" ? 2_000 : 15_000;
    const timer = window.setInterval(() => {
      void refreshBridgeSummary();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [bridgeSummary?.state, refreshBridgeSummary]);

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
    onOpenMaskEditor: (node) => setEditorDialog({ kind: "mask", node }),
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

  const highlightAgentNode = useCallback(
    (id: string) => {
      const node = nodesRef.current.find((n) => n.id === id);
      const el = canvasRef.current;
      if (!node || !el) return;
      setEditorSuppressed(id);
      const rect = el.getBoundingClientRect();
      const zoom = viewportRef.current.zoom;
      const drawerOffset = agentOpen ? Math.min(200, rect.width * 0.22) : 0;
      applyViewport({
        x: (rect.width - drawerOffset) / 2 - (node.x + node.width / 2) * zoom,
        y: rect.height / 2 - (node.y + node.height / 2) * zoom,
        zoom,
      });
      setFlashId(id);
      window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 3500);
    },
    [agentOpen, applyViewport, canvasRef, nodesRef, setEditorSuppressed, setFlashId, viewportRef],
  );

  const triggerGenerateNodes = useCallback(
    async (nodeIds: string[]) => {
      if (nodeIds[0]) {
        highlightAgentNode(nodeIds[0]);
      }
      for (const id of nodeIds) {
        const node = nodesRef.current.find((n) => n.id === id);
        if (node) {
          await runGeneration(node);
        }
      }
    },
    [highlightAgentNode, nodesRef, runGeneration],
  );

  const applyAgentOperations = useCallback(
    async (
      ops: AgentOperation[],
      options: { autoTriggerGenerate: boolean },
    ): Promise<ApplyAgentOpsResult> => {
      const pid = projectIdRef.current;
      if (!pid) return { summary: "无当前项目", deferredGenerateNodeIds: [] };

      let nextNodes = [...nodesRef.current];
      let nextEdges = [...edgesRef.current];
      const tempToReal = new Map<string, string>();
      let created = 0;
      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      let connected = 0;
      let disconnected = 0;
      let grouped = 0;
      let savedPrompts = 0;
      const genIds: string[] = [];

      const resolveNodeId = (raw?: string): string | undefined => {
        if (!raw) return undefined;
        return tempToReal.get(raw) ?? raw;
      };

      const vp = viewportRef.current;
      const baseX = (-vp.x + 220) / Math.max(0.2, vp.zoom);
      const baseY = (-vp.y + 180) / Math.max(0.2, vp.zoom);

      for (const op of ops) {
        if (op.op === "insert_asset" && op.assetId) {
          const nearId = resolveNodeId(op.nearNodeId);
          const nearNode = nearId
            ? nextNodes.find((n) => n.id === nearId)
            : undefined;
          const x =
            typeof op.x === "number"
              ? op.x
              : nearNode
                ? nearNode.x + nearNode.width + 80
                : baseX + (created + inserted) * 290;
          const y =
            typeof op.y === "number"
              ? op.y
              : nearNode
                ? nearNode.y + ((created + inserted) % 2) * 30
                : baseY;
          try {
            const res = await api.insertAssetToCanvas({
              projectId: pid,
              assetId: op.assetId,
              x,
              y,
            });
            const insertedNode =
              op.title && op.title.trim()
                ? { ...res.node, title: op.title.trim() }
                : res.node;
            nextNodes.push(insertedNode);
            if (op.tempId) tempToReal.set(op.tempId, insertedNode.id);
            inserted += 1;
          } catch (err) {
            const cachedAssets = queryClient.getQueryData<{ assets: Asset[] }>([
              "assets",
              pid,
            ]);
            const asset = cachedAssets?.assets.find((a) => a.id === op.assetId);
            if (asset && asset.kind === "text") {
              const defaults = NODE_DEFAULTS.text;
              const built = buildNode({
                type: "text",
                title: op.title ?? asset.title ?? defaults.title,
                width: defaults.w,
                height: defaults.h,
                content: asset.content ?? "",
                prompt: asset.content ?? "",
                status: "idle",
                hidden: false,
                groupId: null,
                color: null,
                x,
                y,
              });
              if (built) {
                nextNodes.push(built);
                if (op.tempId) tempToReal.set(op.tempId, built.id);
                inserted += 1;
              }
            } else {
              showToast(
                `插入资产失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else if (op.op === "create_node") {
          const nearId = resolveNodeId(op.nearNodeId);
          const nearNode = nearId
            ? nextNodes.find((n) => n.id === nearId)
            : undefined;
          const x =
            typeof op.x === "number"
              ? op.x
              : nearNode
                ? nearNode.x + nearNode.width + 80
                : baseX + (created + inserted) * 290;
          const y =
            typeof op.y === "number"
              ? op.y
              : nearNode
                ? nearNode.y + ((created + inserted) % 2) * 30
                : baseY;
          const nodeType = op.type ?? "text";
          const defaults = NODE_DEFAULTS[nodeType];
          const built = buildNode({
            type: nodeType,
            title: op.title ?? defaults.title,
            width: defaults.w,
            height: defaults.h,
            content: op.content ?? "",
            prompt: op.prompt ?? "",
            status: "idle",
            hidden: false,
            groupId: null,
            color: null,
            ...(op.genRatio !== undefined ? { genRatio: op.genRatio } : {}),
            ...(op.genDuration !== undefined ? { genDuration: op.genDuration } : {}),
            ...(op.genMode !== undefined ? { genMode: op.genMode } : {}),
            x,
            y,
          });
          if (built) {
            nextNodes.push(built);
            if (op.tempId) tempToReal.set(op.tempId, built.id);
            created += 1;
          }
        } else if (op.op === "update_node") {
          const targetId = resolveNodeId(op.nodeId);
          if (!targetId) continue;
          let hit = false;
          nextNodes = nextNodes.map((n) => {
            if (n.id !== targetId) return n;
            hit = true;
            return {
              ...n,
              ...(op.title !== undefined ? { title: op.title } : {}),
              ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
              ...(op.content !== undefined ? { content: op.content } : {}),
              ...(op.genRatio !== undefined ? { genRatio: op.genRatio } : {}),
              ...(op.genDuration !== undefined ? { genDuration: op.genDuration } : {}),
            };
          });
          if (hit) updated += 1;
        } else if (op.op === "delete_node") {
          const targetId = resolveNodeId(op.nodeId);
          if (!targetId) continue;
          const before = nextNodes.length;
          nextNodes = nextNodes.filter((n) => n.id !== targetId);
          nextEdges = nextEdges.filter(
            (e) => e.fromNodeId !== targetId && e.toNodeId !== targetId,
          );
          if (nextNodes.length < before) deleted += 1;
        } else if (op.op === "connect") {
          const fromNodeId = resolveNodeId(op.source);
          const toNodeId = resolveNodeId(op.target);
          if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
          const exists = nextEdges.some(
            (e) => e.fromNodeId === fromNodeId && e.toNodeId === toNodeId,
          );
          if (!exists) {
            nextEdges.push({
              id: newId(),
              projectId: pid,
              fromNodeId,
              toNodeId,
            });
            connected += 1;
          }
        } else if (op.op === "disconnect") {
          const fromNodeId = resolveNodeId(op.source);
          const toNodeId = resolveNodeId(op.target);
          if (!fromNodeId || !toNodeId) continue;
          const before = nextEdges.length;
          nextEdges = nextEdges.filter(
            (e) => !(e.fromNodeId === fromNodeId && e.toNodeId === toNodeId),
          );
          if (nextEdges.length < before) disconnected += 1;
        } else if (op.op === "trigger_generate") {
          const targetId = resolveNodeId(op.nodeId);
          if (targetId && !genIds.includes(targetId)) {
            genIds.push(targetId);
          }
        } else if (op.op === "group_nodes" && Array.isArray(op.nodeIds)) {
          const resolvedIds = new Set(
            op.nodeIds.map((id) => resolveNodeId(id)).filter((id): id is string => Boolean(id)),
          );
          const members = nextNodes.filter((n) => resolvedIds.has(n.id) && n.type !== "group");
          if (members.length >= 2) {
            const rect = getGroupWrapRect(members);
            const groupNode = buildNode({
              type: "group",
              title: op.title || "Agent 分组",
              width: rect.width,
              height: rect.height,
              content: "",
              prompt: "",
              status: "idle",
              hidden: false,
              groupId: null,
              color: null,
              x: rect.x,
              y: rect.y,
            });
            if (groupNode) {
              const res = applyGroupSelection(resolvedIds, nextNodes, groupNode);
              if (res) {
                nextNodes = res.nodes;
                nextEdges = nextEdges.filter(
                  (e) => !res.removedIds.has(e.fromNodeId) && !res.removedIds.has(e.toNodeId),
                );
                grouped += 1;
              }
            }
          }
        } else if (op.op === "save_prompt" && op.title && op.content) {
          try {
            await api.addPrompt({
              title: op.title.slice(0, 120),
              content: op.content,
            });
            void queryClient.invalidateQueries({ queryKey: ["prompts"] });
            savedPrompts += 1;
          } catch {
            // ignore prompt save error
          }
        }
      }

      if (created || inserted || updated || deleted || connected || disconnected || grouped) {
        applyGraph(nextNodes, nextEdges);
        await flushSave();
      }
      const focusTargetId =
        genIds[0] ?? nextNodes[nextNodes.length - 1]?.id ?? null;
      if ((created || inserted || updated) && focusTargetId) {
        requestAnimationFrame(() => highlightAgentNode(focusTargetId));
      }

      let triggered = 0;
      const deferred: string[] = [];
      if (genIds.length > 0) {
        if (options.autoTriggerGenerate) {
          await triggerGenerateNodes(genIds);
          triggered = genIds.length;
        } else {
          deferred.push(...genIds);
        }
      }

      const parts: string[] = [];
      if (inserted) parts.push(`插入 ${inserted} 个资产`);
      if (created) parts.push(`新建 ${created} 个节点`);
      if (updated) parts.push(`更新 ${updated} 个节点`);
      if (deleted) parts.push(`删除 ${deleted} 个节点`);
      if (connected) parts.push(`连线 ${connected} 条`);
      if (disconnected) parts.push(`断开 ${disconnected} 条`);
      if (grouped) parts.push(`分组 ${grouped} 个`);
      if (savedPrompts) parts.push(`存入提示词库 ${savedPrompts} 条`);
      if (triggered) parts.push(`已触发 ${triggered} 个生成`);
      return {
        summary: parts.join("、") || "无画布变更",
        deferredGenerateNodeIds: deferred,
      };
    },
    [
      applyGraph,
      buildNode,
      edgesRef,
      flushSave,
      highlightAgentNode,
      nodesRef,
      projectIdRef,
      queryClient,
      showToast,
      triggerGenerateNodes,
      viewportRef,
    ],
  );
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
        bridgeSummary={bridgeSummary}
        bridgeSummaryTimeout={bridgeSummaryTimeout}
        onOpenBridgeModal={() => setBridgeModalOpen(true)}
        agyStatus={agyStatus}
        onOpenAgyModal={() => setAgyModalOpen(true)}
        geminiWebStatus={geminiWebStatus}
        onOpenGeminiWebModal={() => setGeminiWebModalOpen(true)}
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

      {!queueOpen && !agentOpen && !keyboardUp ? (
        <div
          data-ui
          data-canvas-no-zoom
          onPointerDown={(e) => e.stopPropagation()}
          className="safe-bottom-offset fixed bottom-3 right-3 z-40 flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => {
              setQueueOpen(false);
              setAgentOpen(true);
            }}
            className="capsule-chrome capsule-btn group flex h-10 items-center gap-2 rounded-full pl-2 pr-3.5 text-xs font-medium text-[var(--text)]"
            aria-label="打开画布 Agent"
            title="打开画布 Agent（支持 Muse / OpenAI / Anthropic）"
          >
            <AgentOrbIcon
              size={24}
              thinking={agentBusy}
              className="transition-transform duration-150 group-hover:scale-105"
            />
            <span>Agent</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setAgentOpen(false);
              setQueueOpen(true);
            }}
            className="capsule-chrome capsule-btn group flex h-10 items-center gap-2 rounded-full px-3.5 text-xs font-medium text-[var(--text)]"
            aria-label="打开生成队列"
          >
            {(queueQ.data?.requests.length ?? 0) > 0 ? (
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)] transition-transform duration-150 group-hover:scale-125" aria-hidden="true" />
            ) : (
              <IconQueue size={15} className="text-[var(--dim)] transition-colors duration-150 group-hover:text-[var(--text)]" />
            )}
            <span>生成队列</span>
            {(queueQ.data?.requests.length ?? 0) > 0 ? (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--text)] px-1.5 text-[11px] font-semibold leading-none text-[var(--bg)] tabular-nums transition-transform duration-150 group-hover:scale-105">
                {queueQ.data?.requests.length}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

      <AgentDrawer
        open={agentOpen}
        width={panelWidth}
        onClose={() => setAgentOpen(false)}
        projectId={projectId}
        nodes={nodes}
        edges={edges}
        selectedIds={selectedIds}
        onApplyOperations={applyAgentOperations}
        onTriggerGenerateNodes={triggerGenerateNodes}
        onLocateNode={(id) => highlightAgentNode(id)}
        showToast={showToast}
        onBusyChange={setAgentBusy}
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
        queueWidth={panelWidth}
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
        nodes={nodes}
        edges={edges}
        toast={toast}
      />

      <BridgeSetupModal
        open={bridgeModalOpen}
        onClose={() => setBridgeModalOpen(false)}
        onSummaryChange={() => void refreshBridgeSummary()}
        showToast={showToast}
      />

      <AgySetupModal
        open={agyModalOpen}
        onClose={() => setAgyModalOpen(false)}
        showToast={showToast}
      />

      <GeminiWebSetupModal
        open={geminiWebModalOpen}
        onClose={() => setGeminiWebModalOpen(false)}
        showToast={showToast}
      />
    </div>
  );
}
