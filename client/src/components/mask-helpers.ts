import {
  buildMaskEditPrompt,
  DEFAULT_MASK_NODE_STYLE,
  getMaskColor,
  getMaskEditModeMeta,
  MASK_COLORS,
  MASK_EDIT_MODES,
  normalizeMaskNodeStyle,
  parseMaskNodeStateJson,
  resolveEffectiveMaskMode,
  type MaskColorKey,
  type MaskEditMode,
  type MaskNodeStyleState,
} from "@space/server/actions/mask-prompt";
import { IMAGE_RATIOS, type CanvasEdge, type CanvasNode, type ReferenceInfo } from "../types";

export {
  buildMaskEditPrompt,
  DEFAULT_MASK_NODE_STYLE,
  getMaskColor,
  getMaskEditModeMeta,
  MASK_COLORS,
  MASK_EDIT_MODES,
  normalizeMaskNodeStyle,
  parseMaskNodeStateJson,
  resolveEffectiveMaskMode,
  type MaskColorKey,
  type MaskEditMode,
  type MaskNodeStyleState,
};

/** Picks the closest supported ratio tier from IMAGE_RATIOS using
 * multiplicative log-ratio distance (matching server ratios.ts). */
export function closestImageRatio(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "1:1";
  const targetLog = Math.log(width / height);
  let best: string = "1:1";
  let bestDist = Infinity;
  for (const item of IMAGE_RATIOS) {
    const parts = item.ratio.split(":");
    const rw = Number(parts[0] ?? 0);
    const rh = Number(parts[1] ?? 0);
    if (!(rw > 0 && rh > 0)) continue;
    const dist = Math.abs(targetLog - Math.log(rw / rh));
    if (dist < bestDist) {
      bestDist = dist;
      best = item.ratio;
    }
  }
  return best;
}

/** Fills enclosed transparent holes inside painted regions by flood-filling
 * transparent pixels reachable from image borders (Goohai-style autoFillHoles). */
export function fillAlphaHoles(
  alpha: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const total = width * height;
  const out = new Uint8Array(total);
  if (total === 0 || alpha.length < total) return out;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const pushIfOutside = (idx: number) => {
    if (visited[idx] || (alpha[idx] ?? 0) > 5) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < width; x++) {
    pushIfOutside(x);
    pushIfOutside((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    pushIfOutside(y * width);
    pushIfOutside(y * width + (width - 1));
  }

  while (head < tail) {
    const idx = queue[head++] ?? 0;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) pushIfOutside(idx - 1);
    if (x + 1 < width) pushIfOutside(idx + 1);
    if (y > 0) pushIfOutside(idx - width);
    if (y + 1 < height) pushIfOutside(idx + width);
  }

  for (let i = 0; i < total; i++) {
    out[i] = (alpha[i] ?? 0) > 5 || !visited[i] ? 255 : 0;
  }
  return out;
}

const maskModeKey = (nodeId: string) => `yoyo:node-mask-mode:v1:${nodeId}`;

/** Returns the mode the user explicitly selected for this node, or `null`
 * if none was saved yet (so callers can infer the best mode from inputs). */
export function readExplicitNodeMaskMode(nodeId: string): MaskEditMode | null {
  try {
    const raw = window.localStorage.getItem(maskModeKey(nodeId));
    if (MASK_EDIT_MODES.some((m) => m.mode === raw)) {
      return raw as MaskEditMode;
    }
  } catch {
    // ignore storage failures
  }
  return null;
}

export function writeNodeMaskMode(nodeId: string, mode: MaskEditMode) {
  try {
    window.localStorage.setItem(maskModeKey(nodeId), mode);
  } catch {
    // ignore storage failures
  }
}

export type ClassifiedMaskInputs = {
  maskRef: ReferenceInfo | null;
  autoBaseNode: CanvasNode | null;
  directBaseRef: ReferenceInfo | null;
  extraImageRefs: ReferenceInfo[];
  /** Extra reference images wired into `image-mask` directly (not via a direct edge on the gen node). */
  upstreamExtraRefs: ReferenceInfo[];
};

/** Shared classification given the generation node's direct `references` and
 * the `image-mask` node's upstream input nodes (from either `edges` or `inputsByNodeId`). */
export function classifyMaskFromUpstreams(
  references: readonly ReferenceInfo[],
  maskUpstreams: readonly CanvasNode[],
  edgeIdByFromNodeId?: ReadonlyMap<string, string>,
): ClassifiedMaskInputs {
  const maskRef = references.find((r) => r.node.type === "image-mask") ?? null;
  if (!maskRef) {
    return {
      maskRef: null,
      autoBaseNode: null,
      directBaseRef: null,
      extraImageRefs: [],
      upstreamExtraRefs: [],
    };
  }
  const upstreamImages = maskUpstreams.filter(
    (u) => u.type === "image" && Boolean(u.mediaUrl),
  );
  const upstreamBase = upstreamImages[0] ?? null;
  const imageRefs = references.filter((r) => r.node.type === "image");
  const directBaseRef = upstreamBase
    ? imageRefs.find((r) => r.node.id === upstreamBase.id) ?? null
    : imageRefs[0] ?? null;
  const autoBaseNode = directBaseRef ? null : upstreamBase;
  const baseId = directBaseRef?.node.id ?? autoBaseNode?.id ?? null;

  const extraImageRefs: ReferenceInfo[] = [];
  const upstreamExtraRefs: ReferenceInfo[] = [];
  const seenIds = new Set<string>([
    maskRef.node.id,
    ...(baseId ? [baseId] : []),
  ]);
  const directIdSet = new Set(imageRefs.map((r) => r.node.id));
  for (const u of upstreamImages.slice(1)) {
    if (seenIds.has(u.id)) continue;
    seenIds.add(u.id);
    const ref: ReferenceInfo = directIdSet.has(u.id)
      ? imageRefs.find((r) => r.node.id === u.id)!
      : { edgeId: edgeIdByFromNodeId?.get(u.id) ?? "", node: u };
    extraImageRefs.push(ref);
    if (!directIdSet.has(u.id)) upstreamExtraRefs.push(ref);
  }
  for (const ref of imageRefs) {
    if (seenIds.has(ref.node.id)) continue;
    seenIds.add(ref.node.id);
    extraImageRefs.push(ref);
  }
  return {
    maskRef,
    autoBaseNode,
    directBaseRef,
    extraImageRefs,
    upstreamExtraRefs,
  };
}

/** Inspects connected references of a generation node and locates any connected
 * `image-mask` tool node, its upstream original image, and extra style/face refs
 * connected either to the `image-mask` node or directly to the generation node. */
export function classifyMaskInputs(
  references: readonly ReferenceInfo[],
  allNodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): ClassifiedMaskInputs {
  const maskRef = references.find((r) => r.node.type === "image-mask") ?? null;
  if (!maskRef) {
    return classifyMaskFromUpstreams(references, []);
  }
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const upstreams: CanvasNode[] = [];
  const edgeIdByFromNodeId = new Map<string, string>();
  const seen = new Set<string>();
  const pushNode = (node: CanvasNode, edgeId: string) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    upstreams.push(node);
    edgeIdByFromNodeId.set(node.id, edgeId);
  };
  for (const e of edges) {
    if (e.toNodeId !== maskRef.node.id) continue;
    const src = byId.get(e.fromNodeId);
    if (!src) continue;
    if (src.type === "group") {
      for (const m of allNodes) {
        if (m.groupId === src.id && m.type !== "group") {
          pushNode(m, e.id);
        }
      }
    } else {
      pushNode(src, e.id);
    }
  }
  return classifyMaskFromUpstreams(references, upstreams, edgeIdByFromNodeId);
}

export function parseGenSize(
  genSize: string | null | undefined,
): { w: number; h: number } | null {
  const m = String(genSize || "").match(
    /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i,
  );
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Resolves the closest canonical ratio for a mask's original image, preferring
 * the probed pixel size (`genSize`) over upload's default `1:1` `genRatio`. */
export function resolveMaskSourceRatio(
  maskNode: CanvasNode,
  allNodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): string | null {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.toNodeId !== maskNode.id) continue;
    const src = byId.get(e.fromNodeId);
    if (!src || src.type !== "image") continue;
    const parsed = parseGenSize(src.genSize);
    if (parsed) return closestImageRatio(parsed.w, parsed.h);
    if (src.genRatio) return src.genRatio;
    if (src.width > 0 && src.height > 0) {
      return closestImageRatio(src.width, src.height);
    }
  }
  const maskParsed = parseGenSize(maskNode.genSize);
  if (maskParsed) return closestImageRatio(maskParsed.w, maskParsed.h);
  return null;
}

const MASK_CHROME_W = 22;
const MASK_CHROME_H = 66;
const MASK_CARD_BASE = 360;

/** Computes `image-mask` card dimensions whose inner preview area matches
 * `w:h` (compensating for the card header and tool bar chrome). */
export function maskCardSizeForAspect(
  w: number,
  h: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  if (w >= h) {
    return {
      width: MASK_CARD_BASE,
      height: Math.max(
        160,
        Math.round(MASK_CHROME_H + ((MASK_CARD_BASE - MASK_CHROME_W) * h) / w),
      ),
    };
  }
  return {
    width: Math.max(
      180,
      Math.round(MASK_CHROME_W + ((MASK_CARD_BASE - MASK_CHROME_H) * w) / h),
    ),
    height: MASK_CARD_BASE,
  };
}

/** Computes `image-mask` card dimensions matching an upstream original image's
 * aspect ratio (preferring measured `genSize`, then `genRatio`, then card box). */
export function maskCardSizeForSource(
  source:
    | Pick<CanvasNode, "genSize" | "genRatio" | "width" | "height">
    | null
    | undefined,
): { width: number; height: number } | null {
  if (!source) return null;
  const parsed = parseGenSize(source.genSize);
  if (parsed) return maskCardSizeForAspect(parsed.w, parsed.h);
  const ratioRaw = source.genRatio === "auto" ? "16:9" : source.genRatio;
  if (ratioRaw) {
    const rm = /^(\d+(?:\.\d+)?)\s*[:xX/]\s*(\d+(?:\.\d+)?)$/.exec(
      ratioRaw.trim(),
    );
    if (rm) {
      const sized = maskCardSizeForAspect(Number(rm[1]), Number(rm[2]));
      if (sized) return sized;
    }
  }
  if (source.width > 14 && source.height > 33) {
    return maskCardSizeForAspect(source.width - 14, source.height - 33);
  }
  if (source.width > 0 && source.height > 0) {
    return maskCardSizeForAspect(source.width, source.height);
  }
  return null;
}
