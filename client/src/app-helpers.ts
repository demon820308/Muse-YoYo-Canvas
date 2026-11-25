import type { CanvasEdge, CanvasNode, ToolNodeType } from "./types";

export const EXTENSION_ENTRIES: {
  type: ToolNodeType | "sticky-note";
  label: string;
}[] = [
  { type: "video-frames", label: "视频抽帧" },
  { type: "video-relay", label: "视频接力" },
  { type: "video-compose", label: "视频配乐" },
  { type: "prompt-reverse", label: "逆推提示词" },
  { type: "audio-extract", label: "音频提取" },
  { type: "image-mask", label: "绘制蒙版" },
  { type: "sticky-note", label: "便签" },
];

export function toNodeInput(n: CanvasNode) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    content: n.content,
    prompt: n.prompt,
    status: n.status,
    hidden: n.hidden,
    groupId: n.groupId,
    color: n.color,
    freeResize: n.freeResize,
    fontSize: n.fontSize,
    genRatio: n.genRatio,
    genDuration: n.genDuration,
    genMode: n.genMode,
    // 仅作建议值（由服务端决定），用于撤销恢复时认回原编号
    seq: n.seq,
  };
}

export function toEdgeInput(e: CanvasEdge) {
  return { id: e.id, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId };
}
