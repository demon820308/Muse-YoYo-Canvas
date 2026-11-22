import type { CSSProperties } from "react";
import { api } from "../api";
import type { NodeRunFeedback } from "./run-feedback";
import { AngleDialog, type AngleParams } from "./AngleDialog";
import { ConfigComposerDialog } from "./ConfigComposerDialog";
import { CropDialog, type CropRect } from "./CropDialog";
import { MaskDialog, type MaskPayload } from "./MaskDialog";
import { MediaPreviewDialog, type PreviewTarget } from "./MediaPreviewDialog";
import { NodeInfoModal } from "./NodeInfoModal";
import { SplitDialog, type SplitParams } from "./SplitDialog";
import { UpscaleDialog, type UpscaleParams } from "./UpscaleDialog";
import type { CanvasNode, ReferenceInfo } from "../types";

export type ProjectDialogState =
  | { mode: "create" }
  | { mode: "rename"; id: string; name: string }
  | { mode: "move-dir"; id: string; name: string; currentDir: string }
  | { mode: "delete"; id: string; name: string }
  | null;

export type EditorDialogState =
  | { kind: "crop" | "split" | "upscale" | "super" | "angle" | "mask"; node: CanvasNode }
  | null;

type MutationFlag = { isPending: boolean };

export function AppDialogs(props: {
  clearConfirmOpen: boolean;
  setClearConfirmOpen: (open: boolean) => void;
  clearCanvas: () => void;
  dialog: ProjectDialogState;
  setDialog: (d: ProjectDialogState) => void;
  dialogName: string;
  setDialogName: (v: string) => void;
  dialogDir: string;
  setDialogDir: (v: string) => void;
  pickingDir: boolean;
  setPickingDir: (v: boolean) => void;
  createProject: MutationFlag & { mutate: (args: { name: string; workspaceDir?: string }) => void };
  renameProject: MutationFlag & { mutate: (args: { id: string; name: string }) => void };
  moveProjectDir: MutationFlag & { mutate: (args: { projectId: string; workspaceDir: string }) => void };
  deleteProject: MutationFlag & { mutate: (id: string) => void };
  showToast: (msg: string) => void;
  previewTarget: PreviewTarget | null;
  setPreviewTarget: (t: PreviewTarget | null) => void;
  composerNode: CanvasNode | null;
  composerReferences: ReferenceInfo[];
  composerStyle: CSSProperties | undefined;
  runFeedback: Record<string, NodeRunFeedback | undefined>;
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  closeComposer: () => void;
  runGeneration: (node: CanvasNode) => void;
  infoNode: CanvasNode | null;
  setInfoNode: (n: CanvasNode | null) => void;
  editorDialog: EditorDialogState;
  setEditorDialog: (d: EditorDialogState) => void;
  onCropConfirm: (node: CanvasNode, rect: CropRect) => void;
  onSplitConfirm: (node: CanvasNode, params: SplitParams) => void;
  onUpscaleConfirm: (node: CanvasNode, params: UpscaleParams) => void;
  onAngleConfirm: (node: CanvasNode, params: AngleParams) => void;
  onMaskConfirm: (node: CanvasNode, payload: MaskPayload) => void;
  toast: string | null;
}) {
  const {
    clearConfirmOpen,
    setClearConfirmOpen,
    clearCanvas,
    dialog,
    setDialog,
    dialogName,
    setDialogName,
    dialogDir,
    setDialogDir,
    pickingDir,
    setPickingDir,
    createProject,
    renameProject,
    moveProjectDir,
    deleteProject,
    showToast,
    previewTarget,
    setPreviewTarget,
    composerNode,
    composerReferences,
    composerStyle,
    runFeedback,
    updateNode,
    closeComposer,
    runGeneration,
    infoNode,
    setInfoNode,
    editorDialog,
    setEditorDialog,
    onCropConfirm,
    onSplitConfirm,
    onUpscaleConfirm,
    onAngleConfirm,
    onMaskConfirm,
    toast,
  } = props;

  const pickDirectory = () => {
    setPickingDir(true);
    void api
      .pickProjectDirectory({})
      .then((res) => {
        if (res.path) setDialogDir(res.path);
      })
      .catch(() => showToast("无法打开目录选择器，请手动输入路径"))
      .finally(() => setPickingDir(false));
  };

  const submitNameDialog = () => {
    if (!dialog || (dialog.mode !== "create" && dialog.mode !== "rename") || !dialogName.trim()) return;
    if (dialog.mode === "create") {
      createProject.mutate({
        name: dialogName.trim(),
        workspaceDir: dialogDir.trim() || undefined,
      });
    } else {
      renameProject.mutate({ id: dialog.id, name: dialogName.trim() });
    }
  };

  return (
    <>
      {clearConfirmOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="清空画布"
          onClick={() => setClearConfirmOpen(false)}
        >
          <div className="w-full max-w-sm rounded-2xl bg-[var(--surface)] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">清空画布？</h3>
            <p className="mt-2 text-sm text-[var(--dim)]">
              当前项目的全部节点与连线会被删除。清空后可以点工具条的「撤销」恢复。
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={clearCanvas}
                className="rounded bg-[var(--danger)] px-3 py-2 text-sm font-medium text-white"
              >
                清空
              </button>
              <button
                type="button"
                onClick={() => setClearConfirmOpen(false)}
                className="rounded border border-[var(--border)] px-3 py-2 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={
            dialog.mode === "create"
              ? "新建项目"
              : dialog.mode === "rename"
                ? "重命名项目"
                : dialog.mode === "move-dir"
                  ? "更改项目目录"
                  : "删除项目"
          }
          onClick={() => setDialog(null)}
        >
          <div className="w-full max-w-sm rounded-2xl bg-[var(--surface)] p-5" onClick={(e) => e.stopPropagation()}>
            {dialog.mode === "delete" ? (
              <>
                <h3 className="text-base font-semibold">删除项目「{dialog.name}」？</h3>
                <p className="mt-2 text-sm text-[var(--dim)]">
                  项目里的全部节点与连线会一起删除，资产库与提示词库不受影响。此操作不可撤销。
                </p>
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => deleteProject.mutate(dialog.id)}
                    disabled={deleteProject.isPending}
                    className="rounded bg-[var(--danger)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setDialog(null)}
                    className="rounded border border-[var(--border)] px-3 py-2 text-sm"
                  >
                    取消
                  </button>
                </div>
              </>
            ) : dialog.mode === "move-dir" ? (
              <>
                <h3 className="text-base font-semibold">更改项目目录</h3>
                <p className="mt-1.5 text-xs text-[var(--dim)]">
                  将「{dialog.name}」的项目文件与资产迁移到新目录，并自动更新画布引用。
                </p>
                <div className="mt-3">
                  <label className="block text-xs text-[var(--dim)]">当前目录</label>
                  <div
                    className="mt-1 truncate rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--dim)]"
                    title={dialog.currentDir}
                  >
                    {dialog.currentDir || "默认目录"}
                  </div>
                </div>
                <div className="mt-3">
                  <label className="block text-xs text-[var(--dim)]">新项目目录</label>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      value={dialogDir}
                      onChange={(e) => setDialogDir(e.target.value)}
                      placeholder="例如 D:\Projects\my-video"
                      aria-label="新项目目录"
                      className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                    />
                    <button
                      type="button"
                      disabled={pickingDir || moveProjectDir.isPending}
                      onClick={pickDirectory}
                      className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs hover:bg-[var(--hover)] disabled:opacity-40"
                    >
                      {pickingDir ? "选择中…" : "选择目录"}
                    </button>
                  </div>
                </div>
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    disabled={
                      !dialogDir.trim() ||
                      dialogDir.trim() === dialog.currentDir ||
                      moveProjectDir.isPending
                    }
                    onClick={() =>
                      moveProjectDir.mutate({
                        projectId: dialog.id,
                        workspaceDir: dialogDir.trim(),
                      })
                    }
                    className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-40"
                  >
                    {moveProjectDir.isPending ? "迁移中…" : "确认迁移"}
                  </button>
                  <button
                    type="button"
                    disabled={moveProjectDir.isPending}
                    onClick={() => setDialog(null)}
                    className="rounded border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-40"
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-base font-semibold">
                  {dialog.mode === "create" ? "新建项目" : "重命名项目"}
                </h3>
                <input
                  value={dialogName}
                  onChange={(e) => setDialogName(e.target.value)}
                  placeholder="项目名称"
                  aria-label="项目名称"
                  autoFocus
                  className="mt-3 w-full rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNameDialog();
                  }}
                />
                {dialog.mode === "create" ? (
                  <div className="mt-3">
                    <label className="block text-xs text-[var(--dim)]">
                      项目目录（可选，留空使用默认目录）
                    </label>
                    <div className="mt-1.5 flex gap-2">
                      <input
                        value={dialogDir}
                        onChange={(e) => setDialogDir(e.target.value)}
                        placeholder="例如 D:\Projects\my-video"
                        aria-label="项目目录"
                        className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        type="button"
                        disabled={pickingDir}
                        onClick={pickDirectory}
                        className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs hover:bg-[var(--hover)] disabled:opacity-40"
                      >
                        {pickingDir ? "选择中…" : "选择目录"}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    disabled={!dialogName.trim() || createProject.isPending || renameProject.isPending}
                    onClick={submitNameDialog}
                    className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-40"
                  >
                    {dialog.mode === "create" ? "创建" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDialog(null)}
                    className="rounded border border-[var(--border)] px-3 py-2 text-sm"
                  >
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {previewTarget ? (
        <MediaPreviewDialog target={previewTarget} onClose={() => setPreviewTarget(null)} />
      ) : null}

      {composerNode && composerNode.type === "config" ? (
        <ConfigComposerDialog
          node={composerNode}
          references={composerReferences}
          style={composerStyle}
          feedback={runFeedback[composerNode.id]}
          onPatch={(patch) => updateNode(composerNode.id, patch)}
          onClose={closeComposer}
          onGenerate={() => {
            closeComposer();
            runGeneration(composerNode);
          }}
        />
      ) : null}

      {infoNode ? <NodeInfoModal node={infoNode} onClose={() => setInfoNode(null)} /> : null}

      {editorDialog?.kind === "crop" && editorDialog.node.mediaUrl ? (
        <CropDialog
          src={editorDialog.node.mediaUrl}
          title={editorDialog.node.title}
          onClose={() => setEditorDialog(null)}
          onConfirm={(rect) => onCropConfirm(editorDialog.node, rect)}
        />
      ) : null}
      {editorDialog?.kind === "split" && editorDialog.node.mediaUrl ? (
        <SplitDialog
          src={editorDialog.node.mediaUrl}
          title={editorDialog.node.title}
          onClose={() => setEditorDialog(null)}
          onConfirm={(params) => onSplitConfirm(editorDialog.node, params)}
        />
      ) : null}
      {(editorDialog?.kind === "upscale" || editorDialog?.kind === "super") && editorDialog.node.mediaUrl ? (
        <UpscaleDialog
          src={editorDialog.node.mediaUrl}
          title={editorDialog.node.title}
          superResolve={editorDialog.kind === "super"}
          onClose={() => setEditorDialog(null)}
          onConfirm={(params) => onUpscaleConfirm(editorDialog.node, params)}
        />
      ) : null}
      {editorDialog?.kind === "angle" && editorDialog.node.mediaUrl ? (
        <AngleDialog
          src={editorDialog.node.mediaUrl}
          title={editorDialog.node.title}
          onClose={() => setEditorDialog(null)}
          onConfirm={(params) => onAngleConfirm(editorDialog.node, params)}
        />
      ) : null}
      {editorDialog?.kind === "mask" && editorDialog.node.mediaUrl ? (
        <MaskDialog
          src={editorDialog.node.mediaUrl}
          title={editorDialog.node.title}
          onClose={() => setEditorDialog(null)}
          onConfirm={(payload) => onMaskConfirm(editorDialog.node, payload)}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-[95] -translate-x-1/2 rounded-full bg-[var(--surface-3)] px-4 py-2 text-sm shadow-xl"
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
