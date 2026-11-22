import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ProjectDialogState } from "../components/AppDialogs";
import { releasePlaybackBlobs } from "../playback-blob";
import type { CanvasEdge, CanvasNode, ConnectingState } from "../types";
import type { ContextMenuState, CreateMenuState } from "./use-canvas-gestures";
import type { PendingConnectState } from "./use-connection-wiring";

export function useProjectActions(opts: {
  projectId: string | null;
  projectIdRef: MutableRefObject<string | null>;
  loadedProjectRef: MutableRefObject<string | null>;
  intentionalEmptyRef: MutableRefObject<boolean>;
  knownNodeIdsRef: MutableRefObject<Set<string>>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  edgesRef: MutableRefObject<CanvasEdge[]>;
  connectingRef: MutableRefObject<ConnectingState | null>;
  pendingConnectRef: MutableRefObject<PendingConnectState | null>;
  tapConnectRef: MutableRefObject<{ nodeId: string; handleType: "source" | "target" } | null>;
  pinchRef: MutableRefObject<unknown>;
  activePointersRef: MutableRefObject<Map<number, unknown>>;
  pinchStaleRef: MutableRefObject<Set<number>>;
  longPressRef: MutableRefObject<{ timer: number } | null>;
  queryClient: QueryClient;
  cancelPendingSave: () => void;
  resetHistory: () => void;
  setProjectId: (id: string | null) => void;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setEdges: Dispatch<SetStateAction<CanvasEdge[]>>;
  updateSelectedIds: (next: Set<string>) => void;
  updateSelectedEdgeId: (next: string | null) => void;
  setEditorSuppressed: (id: string | null) => void;
  setNodeDragging: (v: boolean) => void;
  setContextMenu: (v: ContextMenuState | null) => void;
  setCreateMenu: (v: CreateMenuState | null) => void;
  setConnecting: (v: ConnectingState | null) => void;
  setPendingConnect: (v: PendingConnectState | null) => void;
  setTapConnect: (v: { nodeId: string; handleType: "source" | "target" } | null) => void;
  setDialog: (d: ProjectDialogState) => void;
  showToast: (msg: string) => void;
  refreshGraphFromServer: () => Promise<void>;
}) {
  const {
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
  } = opts;

  const switchProject = useCallback(
    (id: string | null) => {
      // Re-selecting the already open project must be a no-op to avoid clearing and saving an empty graph.
      if (id !== null && id === projectIdRef.current) return;
      releasePlaybackBlobs();
      loadedProjectRef.current = null;
      intentionalEmptyRef.current = false;
      knownNodeIdsRef.current = new Set();
      cancelPendingSave();
      resetHistory();
      setProjectId(id);
      setNodes([]);
      nodesRef.current = [];
      setEdges([]);
      edgesRef.current = [];
      updateSelectedIds(new Set());
      updateSelectedEdgeId(null);
      setEditorSuppressed(null);
      setNodeDragging(false);
      setContextMenu(null);
      setCreateMenu(null);
      connectingRef.current = null;
      setConnecting(null);
      pendingConnectRef.current = null;
      setPendingConnect(null);
      tapConnectRef.current = null;
      setTapConnect(null);
      pinchRef.current = null;
      activePointersRef.current.clear();
      pinchStaleRef.current.clear();
      if (longPressRef.current) {
        window.clearTimeout(longPressRef.current.timer);
        longPressRef.current = null;
      }
    },
    [
      activePointersRef,
      cancelPendingSave,
      connectingRef,
      edgesRef,
      intentionalEmptyRef,
      knownNodeIdsRef,
      loadedProjectRef,
      longPressRef,
      nodesRef,
      pendingConnectRef,
      pinchRef,
      pinchStaleRef,
      projectIdRef,
      resetHistory,
      setConnecting,
      setContextMenu,
      setCreateMenu,
      setEditorSuppressed,
      setEdges,
      setNodeDragging,
      setNodes,
      setPendingConnect,
      setProjectId,
      setTapConnect,
      tapConnectRef,
      updateSelectedEdgeId,
      updateSelectedIds,
    ],
  );

  const createProject = useMutation({
    mutationFn: (args: { name: string; workspaceDir?: string }) => api.createProject(args),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDialog(null);
      switchProject(res.id);
      showToast("项目已创建");
    },
    onError: (err) => {
      showToast(err instanceof Error ? `创建失败：${err.message}` : "创建项目失败");
    },
  });

  const renameProject = useMutation({
    mutationFn: (args: { id: string; name: string }) => api.renameProject(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      loadedProjectRef.current = projectId;
      setDialog(null);
      showToast("已重命名");
    },
  });

  const moveProjectDir = useMutation({
    mutationFn: (args: { projectId: string; workspaceDir: string }) =>
      api.changeProjectDirectory(args),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      void queryClient.invalidateQueries({ queryKey: ["generation-records"] });
      void refreshGraphFromServer();
      setDialog(null);
      showToast(
        res.cleanupWarning
          ? `目录已迁移（${res.movedFiles} 个文件）；${res.cleanupWarning}`
          : `目录已迁移，共转移 ${res.movedFiles} 个文件`,
      );
    },
    onError: (err) => {
      showToast(err instanceof Error ? `迁移失败：${err.message}` : "更改目录失败");
    },
  });

  const deleteProject = useMutation({
    mutationFn: (id: string) => api.deleteProject({ id }),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDialog(null);
      if (id === projectId) switchProject(null);
      showToast("项目已删除");
    },
  });

  return {
    switchProject,
    createProject,
    renameProject,
    moveProjectDir,
    deleteProject,
  };
}
