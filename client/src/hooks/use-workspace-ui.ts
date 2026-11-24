import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import type { EditorDialogState, ProjectDialogState } from "../components/AppDialogs";
import type { CanvasNode } from "../types";
import { useAppearance } from "./use-appearance";
import { usePanelChrome } from "./use-panel-chrome";
import { useDismissOnOutside } from "./use-project-sync";

/** Manages workspace chrome, menus, dialogs, and toast notifications. */
export function useWorkspaceUi() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("yoyohua-bu-panel-width"));
      return saved >= 240 && saved <= 520 ? saved : 300;
    } catch {
      return 300;
    }
  });
  const [queueOpen, setQueueOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(projectMenuOpen, projectMenuRef, () => setProjectMenuOpen(false));
  const [projectSwitchOpen, setProjectSwitchOpen] = useState(false);
  const projectSwitchRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(projectSwitchOpen, projectSwitchRef, () => setProjectSwitchOpen(false));
  const [infoNode, setInfoNode] = useState<CanvasNode | null>(null);
  const [editorDialog, setEditorDialog] = useState<EditorDialogState>(null);
  const [panelFlash, setPanelFlash] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogState>(null);
  const [dialogName, setDialogName] = useState("");
  const [dialogDir, setDialogDir] = useState("");
  const [pickingDir, setPickingDir] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const chrome = usePanelChrome();
  const appearance = useAppearance();
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const saveAsAsset = useMutation({
    mutationFn: (node: CanvasNode) =>
      api.addAsset({
        projectId: node.projectId,
        kind: node.type,
        title: node.title,
        content: node.content,
        prompt: node.prompt,
        color: node.color,
        tags: [],
        sourceNodeId: node.id,
        mediaBlobKey: node.mediaBlobKey,
        mimeType: node.mimeType,
        filePath: node.filePath,
        posterBlobKey: node.posterBlobKey,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      showToast("已存为资产");
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : "存为资产失败");
    },
  });

  const openDialog = useCallback((d: NonNullable<ProjectDialogState>) => {
    setDialog(d);
    setDialogName(d.mode === "rename" ? d.name : "");
    setDialogDir(d.mode === "move-dir" ? d.currentDir : "");
  }, []);

  return {
    ...chrome,
    ...appearance,
    panelOpen,
    setPanelOpen,
    panelWidth,
    setPanelWidth,
    queueOpen,
    setQueueOpen,
    projectMenuOpen,
    setProjectMenuOpen,
    projectMenuRef,
    projectSwitchOpen,
    setProjectSwitchOpen,
    projectSwitchRef,
    infoNode,
    setInfoNode,
    editorDialog,
    setEditorDialog,
    panelFlash,
    setPanelFlash,
    uploading,
    setUploading,
    dialog,
    setDialog,
    dialogName,
    setDialogName,
    dialogDir,
    setDialogDir,
    pickingDir,
    setPickingDir,
    toast,
    showToast,
    clearConfirmOpen,
    setClearConfirmOpen,
    openDialog,
    saveAsAsset,
  };
}
