import type { ComponentProps, MutableRefObject } from "react";
import type { ContextMenuState, CreateMenuState } from "../hooks/use-canvas-gestures";
import type { PendingConnectState } from "../hooks/use-connection-wiring";
import type { NodeDraft } from "../types";
import {
  ConnectionContextMenu,
  ConnectionCreateMenu,
  NodeContextMenu,
  NodeCreateMenu,
} from "./CanvasMenus";
import { QueueDrawer, type GenerationRecord } from "./QueueDrawer";

type QueueRequest = ComponentProps<typeof QueueDrawer>["requests"][number];
type ConnectCreateType = Parameters<ComponentProps<typeof ConnectionCreateMenu>["onCreate"]>[0];

export function CanvasMenusAndQueue(props: {
  contextMenu: ContextMenuState | null;
  setContextMenu: (v: ContextMenuState | null) => void;
  createMenu: CreateMenuState | null;
  setCreateMenu: (v: CreateMenuState | null) => void;
  pendingConnect: PendingConnectState | null;
  cancelPendingConnect: () => void;
  createConnectedNode: (type: ConnectCreateType) => void;
  menuCanGroup: boolean;
  menuCanUngroup: boolean;
  menuCanExtractFrames: boolean;
  runExtractVideoFrame: (nodeId: string, which: "first" | "last") => void;
  duplicateNode: (nodeId: string) => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  deleteNodes: (ids: Set<string>) => void;
  deleteEdge: (id: string) => void;
  createNodeAt: (type: NodeDraft["type"], x: number, y: number) => void;
  setTapConnect: (v: { nodeId: string; handleType: "source" | "target" } | null) => void;
  tapConnectRef: MutableRefObject<{ nodeId: string; handleType: "source" | "target" } | null>;
  queueOpen: boolean;
  closeQueue: () => void;
  projectId: string | null;
  requests: QueueRequest[];
  queueLoading: boolean;
  records: GenerationRecord[];
  recordsLoading: boolean;
  onProcessQueue: () => void;
  processingQueue: boolean;
  onLocateNode: (pid: string, nodeId: string) => void;
  onStopRequest: (pid: string, nodeId: string) => void;
  stoppingNodeId: string | null;
  onPreviewRecord: (record: GenerationRecord) => void;
  showToast: (msg: string) => void;
}) {
  const {
    contextMenu,
    setContextMenu,
    createMenu,
    setCreateMenu,
    pendingConnect,
    cancelPendingConnect,
    createConnectedNode,
    menuCanGroup,
    menuCanUngroup,
    menuCanExtractFrames,
    runExtractVideoFrame,
    duplicateNode,
    groupSelection,
    ungroupSelection,
    deleteNodes,
    deleteEdge,
    createNodeAt,
    setTapConnect,
    tapConnectRef,
    queueOpen,
    closeQueue,
    projectId,
    requests,
    queueLoading,
    records,
    recordsLoading,
    onProcessQueue,
    processingQueue,
    onLocateNode,
    onStopRequest,
    stoppingNodeId,
    onPreviewRecord,
    showToast,
  } = props;

  return (
    <>
      {contextMenu?.type === "node" ? (
        <NodeContextMenu
          menu={contextMenu}
          canGroup={menuCanGroup}
          canUngroup={menuCanUngroup}
          canExtractFrames={menuCanExtractFrames}
          onClose={() => setContextMenu(null)}
          onExtractFirstFrame={() => runExtractVideoFrame(contextMenu.nodeId, "first")}
          onExtractLastFrame={() => runExtractVideoFrame(contextMenu.nodeId, "last")}
          onDuplicate={() => {
            duplicateNode(contextMenu.nodeId);
            setContextMenu(null);
          }}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onDelete={() => {
            deleteNodes(new Set([contextMenu.nodeId]));
            setContextMenu(null);
          }}
          onTapConnect={() => {
            setTapConnect({ nodeId: contextMenu.nodeId, handleType: "source" });
            tapConnectRef.current = { nodeId: contextMenu.nodeId, handleType: "source" };
            setContextMenu(null);
          }}
        />
      ) : null}
      {contextMenu?.type === "connection" ? (
        <ConnectionContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            deleteEdge(contextMenu.edgeId);
            setContextMenu(null);
          }}
        />
      ) : null}
      {createMenu ? (
        <NodeCreateMenu
          x={createMenu.x}
          y={createMenu.y}
          onClose={() => setCreateMenu(null)}
          onCreate={(type) => {
            createNodeAt(type, createMenu.worldX, createMenu.worldY);
            setCreateMenu(null);
          }}
        />
      ) : null}
      {pendingConnect ? (
        <ConnectionCreateMenu
          x={pendingConnect.x}
          y={pendingConnect.y}
          onClose={cancelPendingConnect}
          onCreate={createConnectedNode}
        />
      ) : null}
      {queueOpen ? (
        <QueueDrawer
          currentProjectId={projectId}
          requests={requests}
          queueLoading={queueLoading}
          records={records}
          recordsLoading={recordsLoading}
          onClose={closeQueue}
          onProcessQueue={onProcessQueue}
          processingQueue={processingQueue}
          onLocateNode={onLocateNode}
          onStopRequest={onStopRequest}
          stoppingNodeId={stoppingNodeId}
          onPreviewRecord={onPreviewRecord}
          showToast={showToast}
        />
      ) : null}
    </>
  );
}
