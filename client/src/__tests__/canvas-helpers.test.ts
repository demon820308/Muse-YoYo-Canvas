import { describe, expect, test } from "bun:test";
import {
  computeFitViewViewport,
  computePinchViewport,
  computeWheelZoomViewport,
  computeZoomToCenter,
  MAX_ZOOM,
  MIN_ZOOM,
  selectNodesInBox,
} from "../hooks/gesture-math";
import { EXTENSION_ENTRIES, toEdgeInput, toNodeInput } from "../app-helpers";
import {
  buildInputsByNodeId,
  collectNodeReferences,
  computeAnchoredPanelStyle,
  computeCanvasBackgroundStyle,
  computeSelectionBoxRect,
} from "../canvas-derived";
import type { CanvasEdge, CanvasNode } from "../types";
import { pickNextProjectId } from "../hooks/use-project-actions";

describe("gesture-math", () => {
  test("滚轮缩放保持鼠标下世界坐标不动且受上下限钳制", () => {
    const vp = { x: 100, y: 50, zoom: 1 };
    const next = computeWheelZoomViewport(vp, 300, 250, -100);
    expect(next.zoom).toBeCloseTo(1.1, 6);
    const wxBefore = (300 - vp.x) / vp.zoom;
    const wxAfter = (300 - next.x) / next.zoom;
    expect(wxAfter).toBeCloseTo(wxBefore, 6);

    expect(computeWheelZoomViewport({ x: 0, y: 0, zoom: MAX_ZOOM }, 0, 0, -500).zoom).toBe(MAX_ZOOM);
    expect(computeWheelZoomViewport({ x: 0, y: 0, zoom: MIN_ZOOM }, 0, 0, 500).zoom).toBe(MIN_ZOOM);
  });

  test("双指缩放保持起始中心世界坐标，选框命中忽略隐藏节点", () => {
    const vp = computePinchViewport({ x: 0, y: 0, zoom: 1 }, 100, 100, 50, 120, 110, 100);
    expect(vp.zoom).toBe(2);
    expect(vp.x).toBe(-80);
    expect(vp.y).toBe(-90);

    const nodes = [
      { id: "n1", x: 10, y: 10, width: 40, height: 40, hidden: false },
      { id: "n2", x: 20, y: 20, width: 40, height: 40, hidden: true },
      { id: "n3", x: 200, y: 200, width: 40, height: 40, hidden: false },
    ];
    const picked = selectNodesInBox(nodes, 0, 0, 100, 100, ["keep"]);
    expect([...picked]).toEqual(["keep", "n1"]);

    expect(computeFitViewViewport([], 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
    const z = computeZoomToCenter({ x: 0, y: 0, zoom: 1 }, 800, 600, 2);
    expect(z).toEqual({ zoom: 2, x: -400, y: -300 });
  });
});

describe("app-helpers", () => {
  test("EXTENSION_ENTRIES 包含 7 类扩展工具入口", () => {
    expect(EXTENSION_ENTRIES.map((e) => e.type)).toEqual([
      "video-frames",
      "video-relay",
      "video-compose",
      "prompt-reverse",
      "audio-extract",
      "image-mask",
      "sticky-note",
    ]);
    expect(EXTENSION_ENTRIES.find((e) => e.type === "image-mask")?.label).toBe("绘制蒙版");
  });

  test("toNodeInput 与 toEdgeInput 仅保留保存契约字段", () => {
    const node = {
      id: "n1",
      projectId: "p1",
      type: "image",
      title: "t",
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      content: "c",
      prompt: "p",
      status: "ready",
      hidden: false,
      groupId: null,
      color: null,
      freeResize: false,
      fontSize: null,
      genRatio: "1:1",
      genDuration: null,
      genMode: null,
      seq: 3,
      mediaUrl: "/blobs/ignored",
    } as unknown as CanvasNode;
    const mapped = toNodeInput(node);
    expect("mediaUrl" in mapped).toBe(false);
    expect("projectId" in mapped).toBe(false);
    expect(mapped.seq).toBe(3);

    const edge = { id: "e1", fromNodeId: "a", toNodeId: "b", projectId: "p1" } as unknown as CanvasEdge;
    expect(toEdgeInput(edge)).toEqual({ id: "e1", fromNodeId: "a", toNodeId: "b" });
  });

  test("collectNodeReferences 展开 group 成员并去重", () => {
    const target = { id: "t", type: "config" } as CanvasNode;
    const grp = { id: "g", type: "group" } as CanvasNode;
    const m1 = { id: "m1", type: "image", groupId: "g" } as CanvasNode;
    const m2 = { id: "m2", type: "text", groupId: "g" } as CanvasNode;
    const edges = [
      { id: "e1", fromNodeId: "g", toNodeId: "t" },
      { id: "e2", fromNodeId: "m1", toNodeId: "t" },
    ] as CanvasEdge[];
    const refs = collectNodeReferences(target, [target, grp, m1, m2], edges);
    expect(refs.map((r) => r.node.id)).toEqual(["m1", "m2"]);
    const map = buildInputsByNodeId([target, grp, m1, m2], edges);
    expect(map.get("t")?.map((n) => n.id)).toEqual(["m1", "m2"]);
  });

  test("computeCanvasBackgroundStyle 与 computeSelectionBoxRect", () => {
    expect(computeCanvasBackgroundStyle("blank", { x: 0, y: 0, zoom: 1 })).toEqual({
      backgroundImage: "none",
    });
    expect(
      computeSelectionBoxRect({
        startWorldX: 100,
        startWorldY: 80,
        currentWorldX: 40,
        currentWorldY: 120,
        additive: false,
        initialSelectedNodeIds: [],
      }),
    ).toEqual({ x: 40, y: 80, w: 60, h: 40 });
    const style = computeAnchoredPanelStyle({
      node: { x: 100, y: 50, width: 200, height: 100 } as CanvasNode,
      canvasSize: { width: 1200, height: 800 },
      viewport: { x: 0, y: 0, zoom: 1 },
      kbInset: 0,
      maxWidth: 620,
      maxHeightCap: "560px, 72vh",
      narrowMaxHeight: "min(62dvh, 560px)",
    });
    expect(style?.top).toBe(160);
  });

  test("pickNextProjectId 删除后选中下一个项目或回退到相邻/空", () => {
    const list = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
    expect(pickNextProjectId(list, "p1")).toBe("p2");
    expect(pickNextProjectId(list, "p2")).toBe("p3");
    expect(pickNextProjectId(list, "p3")).toBe("p2");
    expect(pickNextProjectId([{ id: "p1" }], "p1")).toBeNull();
    expect(pickNextProjectId(list, "missing")).toBe("p1");
  });
});
