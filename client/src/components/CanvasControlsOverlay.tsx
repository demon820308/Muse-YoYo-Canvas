import type { Viewport } from "../hooks/gesture-math";
import type { CanvasNode } from "../types";
import { MiniMap } from "./MiniMap";
import { ZoomControls } from "./ZoomControls";

export function CanvasControlsOverlay(props: {
  keyboardUp: boolean;
  viewport: Viewport;
  zoomTo: (zoom: number) => void;
  fitView: () => void;
  visibleNodes: CanvasNode[];
  canvasSize: { width: number; height: number };
  applyViewport: (next: Viewport) => void;
  tapConnect: { nodeId: string; handleType: "source" | "target" } | null;
  openTapConnectCreateMenu: () => void;
  clearTapConnect: () => void;
  multiSelectMode: boolean;
  selectedCount: number;
  onDeleteSelected: () => void;
  exitMultiSelect: () => void;
}) {
  const {
    keyboardUp,
    viewport,
    zoomTo,
    fitView,
    visibleNodes,
    canvasSize,
    applyViewport,
    tapConnect,
    openTapConnectCreateMenu,
    clearTapConnect,
    multiSelectMode,
    selectedCount,
    onDeleteSelected,
    exitMultiSelect,
  } = props;

  return (
    <>
      {!keyboardUp ? (
        <>
          <ZoomControls scale={viewport.zoom} onScaleChange={zoomTo} onFit={fitView} />
          <div className="hidden sm:contents">
            <MiniMap
              nodes={visibleNodes}
              viewport={viewport}
              viewportSize={canvasSize}
              onViewportChange={(next) => applyViewport(next)}
            />
          </div>
        </>
      ) : null}
      {tapConnect ? (
        <div
          data-ui
          className="capsule-chrome absolute left-1/2 top-16 z-40 flex max-w-[94vw] -translate-x-1/2 items-center gap-1.5 rounded-full py-1.5 pl-4 pr-1.5"
          role="status"
          aria-label="连线进行中"
        >
          <span className="whitespace-nowrap text-xs">
            连线中：点选目标节点完成连线，点空白取消
          </span>
          <button
            type="button"
            className="hit-40 whitespace-nowrap rounded-full bg-[var(--surface-3)] px-3 py-1.5 text-xs hover:text-[var(--accent)]"
            onClick={openTapConnectCreateMenu}
            aria-label="新建节点并连线"
          >
            新建并连线
          </button>
          <button
            type="button"
            className="hit-40 whitespace-nowrap rounded-full px-3 py-1.5 text-xs text-[var(--dim)] hover:bg-[var(--hover)]"
            onClick={clearTapConnect}
            aria-label="取消连线"
          >
            取消
          </button>
        </div>
      ) : null}
      {multiSelectMode ? (
        <div
          data-ui
          className="capsule-chrome absolute bottom-24 left-1/2 z-40 flex max-w-[94vw] -translate-x-1/2 items-center gap-1.5 rounded-full py-1.5 pl-4 pr-1.5"
          role="status"
          aria-label="多选模式"
        >
          <span className="whitespace-nowrap text-xs">
            多选模式 · 已选 {selectedCount} 个
          </span>
          <button
            type="button"
            disabled={selectedCount === 0}
            className="hit-40 whitespace-nowrap rounded-full bg-[var(--surface-3)] px-3 py-1.5 text-xs text-[var(--danger)] disabled:opacity-40"
            onClick={onDeleteSelected}
            aria-label="删除所选节点"
          >
            删除所选
          </button>
          <button
            type="button"
            className="hit-40 whitespace-nowrap rounded-full px-3 py-1.5 text-xs text-[var(--dim)] hover:bg-[var(--hover)]"
            onClick={exitMultiSelect}
            aria-label="退出多选模式"
          >
            退出
          </button>
        </div>
      ) : null}
    </>
  );
}
