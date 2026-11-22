// Runtime helpers over canvas nodes, moved out of types.ts (which
// keeps only type definitions and pure constant tables): node-kind
// guards, chip-token cleanup, and the canvas list's label / preview
// text.

import {
  SEQ_TYPE_LABEL,
  type CanvasNode,
  type NodeType,
  type ToolNodeType,
} from "./types";

/** Node types whose content counts as text when gathered as an input
 * (config context on the server mirrors this list). */
export function isTextSourceType(type: NodeType): boolean {
  return type === "text" || type === "config" || type === "sticky-note";
}
export function isToolNodeType(type: NodeType): type is ToolNodeType {
  return (
    type === "video-frames" ||
    type === "video-relay" ||
    type === "audio-extract" ||
    type === "video-compose" ||
    type === "prompt-reverse"
  );
}
/** Replace @[node:id] chip tokens with a readable @引用 marker. */
export function stripChipTokens(text: string): string {
  return text.replace(/@\[node:[^\]]+\]/g, "@引用");
}
/** The canvas list's row heading for a node. A numbered node reads
 * "#NN - 类型 - 名字" for the media generation kinds (image / video /
 * audio) and "#NN - 类型" for everything else (text, tools, config,
 * sticky notes) — those rows never show the node's own name. A legacy
 * node with no number (seq null, pre-numbering stock) keeps the
 * plain title it has always shown. */
export function nodeListLabel(node: CanvasNode): string {
  if (node.seq == null) return node.title;
  const num = `#${String(node.seq).padStart(2, "0")}`;
  const label = SEQ_TYPE_LABEL[node.type];
  if (node.type === "image" || node.type === "video" || node.type === "audio") {
    return `${num} - ${label} - ${node.title}`;
  }
  return `${num} - ${label}`;
}
export function nodePreviewText(node: CanvasNode): string {
  if (node.type === "config") return node.prompt || node.content || "";
  return node.content || node.prompt || "";
}
export function isMediaUrl(content: string): boolean {
  return (
    content.startsWith("data:image/") ||
    content.startsWith("http://") ||
    content.startsWith("https://")
  );
}

/** Real-time client preview of the continuation prompt that 视频接力 will send,
 * matching server-side buildVideoRelayPrompt semantics. Returns null when no
 * video node is connected yet. */
export function buildVideoRelayPreviewPrompt(
  node: CanvasNode,
  inputs: CanvasNode[],
): string | null {
  const video = inputs.find((n) => n.type === "video");
  if (!video) return null;
  const own = (node.prompt || node.content).trim();
  const textParts = inputs
    .filter((n) => isTextSourceType(n.type))
    .map((n) => (n.content || n.prompt).trim())
    .filter(Boolean);
  const user = [own, ...textParts].filter(Boolean).join("\n").trim();
  if (user) {
    return `紧接参考图（原视频尾帧）画面自然续接：${user}。保持人物外观、画风、光影与场景连贯一致。`;
  }
  return `紧接参考图（原视频尾帧）的画面构图、人物外观、光影色调与场景，顺畅自然地延续当前状态并继续演绎后续细微动作与镜头运动，保持画面连贯、节奏自然，不要重复前段已完成的动作，也不要突兀跳切。`;
}
