import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import type { CanvasTool } from "../components/CanvasToolbar";
import {
  computePinchViewport,
  createPinchState,
  MAX_ZOOM,
  MIN_ZOOM,
  selectNodesInBox,
  type ContextMenuState,
  type CreateMenuState,
  type GestureState,
  type Viewport,
} from "./gesture-math";
import { useCanvasShortcuts } from "./use-canvas-shortcuts";
import {
  useConnectionWiring,
  type PendingConnectState,
} from "./use-connection-wiring";
import { useLongPress } from "./use-long-press";
import type {
  CanvasEdge,
  CanvasNode,
  ConnectingState,
  NodeDraft,
  SelectionBoxState,
} from "../types";

export {
  MAX_ZOOM,
  MIN_ZOOM,
  type ContextMenuState,
  type CreateMenuState,
  type GestureState,
  type Viewport,
};

export function useCanvasGestures({
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
}: {
  projectIdRef: { current: string | null };
  nodesRef: { current: CanvasNode[] };
  edgesRef: { current: CanvasEdge[] };
  viewportRef: { current: Viewport };
  selectedIdsRef: { current: Set<string> };
  selectedEdgeIdRef: { current: string | null };
  canvasRef: { current: HTMLDivElement | null };
  canvasTool: CanvasTool;
  multiSelectMode: boolean;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
  setCreateMenu: Dispatch<SetStateAction<CreateMenuState | null>>;
  applyViewport: (next: Viewport, save?: boolean) => void;
  applyEdges: (next: CanvasEdge[]) => void;
  applyGraph: (nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => void;
  recordHistory: () => void;
  scheduleSave: () => void;
  showToast: (message: string) => void;
  updateSelectedIds: (next: Set<string>) => void;
  updateSelectedEdgeId: (next: string | null) => void;
  buildNode: (partial: NodeDraft) => CanvasNode | null;
  persistAddedNode: (node: CanvasNode) => void;
  deleteNodes: (ids: Set<string>) => void;
  deleteEdge: (id: string) => void;
  undoGraph: () => void;
  redoGraph: () => void;
}) {
// Detail-editor (图1) summon rule: dragging a node must not pop the
// editor. While a node drag is moving, the editor is hidden; when a
// drag STARTS a fresh selection, the editor stays suppressed for
// that node until the next plain click on it.
const [nodeDragging, setNodeDragging] = useState(false);
const [suppressedEditorId, setSuppressedEditorId] = useState<string | null>(null);
const suppressedEditorRef = useRef<string | null>(null);
const setEditorSuppressed = useCallback((id: string | null) => {
  suppressedEditorRef.current = id;
  setSuppressedEditorId(id);
}, []);
const [selectionBox, setSelectionBox] = useState<SelectionBoxState | null>(null);
const [spaceDown, setSpaceDown] = useState(false);
const selectionBoxRef = useRef<SelectionBoxState | null>(null);
const gestureRef = useRef<GestureState | null>(null);
const multiSelectRef = useRef(false);
multiSelectRef.current = multiSelectMode;
// Active non-mouse pointers; a second pointer converts the gesture into a pinch.
const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
const pinchRef = useRef<{
  startDist: number;
  startCx: number;
  startCy: number;
  viewport: Viewport;
} | null>(null);
// Stale pinch pointers are ignored until lift so they cannot resume a cancelled drag.
const pinchStaleRef = useRef(new Set<number>());
const handlePressRef = useRef<{
  pointerId: number;
  x: number;
  y: number;
} | null>(null);
const spaceRef = useRef(false);

const {
  connecting,
  setConnecting,
  pendingConnect,
  setPendingConnect,
  connectTargetId,
  setConnectTargetId,
  mouseWorld,
  setMouseWorld,
  tapConnect,
  setTapConnect,
  connectingRef,
  pendingConnectRef,
  tapConnectRef,
  screenToWorld,
  computeDropTarget,
  clearConnecting,
  cancelPendingConnect,
  addConnection,
  createConnectedNode,
  clearTapConnect,
  openTapConnectCreateMenu,
} = useConnectionWiring({
  projectIdRef,
  nodesRef,
  edgesRef,
  viewportRef,
  canvasRef,
  setContextMenu,
  applyEdges,
  applyGraph,
  showToast,
  buildNode,
  persistAddedNode,
  updateSelectedIds,
  updateSelectedEdgeId,
});

// Long-press sub-domain (use-long-press.ts): the armed ~500ms
// touch long-press that fires the context menu; the dispatchers
// arm its timer on pointer-down and disarm it on move/up.
const { longPressRef, cancelLongPress, fireLongPress } = useLongPress({
  gestureRef,
  setNodeDragging,
  connectingRef,
  clearConnecting,
  selectionBoxRef,
  setSelectionBox,
  selectedIdsRef,
  updateSelectedIds,
  updateSelectedEdgeId,
  setContextMenu,
  setCreateMenu,
  screenToWorld,
});


const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
  if (e.button === 2) return;
  const target = e.target as HTMLElement;
  if (target.closest("[data-ui]") || target.closest("[data-canvas-menu]")) return;
  if (target.closest("[data-node-media]")) {
    // Only drag-surface (video picture) outside controls/bottom strip starts a card drag.
    const surface = target.closest("[data-node-drag-surface]") as HTMLElement | null;
    if (!surface) return;
    if (target.closest("button, input, select, textarea, a")) return;
    if (e.clientY > surface.getBoundingClientRect().bottom - 44) return;
  }
  if (e.button !== 0 && e.button !== 1) return;

  if (e.pointerType !== "mouse") {
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchRef.current) return;
    if (activePointersRef.current.size === 2) {
      const [a, b] = [...activePointersRef.current.values()];
      const rect = canvasRef.current?.getBoundingClientRect();
      if (a && b && rect) {
        cancelLongPress();
        gestureRef.current = null;
        setNodeDragging(false);
        selectionBoxRef.current = null;
        setSelectionBox(null);
        if (connectingRef.current) clearConnecting();
        pinchRef.current = createPinchState(a, b, rect, viewportRef.current);
      }
      return;
    }
    if (e.pointerType === "touch" && activePointersRef.current.size === 1) {
      cancelLongPress();
      const pressX = e.clientX;
      const pressY = e.clientY;
      longPressRef.current = {
        timer: window.setTimeout(() => fireLongPress(pressX, pressY), 500),
        pointerId: e.pointerId,
        x: pressX,
        y: pressY,
      };
    }
  }

  // Armed tap-to-connect: tapping another node finishes the wire; elsewhere disarms.
  const tc = tapConnectRef.current;
  if (tc) {
    const tcNodeEl = target.closest("[data-node-id]") as HTMLElement | null;
    const tcTargetId = tcNodeEl?.dataset.nodeId;
    clearTapConnect();
    if (tcTargetId && tcTargetId !== tc.nodeId) {
      addConnection(tc, tcTargetId);
      return;
    }
  }

  const handleEl = target.closest("[data-connect-node]") as HTMLElement | null;
  if (handleEl && e.button === 0) {
    const nodeId = handleEl.dataset.connectNode;
    const handleType = handleEl.dataset.connectType as "source" | "target" | undefined;
    if (nodeId && handleType) {
      handlePressRef.current = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
      };
      const conn: ConnectingState = { nodeId, handleType };
      connectingRef.current = conn;
      setConnecting(conn);
      setConnectTargetId(null);
      updateSelectedEdgeId(null);
      setMouseWorld(screenToWorld(e.clientX, e.clientY));
    }
    return;
  }

  if (target.closest("[data-connection-id]")) return; // edge clicks select via onClick

  const nodeEl = target.closest("[data-node-id]") as HTMLElement | null;
  if (nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    if (!nodeId) return;
    // A touch press inside a text node's scrollable content
    // belongs to the content: the browser scrolls it natively
    // (the content opts into pan-y), and the canvas must not
    // turn the swipe into a node drag. The press still selects.
    if (e.pointerType === "touch" && target.closest("[data-text-scroll]")) {
      if (!selectedIdsRef.current.has(nodeId)) {
        updateSelectedIds(new Set([nodeId]));
      }
      updateSelectedEdgeId(null);
      setContextMenu(null);
      gestureRef.current = { kind: "none" };
      return;
    }
    // Multi-select mode: tapping an unselected node only adds it
    // to the selection (no drag starts on this press); dragging
    // works from the next press, when it is already selected.
    if (multiSelectRef.current && !selectedIdsRef.current.has(nodeId)) {
      const next = new Set(selectedIdsRef.current);
      next.add(nodeId);
      updateSelectedIds(next);
      updateSelectedEdgeId(null);
      setContextMenu(null);
      gestureRef.current = { kind: "none" };
      return;
    }
    if (e.button === 1 || spaceRef.current) {
      gestureRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        viewport: viewportRef.current,
        moved: false,
        startedOnBackground: false,
      };
      return;
    }
    // Upstream selectNodeByEvent: toggle with shift/meta/ctrl, else solo.
    const prev = selectedIdsRef.current;
    let nextSelected: Set<string>;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      nextSelected = new Set(prev);
      if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
      else nextSelected.add(nodeId);
    } else if (prev.has(nodeId)) {
      nextSelected = prev;
    } else {
      nextSelected = new Set([nodeId]);
    }
    // Was the detail editor open for THIS node before the gesture?
    // (single selection of it, not drag-suppressed). A drag that
    // starts a fresh selection must not summon the editor; a drag
    // of an already-open node may keep it after the drop.
    const editorWasOpen =
      prev.size === 1 && prev.has(nodeId) && suppressedEditorRef.current !== nodeId;
    updateSelectedIds(nextSelected);
    updateSelectedEdgeId(null);
    setContextMenu(null);
    // Drag origins: the whole selection plus children of selected groups.
    const origins = new Map<string, { x: number; y: number }>();
    for (const n of nodesRef.current) {
      if (nextSelected.has(n.id)) origins.set(n.id, { x: n.x, y: n.y });
    }
    for (const n of nodesRef.current) {
      if (n.groupId && nextSelected.has(n.groupId)) {
        origins.set(n.id, { x: n.x, y: n.y });
      }
    }
    // One undo step per drag: node moves bypass applyNodes while
    // dragging (they write the refs directly), so record up front.
    recordHistory();
    gestureRef.current = {
      kind: "node",
      startX: e.clientX,
      startY: e.clientY,
      origins,
      moved: false,
      primaryId: nodeId,
      editorWasOpen,
      tapToggleId:
        multiSelectRef.current && prev.has(nodeId) ? nodeId : undefined,
    };
    return;
  }

  // Background. Upstream infinite-canvas semantics: the base tool
  // (toolbar toggle, default pan) decides what a plain drag does,
  // and Ctrl / Meta / Space temporarily INVERTS it — so with the
  // default pan tool a plain drag pans the canvas and Ctrl+drag
  // draws the selection box. The middle button always pans.
  const temporaryTool = e.ctrlKey || e.metaKey || spaceRef.current;
  const activeTool = temporaryTool
    ? canvasTool === "pan"
      ? "select"
      : "pan"
    : canvasTool;
  if (e.button === 1 || activeTool === "pan") {
    gestureRef.current = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      viewport: viewportRef.current,
      moved: false,
      startedOnBackground: true,
    };
    return;
  }
  const world = screenToWorld(e.clientX, e.clientY);
  const box: SelectionBoxState = {
    startWorldX: world.x,
    startWorldY: world.y,
    currentWorldX: world.x,
    currentWorldY: world.y,
    additive: e.shiftKey,
    initialSelectedNodeIds: e.shiftKey ? [...selectedIdsRef.current] : [],
  };
  selectionBoxRef.current = box;
  setSelectionBox(box);
  if (!e.shiftKey) updateSelectedIds(new Set());
  updateSelectedEdgeId(null);
  setContextMenu(null);
  gestureRef.current = { kind: "box" };
};

const handleWindowPointerMove = useCallback(
  (e: PointerEvent) => {
    // Pinch in progress: zoom is anchored so the world point
    // under the fingers' starting center stays under their
    // current center — the same math gives two-finger pan.
    const pinch = pinchRef.current;
    if (pinch) {
      if (activePointersRef.current.has(e.pointerId)) {
        activePointersRef.current.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
        });
      }
      const pts = [...activePointersRef.current.values()];
      const a = pts[0];
      const b = pts[1];
      const rect = canvasRef.current?.getBoundingClientRect();
      if (a && b && rect) {
        const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const cx = (a.x + b.x) / 2 - rect.left;
        const cy = (a.y + b.y) / 2 - rect.top;
        applyViewport(
          computePinchViewport(
            pinch.viewport,
            pinch.startCx,
            pinch.startCy,
            pinch.startDist,
            cx,
            cy,
            dist,
          ),
          false,
        );
      }
      return;
    }
    if (pinchStaleRef.current.has(e.pointerId)) return;
    // A press that wanders is a drag, not a long-press.
    const lp = longPressRef.current;
    if (
      lp &&
      lp.pointerId === e.pointerId &&
      Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10
    ) {
      cancelLongPress();
    }
    const conn = connectingRef.current;
    if (conn && !pendingConnectRef.current) {
      setMouseWorld(screenToWorld(e.clientX, e.clientY));
      setConnectTargetId(computeDropTarget(e.clientX, e.clientY, conn).nodeId);
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.kind === "none") return;
    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
      applyViewport(
        { ...gesture.viewport, x: gesture.viewport.x + dx, y: gesture.viewport.y + dy },
        false,
      );
      return;
    }
    if (gesture.kind === "node") {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        if (!gesture.moved) setNodeDragging(true);
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      const zoom = viewportRef.current.zoom;
      const next = nodesRef.current.map((n) => {
        const origin = gesture.origins.get(n.id);
        return origin
          ? { ...n, x: origin.x + dx / zoom, y: origin.y + dy / zoom }
          : n;
      });
      nodesRef.current = next;
      setNodes(next);
      return;
    }
    // Box selection: live-update the rect and the selection (upstream).
    const box = selectionBoxRef.current;
    if (!box) return;
    if (e.buttons === 0) {
      selectionBoxRef.current = null;
      setSelectionBox(null);
      gestureRef.current = null;
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    const nextSelected = selectNodesInBox(
      nodesRef.current,
      box.startWorldX,
      box.startWorldY,
      world.x,
      world.y,
      box.additive ? box.initialSelectedNodeIds : undefined,
    );
    const nextBox = { ...box, currentWorldX: world.x, currentWorldY: world.y };
    selectionBoxRef.current = nextBox;
    setSelectionBox(nextBox);
    updateSelectedIds(nextSelected);
  },
  [applyViewport, cancelLongPress, computeDropTarget, screenToWorld, updateSelectedIds],
);

const handleWindowPointerUp = useCallback(
  (e: PointerEvent) => {
    // End pinch when one finger lifts; remaining down pointers go stale until lift.
    activePointersRef.current.delete(e.pointerId);
    if (longPressRef.current?.pointerId === e.pointerId) cancelLongPress();
    if (pinchRef.current) {
      pinchRef.current = null;
      handlePressRef.current = null;
      for (const id of activePointersRef.current.keys()) {
        pinchStaleRef.current.add(id);
      }
      scheduleSave();
      return;
    }
    if (pinchStaleRef.current.has(e.pointerId)) {
      pinchStaleRef.current.delete(e.pointerId);
      return;
    }
    const conn = connectingRef.current;
    if (conn && !pendingConnectRef.current) {
      const drop = computeDropTarget(e.clientX, e.clientY, conn);
      const hp = handlePressRef.current;
      handlePressRef.current = null;
      const handleTap =
        hp !== null &&
        hp.pointerId === e.pointerId &&
        Math.hypot(e.clientX - hp.x, e.clientY - hp.y) < 8;
      if (drop.nodeId) {
        addConnection(conn, drop.nodeId);
        clearConnecting();
      } else if (handleTap && drop.isNearNode) {
        // A plain tap on a connect handle (the natural touch
        // gesture, where dragging a wire is fiddly): arm
        // tap-to-connect instead of dropping the wire — the next
        // node tapped becomes the target.
        tapConnectRef.current = conn;
        setTapConnect(conn);
        connectingRef.current = null;
        setConnecting(null);
        setConnectTargetId(null);
      } else if (drop.isNearNode) {
        clearConnecting();
      } else {
        const world = screenToWorld(e.clientX, e.clientY);
        const pending: PendingConnectState = {
          connection: conn,
          worldX: world.x,
          worldY: world.y,
          x: e.clientX,
          y: e.clientY,
        };
        pendingConnectRef.current = pending;
        setPendingConnect(pending);
        setConnectTargetId(null);
      }
    }
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    if (gesture.kind === "pan") {
      // Multi-select mode keeps the selection across background
      // taps (the mode's own pill / toolbar toggle exits it).
      // A release that lands on UI chrome (e.g. a portaled menu
      // rooted in <body>) is not a background tap either — it
      // must never clear the selection out from under an open
      // panel.
      const upTarget = e.target as HTMLElement | null;
      const releasedOnUi =
        !!upTarget &&
        typeof upTarget.closest === "function" &&
        upTarget.closest("[data-ui],[data-canvas-menu]") !== null;
      if (
        !gesture.moved &&
        gesture.startedOnBackground &&
        !multiSelectRef.current &&
        !releasedOnUi
      ) {
        updateSelectedIds(new Set());
        updateSelectedEdgeId(null);
      }
      scheduleSave();
    } else if (gesture.kind === "node") {
      setNodeDragging(false);
      if (gesture.moved) {
        scheduleSave();
        // A drag must not summon the detail editor: if this drag
        // started the selection, keep the editor suppressed for the
        // dragged node until a later plain click; if the editor was
        // already open for it, it simply reappears.
        if (!gesture.editorWasOpen) setEditorSuppressed(gesture.primaryId);
        else if (suppressedEditorRef.current === gesture.primaryId) {
          setEditorSuppressed(null);
        }
      } else if (suppressedEditorRef.current === gesture.primaryId) {
        // Plain click on the dragged-suppressed node: open the editor.
        setEditorSuppressed(null);
      }
      // Multi-select mode: a tap on an already-selected node
      // toggles it back out (a drag never toggles).
      if (gesture.tapToggleId && !gesture.moved) {
        const next = new Set(selectedIdsRef.current);
        next.delete(gesture.tapToggleId);
        updateSelectedIds(next);
      }
    } else if (gesture.kind === "box") {
      selectionBoxRef.current = null;
      setSelectionBox(null);
    }
  },
  [addConnection, cancelLongPress, clearConnecting, computeDropTarget, scheduleSave, screenToWorld, setEditorSuppressed, updateSelectedEdgeId, updateSelectedIds],
);

  const onWindowBlur = useCallback(() => {
    spaceRef.current = false;
    setSpaceDown(false);
    gestureRef.current = null;
    setNodeDragging(false);
    pinchRef.current = null;
    activePointersRef.current.clear();
    pinchStaleRef.current.clear();
    cancelLongPress();
  }, [cancelLongPress]);

  const { onCanvasContextMenu, onCanvasDoubleClick } = useCanvasShortcuts({
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
  });

  return {
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
  };
}
