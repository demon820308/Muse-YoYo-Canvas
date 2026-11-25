import { describe, expect, test } from "bun:test";
import {
  buildMaskEditPrompt,
  classifyMaskInputs,
  closestImageRatio,
  DEFAULT_MASK_NODE_STYLE,
  fillAlphaHoles,
  getMaskColor,
  maskCardSizeForSource,
  normalizeMaskNodeStyle,
  parseMaskNodeStateJson,
  resolveEffectiveMaskMode,
  resolveMaskSourceRatio,
} from "../components/mask-helpers";
import type { CanvasEdge, CanvasNode, ReferenceInfo } from "../types";

describe("mask-helpers", () => {
  test("closestImageRatio picks nearest canonical tier", () => {
    expect(closestImageRatio(1080, 1440)).toBe("3:4");
    expect(closestImageRatio(1920, 1080)).toBe("16:9");
    expect(closestImageRatio(1000, 1000)).toBe("1:1");
    expect(closestImageRatio(2352, 1008)).toBe("21:9");
    expect(closestImageRatio(0, 100)).toBe("1:1");
  });

  test("fillAlphaHoles fills enclosed interior holes while preserving exterior", () => {
    const w = 5;
    const h = 5;
    const closed = new Uint8Array(w * h);
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) {
        if (x === 2 && y === 2) continue;
        closed[y * w + x] = 255;
      }
    }
    const filled = fillAlphaHoles(closed, w, h);
    expect(filled[2 * w + 2]).toBe(255);
    expect(filled[0]).toBe(0);

    closed[1 * w + 2] = 0;
    const open = fillAlphaHoles(closed, w, h);
    expect(open[2 * w + 2]).toBe(0);
  });

  test("parseMaskNodeStateJson parses stored style or falls back safely", () => {
    const fallback = parseMaskNodeStateJson("invalid");
    expect(fallback.colorKey).toBe("red");
    expect(fallback.opacity).toBe(50);
    expect(fallback.outputMode).toBe("original");

    const parsed = parseMaskNodeStateJson(
      JSON.stringify({
        colorKey: "red",
        opacity: 70,
        inverted: true,
        fillHoles: true,
        outputMode: "color",
      }),
    );
    expect(parsed.colorKey).toBe("red");
    expect(parsed.opacity).toBe(70);
    expect(parsed.inverted).toBe(true);
    expect(parsed.fillHoles).toBe(true);
    expect(parsed.outputMode).toBe("color");
  });

  test("buildMaskEditPrompt formats image roles per mode", () => {
    const removeAuto = buildMaskEditPrompt({
      mode: "remove",
      colorLabel: "红色",
      userPrompt: "",
      hasRefImage: false,
      hasSeparateBaseImage: true,
    });
    expect(removeAuto).toContain("图1为原始底图");
    expect(removeAuto).toContain("半透明红色高亮标出了需要修改的区域");
    expect(removeAuto).toContain("彻底移除");
    expect(removeAuto).toContain("不要凭空生成无关新物体");

    const outfitWithRef = buildMaskEditPrompt({
      mode: "outfit",
      colorLabel: "绿色",
      userPrompt: "注意领口自然",
      hasRefImage: true,
      hasSeparateBaseImage: true,
    });
    expect(outfitWithRef).toContain("图3为目标参考图");
    expect(outfitWithRef).toContain("仅提取并迁移图3中的服装/配饰款式");
    expect(outfitWithRef).toContain("严禁改变或替换为图3的人物长相与身材");
    expect(outfitWithRef).toContain("注意领口自然");

    const faceWithRef = buildMaskEditPrompt({
      mode: "face",
      colorLabel: "绿色",
      userPrompt: "",
      hasRefImage: true,
      hasSeparateBaseImage: true,
    });
    expect(faceWithRef).toContain("替换为图3中人物的五官长相、眉眼鼻唇结构与身份特征");
    expect(faceWithRef).toContain("发际线/颈部肤色边缘过渡");

    const multiRefCustom = buildMaskEditPrompt({
      mode: "custom",
      colorLabel: "绿色",
      userPrompt: "把帽子戴上",
      hasRefImage: true,
      refCount: 2,
      hasSeparateBaseImage: true,
    });
    expect(multiRefCustom).toContain("图3～图4为目标参考图");
    expect(multiRefCustom).toContain("结合图3～图4的视觉特征");
  });

  test("classifyMaskInputs resolves auto upstream base image and extra ref images", () => {
    const baseNode = {
      id: "img-base",
      type: "image",
      mediaUrl: "/media/base",
    } as unknown as CanvasNode;
    const maskNode = {
      id: "mask-1",
      type: "image-mask",
      mediaUrl: "/media/mask",
    } as unknown as CanvasNode;
    const outfitNode = {
      id: "img-outfit",
      type: "image",
      mediaUrl: "/media/outfit",
    } as unknown as CanvasNode;

    const edges: CanvasEdge[] = [
      { id: "e1", projectId: "p1", fromNodeId: "img-base", toNodeId: "mask-1" },
      { id: "e2", projectId: "p1", fromNodeId: "mask-1", toNodeId: "gen-1" },
      { id: "e3", projectId: "p1", fromNodeId: "img-outfit", toNodeId: "gen-1" },
    ];
    const refs: ReferenceInfo[] = [
      { edgeId: "e2", node: maskNode },
      { edgeId: "e3", node: outfitNode },
    ];
    const classified = classifyMaskInputs(refs, [baseNode, maskNode, outfitNode], edges);
    expect(classified.maskRef?.node.id).toBe("mask-1");
    expect(classified.autoBaseNode?.id).toBe("img-base");
    expect(classified.extraImageRefs.map((r) => r.node.id)).toEqual(["img-outfit"]);

    const withoutMask = classifyMaskInputs(
      [{ edgeId: "e3", node: outfitNode }],
      [baseNode, maskNode, outfitNode],
      edges,
    );
    expect(withoutMask.maskRef).toBeNull();

    // Extra reference wired directly into the mask node (plus deduplication if wired to both)
    const upstreamRefEdges: CanvasEdge[] = [
      { id: "e1", projectId: "p1", fromNodeId: "img-base", toNodeId: "mask-1" },
      { id: "e4", projectId: "p1", fromNodeId: "img-outfit", toNodeId: "mask-1" },
      { id: "e2", projectId: "p1", fromNodeId: "mask-1", toNodeId: "gen-1" },
    ];
    const fromMaskOnly = classifyMaskInputs(
      [{ edgeId: "e2", node: maskNode }],
      [baseNode, maskNode, outfitNode],
      upstreamRefEdges,
    );
    expect(fromMaskOnly.autoBaseNode?.id).toBe("img-base");
    expect(fromMaskOnly.extraImageRefs.map((r) => r.node.id)).toEqual(["img-outfit"]);
    expect(fromMaskOnly.upstreamExtraRefs.map((r) => r.node.id)).toEqual(["img-outfit"]);

    const dedupBoth = classifyMaskInputs(
      [
        { edgeId: "e2", node: maskNode },
        { edgeId: "e3", node: outfitNode },
      ],
      [baseNode, maskNode, outfitNode],
      upstreamRefEdges,
    );
    expect(dedupBoth.extraImageRefs.map((r) => r.node.id)).toEqual(["img-outfit"]);
    expect(dedupBoth.upstreamExtraRefs).toEqual([]);
  });

  test("resolveEffectiveMaskMode infers custom when ref image or prompt exists without explicit mode", () => {
    expect(
      resolveEffectiveMaskMode({ explicitMode: null, hasRefImage: true, hasUserPrompt: false }),
    ).toBe("custom");
    expect(
      resolveEffectiveMaskMode({ explicitMode: null, hasRefImage: false, hasUserPrompt: true }),
    ).toBe("custom");
    expect(
      resolveEffectiveMaskMode({ explicitMode: null, hasRefImage: false, hasUserPrompt: false }),
    ).toBe("remove");
    expect(
      resolveEffectiveMaskMode({ explicitMode: "remove", hasRefImage: true, hasUserPrompt: true }),
    ).toBe("remove");
  });

  test("resolveMaskSourceRatio prefers original image probed genSize over upload 1:1 default", () => {
    const base = {
      id: "img-base",
      type: "image",
      genRatio: "1:1",
      genSize: "1080x1440",
      width: 240,
      height: 190,
    } as unknown as CanvasNode;
    const mask = {
      id: "mask-1",
      type: "image-mask",
      genSize: null,
    } as unknown as CanvasNode;
    const edges: CanvasEdge[] = [
      { id: "e1", projectId: "p1", fromNodeId: "img-base", toNodeId: "mask-1" },
    ];
    expect(resolveMaskSourceRatio(mask, [base, mask], edges)).toBe("3:4");
  });

  test("maskCardSizeForSource matches portrait, landscape, and square image proportions", () => {
    const portrait = maskCardSizeForSource({
      genSize: "1152x2048",
      genRatio: "1:1",
      width: 175,
      height: 320,
    });
    expect(portrait).toEqual({ width: 187, height: 360 });

    const landscape = maskCardSizeForSource({
      genSize: "2048x1152",
      genRatio: "16:9",
      width: 320,
      height: 205,
    });
    expect(landscape).toEqual({ width: 360, height: 256 });

    const fallbackRatio = maskCardSizeForSource({
      genSize: null,
      genRatio: "1:1",
      width: 240,
      height: 190,
    });
    expect(fallbackRatio).toEqual({ width: 360, height: 404 });
  });

  test("normalizeMaskNodeStyle and getMaskColor share consistent defaults and restore brushColor", () => {
    expect(normalizeMaskNodeStyle(null)).toEqual(DEFAULT_MASK_NODE_STYLE);
    expect(normalizeMaskNodeStyle({ brushColor: "white" }).brushColor).toBe("white");
    expect(normalizeMaskNodeStyle({ brushColor: "black" }).outputMode).toBe("original");
    expect(getMaskColor("unknown" as never).key).toBe(DEFAULT_MASK_NODE_STYLE.colorKey);

    const opaquePrompt = buildMaskEditPrompt({
      mode: "remove",
      colorLabel: "红色",
      userPrompt: "",
      hasRefImage: false,
      hasSeparateBaseImage: false,
      opacity: 100,
    });
    expect(opaquePrompt).toContain("用红色高亮标出");
    expect(opaquePrompt).not.toContain("半透明");
  });
});
