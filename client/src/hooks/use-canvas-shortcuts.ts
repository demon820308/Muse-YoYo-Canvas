import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import { computeWheelZoomViewport, type Viewport } from "./gesture-math";

function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function useCanvasShortcuts(opts: {
  canvasRef: RefObject<HTMLDivElement | null>;
  viewportRef: MutableRefObject<Viewport>;
  selectedIdsRef: MutableRefObject<Set<string>>;
  selectedEdgeIdRef: MutableRefObject<string | null>;
  spaceRef: MutableRefObject<boolean>;
  tapConnectRef: MutableRefObject<unknown>;
  pendingConnectRef: MutableRefObject<unknown>;
  connectingRef: MutableRefObject<unknown>;
  setSpaceDown: (down: boolean) => void;
  undoGraph: () => void;
  redoGraph: () => void;
  deleteEdge: (id: string) => void;
  deleteNodes: (ids: Set<string>) => void;
  clearTapConnect: () => void;
  cancelPendingConnect: () => void;
  clearConnecting: () => void;
  setContextMenu: (v: { type: "node"; nodeId: string; x: number; y: number } | null) => void;
  setCreateMenu: (v: { x: number; y: number; worldX: number; worldY: number } | null) => void;
  screenToWorld: (x: number, y: number) => { x: number; y: number };
  updateSelectedIds: (next: Set<string>) => void;
  updateSelectedEdgeId: (next: string | null) => void;
  applyViewport: (vp: Viewport) => void;
  handleWindowPointerMove: (e: PointerEvent) => void;
  handleWindowPointerUp: (e: PointerEvent) => void;
  onWindowBlur: () => void;
}) {
  const {
    canvasRef,
    viewportRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    spaceRef,
    tapConnectRef,
    pendingConnectRef,
    connectingRef,
    setSpaceDown,
    undoGraph,
    redoGraph,
    deleteEdge,
    deleteNodes,
    clearTapConnect,
    cancelPendingConnect,
    clearConnecting,
    setContextMenu,
    setCreateMenu,
    screenToWorld,
    updateSelectedIds,
    updateSelectedEdgeId,
    applyViewport,
    handleWindowPointerMove,
    handleWindowPointerUp,
    onWindowBlur,
  } = opts;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === "Space" && !isFormTarget(e.target)) {
        e.preventDefault();
        spaceRef.current = true;
        setSpaceDown(true);
      }
      if (isFormTarget(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoGraph();
        else undoGraph();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoGraph();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeIdRef.current) {
          e.preventDefault();
          deleteEdge(selectedEdgeIdRef.current);
        } else if (selectedIdsRef.current.size) {
          e.preventDefault();
          deleteNodes(new Set(selectedIdsRef.current));
        }
      } else if (e.key === "Escape") {
        if (tapConnectRef.current) clearTapConnect();
        else if (pendingConnectRef.current) cancelPendingConnect();
        else if (connectingRef.current) clearConnecting();
        else {
          setContextMenu(null);
          setCreateMenu(null);
          updateSelectedIds(new Set());
          updateSelectedEdgeId(null);
        }
      }
    },
    [
      cancelPendingConnect,
      clearConnecting,
      clearTapConnect,
      connectingRef,
      deleteEdge,
      deleteNodes,
      pendingConnectRef,
      redoGraph,
      selectedEdgeIdRef,
      selectedIdsRef,
      setContextMenu,
      setCreateMenu,
      setSpaceDown,
      spaceRef,
      tapConnectRef,
      undoGraph,
      updateSelectedEdgeId,
      updateSelectedIds,
    ],
  );

  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [handleKeyDown, handleWindowPointerMove, handleWindowPointerUp, onWindowBlur, setSpaceDown, spaceRef]);

  const applyViewportRef = useRef(applyViewport);
  applyViewportRef.current = applyViewport;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-canvas-no-zoom]")) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      applyViewportRef.current(
        computeWheelZoomViewport(
          viewportRef.current,
          event.clientX - rect.left,
          event.clientY - rect.top,
          event.deltaY,
        ),
      );
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [canvasRef, viewportRef]);

  const onCanvasContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    if (target.closest("[data-ui]") || target.closest("[data-canvas-menu]")) return;
    const nodeEl = target.closest("[data-node-id]") as HTMLElement | null;
    if (nodeEl) {
      const nodeId = nodeEl.dataset.nodeId;
      if (!nodeId) return;
      if (!selectedIdsRef.current.has(nodeId)) updateSelectedIds(new Set([nodeId]));
      updateSelectedEdgeId(null);
      setCreateMenu(null);
      setContextMenu({ type: "node", nodeId, x: e.clientX, y: e.clientY });
      return;
    }
    if (target.closest("[data-connection-id]")) return;
    const world = screenToWorld(e.clientX, e.clientY);
    setContextMenu(null);
    setCreateMenu({ x: e.clientX, y: e.clientY, worldX: world.x, worldY: world.y });
  };

  const onCanvasDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-ui],[data-canvas-menu],[data-node-id],[data-connection-id]")) return;
    const world = screenToWorld(e.clientX, e.clientY);
    setContextMenu(null);
    setCreateMenu({ x: e.clientX, y: e.clientY, worldX: world.x, worldY: world.y });
  };

  return { onCanvasContextMenu, onCanvasDoubleClick };
}
