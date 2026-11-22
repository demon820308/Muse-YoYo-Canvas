export type Viewport = { x: number; y: number; zoom: number };

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 5;

/** 滚轮锚点缩放：保持鼠标下的世界坐标在缩放前后屏幕位置不变。 */
export function computeWheelZoomViewport(
  vp: Viewport,
  mx: number,
  my: number,
  deltaY: number,
): Viewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor));
  const wx = (mx - vp.x) / vp.zoom;
  const wy = (my - vp.y) / vp.zoom;
  return { zoom, x: mx - wx * zoom, y: my - wy * zoom };
}

export function createPinchState(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { left: number; top: number },
  viewport: Viewport,
) {
  return {
    startDist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
    startCx: (a.x + b.x) / 2 - rect.left,
    startCy: (a.y + b.y) / 2 - rect.top,
    viewport,
  };
}

export function computePinchViewport(
  startViewport: Viewport,
  startCx: number,
  startCy: number,
  startDist: number,
  cx: number,
  cy: number,
  dist: number,
): Viewport {
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, startViewport.zoom * (dist / startDist)),
  );
  const wx = (startCx - startViewport.x) / startViewport.zoom;
  const wy = (startCy - startViewport.y) / startViewport.zoom;
  return { zoom, x: cx - wx * zoom, y: cy - wy * zoom };
}

export function selectNodesInBox<
  T extends { id: string; x: number; y: number; width: number; height: number; hidden?: boolean },
>(
  nodes: readonly T[],
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  initialSelectedIds?: readonly string[],
): Set<string> {
  const rectX = Math.min(startX, endX);
  const rectY = Math.min(startY, endY);
  const rectW = Math.abs(endX - startX);
  const rectH = Math.abs(endY - startY);
  const next = new Set<string>(initialSelectedIds ?? []);
  for (const node of nodes) {
    if (node.hidden) continue;
    if (
      rectX < node.x + node.width &&
      rectX + rectW > node.x &&
      rectY < node.y + node.height &&
      rectY + rectH > node.y
    ) {
      next.add(node.id);
    }
  }
  return next;
}

export function computeZoomToCenter(
  vp: Viewport,
  width: number,
  height: number,
  nextZoom: number,
): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const mx = width / 2;
  const my = height / 2;
  const wx = (mx - vp.x) / vp.zoom;
  const wy = (my - vp.y) / vp.zoom;
  return { zoom, x: mx - wx * zoom, y: my - wy * zoom };
}

export type ContextMenuState =
  | { type: "node"; nodeId: string; x: number; y: number }
  | { type: "connection"; edgeId: string; x: number; y: number };

export type CreateMenuState = { x: number; y: number; worldX: number; worldY: number };

export type GestureState =
  | {
      kind: "pan";
      startX: number;
      startY: number;
      viewport: Viewport;
      moved: boolean;
      startedOnBackground: boolean;
    }
  | {
      kind: "node";
      startX: number;
      startY: number;
      origins: Map<string, { x: number; y: number }>;
      moved: boolean;
      primaryId: string;
      editorWasOpen: boolean;
      tapToggleId?: string;
    }
  | { kind: "box" }
  | { kind: "none" };

export function computeFitViewViewport(
  visible: readonly { x: number; y: number; width: number; height: number }[],
  width: number,
  height: number,
): Viewport {
  if (!visible.length) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...visible.map((n) => n.x));
  const minY = Math.min(...visible.map((n) => n.y));
  const maxX = Math.max(...visible.map((n) => n.x + n.width));
  const maxY = Math.max(...visible.map((n) => n.y + n.height));
  const pad = 48;
  const zoom = Math.min(
    1.5,
    Math.max(
      MIN_ZOOM,
      Math.min(
        (width - pad * 2) / Math.max(1, maxX - minX),
        (height - pad * 2) / Math.max(1, maxY - minY),
      ),
    ),
  );
  return {
    zoom,
    x: pad - minX * zoom + (width - pad * 2 - (maxX - minX) * zoom) / 2,
    y: pad - minY * zoom + (height - pad * 2 - (maxY - minY) * zoom) / 2,
  };
}
