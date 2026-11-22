import type { ComponentProps, RefObject } from "react";
import { EXTENSION_ENTRIES } from "../app-helpers";
import type { NodeDraft } from "../types";
import { CanvasToolbar, type CanvasTool } from "./CanvasToolbar";

type ToolbarProps = ComponentProps<typeof CanvasToolbar>;

export function BottomToolbarSection(props: {
  keyboardUp: boolean;
  canvasTool: CanvasTool;
  multiSelectMode: boolean;
  setMultiSelectMode: (updater: (v: boolean) => boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  disabled: boolean;
  themeMode: ToolbarProps["themeMode"];
  backgroundMode: ToolbarProps["backgroundMode"];
  showMediaInfo: boolean;
  setCanvasTool: (t: CanvasTool) => void;
  undoGraph: () => void;
  redoGraph: () => void;
  focusSelection: () => void;
  addNodeOfType: (type: NodeDraft["type"]) => void;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  toolbarUploadRef: RefObject<HTMLInputElement | null>;
  onDeleteSelected: () => void;
  onClear: () => void;
  setThemeMode: ToolbarProps["onThemeModeChange"];
  setBackgroundMode: ToolbarProps["onBackgroundModeChange"];
  setShowMediaInfo: (v: boolean) => void;
  handleUploadFiles: (files: FileList | null) => Promise<void>;
  handleToolbarUpload: (files: FileList | null) => Promise<void>;
}) {
  const {
    keyboardUp,
    canvasTool,
    multiSelectMode,
    setMultiSelectMode,
    canUndo,
    canRedo,
    hasSelection,
    disabled,
    themeMode,
    backgroundMode,
    showMediaInfo,
    setCanvasTool,
    undoGraph,
    redoGraph,
    focusSelection,
    addNodeOfType,
    uploadInputRef,
    toolbarUploadRef,
    onDeleteSelected,
    onClear,
    setThemeMode,
    setBackgroundMode,
    setShowMediaInfo,
    handleUploadFiles,
    handleToolbarUpload,
  } = props;

  return (
    <>
      {!keyboardUp ? (
        <CanvasToolbar
          tool={canvasTool}
          multiSelect={multiSelectMode}
          onToggleMultiSelect={() => setMultiSelectMode((v) => !v)}
          canUndo={canUndo}
          canRedo={canRedo}
          hasSelection={hasSelection}
          disabled={disabled}
          extensionTypes={EXTENSION_ENTRIES}
          themeMode={themeMode}
          backgroundMode={backgroundMode}
          showMediaInfo={showMediaInfo}
          onToolChange={setCanvasTool}
          onUndo={undoGraph}
          onRedo={redoGraph}
          onFocusSelected={focusSelection}
          onAddNode={addNodeOfType}
          onUpload={() => uploadInputRef.current?.click()}
          onDeleteSelected={onDeleteSelected}
          onClear={onClear}
          onThemeModeChange={setThemeMode}
          onBackgroundModeChange={setBackgroundMode}
          onShowMediaInfoChange={setShowMediaInfo}
        />
      ) : null}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        aria-label="选择要上传的媒体文件"
        onChange={(e) => {
          void handleUploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={toolbarUploadRef}
        type="file"
        className="hidden"
        aria-label="选择替换节点的媒体文件"
        onChange={(e) => {
          void handleToolbarUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}
