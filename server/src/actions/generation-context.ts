// generation-context.ts — 生成输入收集（collectInputs）与生成
// 上下文组装（buildGenerationContext）：连入节点展开、@ 引用编号
// 与提示词拼装。

import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import type { Db, NodeRow } from "./contracts";
import {
  buildMaskEditPrompt,
  getMaskColor,
  parseMaskNodeStateJson,
  type MaskEditMode,
} from "./mask-prompt";

export interface GenResource {
  nodeId: string;
  type: "text" | "image" | "video" | "audio";
  title: string;
  text: string;
  filePath: string | null;
  hasMedia: boolean;
  isMask?: boolean;
  maskStyleJson?: string;
}

export interface GenContext {
  prompt: string;
  refs: GenResource[];
  imageRefs: GenResource[];
}

export async function collectInputs(db: Db, node: NodeRow): Promise<NodeRow[]> {
  const inEdges = await db
    .select({ fromNodeId: schema.canvasEdges.fromNodeId })
    .from(schema.canvasEdges)
    .where(
      and(
        eq(schema.canvasEdges.projectId, node.projectId),
        eq(schema.canvasEdges.toNodeId, node.id),
      ),
    )
    .orderBy(asc(schema.canvasEdges.sortOrder), asc(schema.canvasEdges.createdAt));
  if (inEdges.length === 0) return [];
  const ids = [...new Set(inEdges.map((e) => e.fromNodeId))];
  const rows = await db
    .select()
    .from(schema.canvasNodes)
    .where(inArray(schema.canvasNodes.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((r): r is NodeRow => Boolean(r) && r!.id !== node.id);
  const flattened: NodeRow[] = [];
  for (const row of ordered) {
    if (row.type === "group") {
      const members = await db
        .select()
        .from(schema.canvasNodes)
        .where(
          and(
            eq(schema.canvasNodes.projectId, node.projectId),
            eq(schema.canvasNodes.groupId, row.id),
          ),
        )
        .orderBy(asc(schema.canvasNodes.sortOrder), asc(schema.canvasNodes.createdAt));
      flattened.push(...members.filter((m) => m.type !== "group"));
    } else {
      flattened.push(row);
    }
  }
  const seen = new Set<string>();
  return flattened.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

export function toResource(row: NodeRow): GenResource | null {
  if (
    row.type === "image" ||
    row.type === "image-mask" ||
    row.type === "video" ||
    row.type === "audio"
  ) {
    if (!row.mediaBlobKey) return null;
    return {
      nodeId: row.id,
      type: row.type === "image-mask" ? "image" : row.type,
      title: row.title,
      text: "",
      filePath: row.filePath,
      hasMedia: true,
      isMask: row.type === "image-mask",
      maskStyleJson: row.type === "image-mask" ? row.prompt : undefined,
    };
  }
  if (
    row.type === "text" ||
    row.type === "config" ||
    row.type === "sticky-note"
  ) {
    const text = (row.content || row.prompt || "").trim();
    return text
      ? {
          nodeId: row.id,
          type: "text" as const,
          title: row.title,
          text,
          filePath: null,
          hasMedia: false,
        }
      : null;
  }
  return null;
}

export const REF_LABEL_PREFIX: Record<GenResource["type"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
};

export async function buildGenerationContext(
  db: Db,
  node: NodeRow,
  rawPrompt: string,
): Promise<GenContext> {
  const inputs = await collectInputs(db, node);
  const resources = inputs
    .map(toResource)
    .filter((r): r is GenResource => r !== null);
  const byId = new Map(resources.map((r) => [r.nodeId, r]));
  const hasChips = /@\[node:[^\]]+\]/.test(rawPrompt);
  if (!hasChips) {
    const textBlocks: string[] = [];
    for (const r of resources) {
      if (r.type === "text") {
        textBlocks.push(`\n${r.text}`);
      }
    }
    const prompt = textBlocks.length
      ? `${rawPrompt.trim()}\n\n${textBlocks.join("\n\n")}`.trim()
      : rawPrompt.trim();
    return {
      prompt,
      refs: resources,
      imageRefs: resources.filter((r) => r.type === "image"),
    };
  }
  const counts: Record<GenResource["type"], number> = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
  };
  const labelByNodeId = new Map<string, string>();
  const selected: GenResource[] = [];
  const textBlocks: string[] = [];
  const labelFor = (r: GenResource): string => {
    const existing = labelByNodeId.get(r.nodeId);
    if (existing) return existing;
    counts[r.type] += 1;
    const label = `${REF_LABEL_PREFIX[r.type]}${counts[r.type]}`;
    labelByNodeId.set(r.nodeId, label);
    if (r.type === "text") textBlocks.push(`\n${r.text}`);
    else selected.push(r);
    return label;
  };
  const expanded = rawPrompt.replace(/@\[node:([^\]]+)\]/g, (_m, id: string) => {
    const r = byId.get(id);
    if (!r) return "";
    const label = labelFor(r);
    return r.type === "text" ? `` : label;
  });
  const prompt = textBlocks.length
    ? `${expanded.trim()}\n\n${textBlocks.join("\n\n")}`.trim()
    : expanded.trim();
  const refs = [
    ...selected,
    ...resources.filter((r) => r.type === "text" && labelByNodeId.has(r.nodeId)),
  ];
  return { prompt, refs, imageRefs: selected.filter((r) => r.type === "image") };
}

/** Resolves upstream base images and wraps the prompt when an `image-mask`
 * node is connected into an image-generation node. */
export async function resolveMaskGenerationContext(
  db: Db,
  node: NodeRow,
  context: GenContext,
  maskMode?: MaskEditMode,
): Promise<{ context: GenContext; maskError: string | null }> {
  const inputs = await collectInputs(db, node);
  const maskRow = inputs.find((r) => r.type === "image-mask");
  if (!maskRow) return { context, maskError: null };
  if (!maskRow.mediaBlobKey || !maskRow.filePath) {
    return {
      context,
      maskError: "连入的蒙版节点尚未绘制蒙版，请先在蒙版节点上点击「绘制蒙版」",
    };
  }
  const maskInputs = await collectInputs(db, maskRow);
  const upstreamBaseRow = maskInputs.find(
    (u) => u.type === "image" && Boolean(u.mediaBlobKey),
  );
  const maskRes =
    context.imageRefs.find((r) => r.nodeId === maskRow.id) ??
    toResource(maskRow);
  let baseRes: GenResource | null = upstreamBaseRow
    ? context.imageRefs.find((r) => r.nodeId === upstreamBaseRow.id) ??
      toResource(upstreamBaseRow)
    : null;
  if (!baseRes) {
    baseRes =
      context.imageRefs.find((r) => r.nodeId !== maskRow.id && !r.isMask) ?? null;
  }
  const extraImageRefs = context.imageRefs.filter(
    (r) => r.nodeId !== maskRow.id && r.nodeId !== baseRes?.nodeId,
  );
  const orderedImageRefs = [
    ...(baseRes ? [baseRes] : []),
    ...(maskRes ? [maskRes] : []),
    ...extraImageRefs,
  ];
  const style = parseMaskNodeStateJson(maskRow.prompt);
  const colorLabel =
    style.outputMode === "original"
      ? style.brushColor === "white"
        ? "白色"
        : style.brushColor === "black"
          ? "黑色"
          : "绿色"
      : getMaskColor(style.colorKey).label;
  const wrappedPrompt = buildMaskEditPrompt({
    mode: maskMode ?? "custom",
    colorLabel,
    userPrompt: context.prompt,
    hasRefImage: extraImageRefs.length > 0,
    hasSeparateBaseImage: Boolean(baseRes),
  });
  const nonImageRefs = context.refs.filter((r) => r.type !== "image");
  return {
    context: {
      prompt: wrappedPrompt,
      refs: [...orderedImageRefs, ...nonImageRefs],
      imageRefs: orderedImageRefs,
    },
    maskError: null,
  };
}
