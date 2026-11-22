import {
  IconDownload,
  IconGroup,
  IconUngroup,
  NODE_TYPE_ICON,
} from "../icons";
import { ToolbarAction } from "./HoverToolbar";

// Multi-selection toolbar (upstream canvas-selection-toolbar.tsx)

export function SelectionToolbar({
  bounds,
  viewport,
  canGroup,
  canUngroup,
  canMergeVideos,
  canExportVideos,
  onGroup,
  onUngroup,
  onMergeVideos,
  onExportVideos,
}: {
  bounds: { left: number; top: number; right: number; bottom: number };
  viewport: { x: number; y: number; zoom: number };
  canGroup: boolean;
  canUngroup: boolean;
  canMergeVideos?: boolean;
  canExportVideos?: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  onMergeVideos?: () => void;
  onExportVideos?: () => void;
}) {
  if (!canGroup && !canUngroup && !canMergeVideos && !canExportVideos) return null;
  const VideoIcon = NODE_TYPE_ICON.video!;
  const pad = 14;
  const left = viewport.x + bounds.left * viewport.zoom - pad;
  const top = viewport.y + bounds.top * viewport.zoom - pad;
  const width = (bounds.right - bounds.left) * viewport.zoom + pad * 2;
  return (
    <div
      data-ui
      className="capsule-chrome absolute z-[70] flex h-11 -translate-x-1/2 -translate-y-full items-center rounded-full px-1.5 text-[var(--text)]"
      style={{ left: left + width / 2, top: top - 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="多选工具条"
    >
      {canGroup ? (
        <ToolbarAction
          id="group"
          title="把所选节点打成一"
          label="打组"
          icon={<IconGroup size={16} />}
          onClick={onGroup}
          showLabel
        />
      ) : null}
      {canUngroup ? (
        <ToolbarAction
          id="ungroup"
          title="解散所选分"
          label="解散"
          icon={<IconUngroup size={16} />}
          onClick={onUngroup}
          showLabel
        />
      ) : null}
      {canMergeVideos && onMergeVideos ? (
        <ToolbarAction
          id="merge-videos"
          title="把所选视频按顺序合并为一个新视频"
          label="合并视频"
          icon={<VideoIcon size={16} />}
          onClick={onMergeVideos}
          showLabel
        />
      ) : null}
      {canExportVideos && onExportVideos ? (
        <ToolbarAction
          id="export-videos"
          title="导出所选视频文"
          label="导出视频"
          icon={<IconDownload size={16} />}
          onClick={onExportVideos}
          showLabel
        />
      ) : null}
    </div>
  );
}
