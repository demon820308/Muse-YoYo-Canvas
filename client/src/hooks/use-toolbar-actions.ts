import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api } from "../api";
import type { AngleParams } from "../components/AngleDialog";
import type { EditorDialogState } from "../components/AppDialogs";
import type { CropRect } from "../components/CropDialog";
import { downloadMediaFile } from "../components/download-media";
import type { ToolbarHandlers } from "../components/HoverToolbar";
import type { MaskPayload } from "../components/MaskDialog";
import type { SplitParams } from "../components/SplitDialog";
import type { UpscaleParams } from "../components/UpscaleDialog";
import { isToolNodeType } from "../node-utils";
import { NODE_TYPE_LABEL, type CanvasEdge, type CanvasNode, type NodeDraft } from "../types";
import { newId, NODE_DEFAULTS } from "./use-node-ops";

export function useToolbarActions(opts: {
  projectIdRef: MutableRefObject<string | null>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  edgesRef: MutableRefObject<CanvasEdge[]>;
  inFlightRunsRef: MutableRefObject<Set<string>>;
  toolbarUploadRef: RefObject<HTMLInputElement | null>;
  toolbarUploadTargetRef: MutableRefObject<string | null>;
  detailEditorRef: RefObject<HTMLDivElement | null>;
  queryClient: QueryClient;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setInfoNode: (n: CanvasNode | null) => void;
  setEditorDialog: (d: EditorDialogState) => void;
  setPanelFlash: (v: boolean) => void;
  setGenBusyId: (id: string | null) => void;
  setDirectGenId: (id: string | null) => void;
  showToast: (msg: string) => void;
  updateSelectedIds: (next: Set<string>) => void;
  deleteNodes: (ids: Set<string>) => void;
  ungroupSelection: () => void;
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  buildNode: (draft: NodeDraft) => CanvasNode | null;
  applyGraph: (nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => void;
  createGeneratorNode: (
    source: CanvasNode,
    prompt: string,
    title: string,
    extraRefs?: CanvasNode[],
  ) => CanvasNode | null;
  flushSave: () => Promise<void>;
  refreshGraphFromServer: () => Promise<void>;
  openNodePreview: (node: CanvasNode) => void;
  runTool: (node: CanvasNode) => Promise<void>;
  runGeneration: (node: CanvasNode) => Promise<void>;
  saveAsAssetMutate: (node: CanvasNode) => void;
  beginRunFeedback: (nodeId: string, label: string) => void;
  settleRunFeedback: (nodeId: string, status: "done" | "failed") => void;
}) {
  const {
    projectIdRef,
    nodesRef,
    edgesRef,
    inFlightRunsRef,
    toolbarUploadRef,
    toolbarUploadTargetRef,
    detailEditorRef,
    queryClient,
    setNodes,
    setInfoNode,
    setEditorDialog,
    setPanelFlash,
    setGenBusyId,
    setDirectGenId,
    showToast,
    updateSelectedIds,
    deleteNodes,
    ungroupSelection,
    updateNode,
    buildNode,
    applyGraph,
    createGeneratorNode,
    flushSave,
    refreshGraphFromServer,
    openNodePreview,
    runTool,
    runGeneration,
    saveAsAssetMutate,
    beginRunFeedback,
    settleRunFeedback,
  } = opts;

  const runEditorOp = useCallback(
    async <T extends { status: string; error?: string | null }>(
      node: CanvasNode,
      label: string,
      task: () => Promise<T>,
      onDone: (res: T) => string,
    ) => {
      setEditorDialog(null);
      setGenBusyId(node.id);
      try {
        const res = await task();
        if (res.status === "done") showToast(onDone(res));
        else showToast(`${label}失败：${res.error ?? "未知原因"}`);
      } catch {
        showToast(`${label}请求失败，请稍后重试`);
      } finally {
        setGenBusyId(null);
        void refreshGraphFromServer();
      }
    },
    [refreshGraphFromServer, setEditorDialog, setGenBusyId, showToast],
  );

  const toolbarHandlers: ToolbarHandlers = {
    onInfo: (node) => setInfoNode(node),
    onDelete: (node) => deleteNodes(new Set([node.id])),
    onRetry: (node) => {
      if (isToolNodeType(node.type)) void runTool(node);
      else void runGeneration(node);
    },
    onSaveAsset: (node) => saveAsAssetMutate(node),
    onDownload: (node) => {
      void (async () => {
        const url = node.mediaUrl;
        if (!url) {
          showToast("这个节点还没有可下载的媒体");
          return;
        }
        const result = await downloadMediaFile(url, node.title || "media");
        if (result === "downloaded") showToast("已开始下载");
        else if (result === "shared") showToast("已打开系统分享，可保存到文件");
        else showToast("下载失败，请稍后重试");
      })();
    },
    onUngroup: () => ungroupSelection(),
    onToggleDialog: (node) => {
      updateSelectedIds(new Set([node.id]));
      setPanelFlash(true);
      window.setTimeout(() => setPanelFlash(false), 900);
      requestAnimationFrame(() => {
        detailEditorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    },
    onGenerateImage: (node) => {
      const text = (node.content || node.prompt).trim();
      if (!text) {
        showToast("文本节点还是空的，先写点内容再生成图片");
        return;
      }
      const gen = createGeneratorNode(node, text, `${node.title || "文本"} · 生成图`);
      if (!gen) return;
      void (async () => {
        await flushSave();
        setGenBusyId(gen.id);
        setDirectGenId(gen.id);
        try {
          const res = await api.generateImage({ projectId: gen.projectId, nodeId: gen.id });
          if (res.status === "done") showToast("生成完成");
          else if (res.status === "working") showToast("已开始后台生成，完成后结果会自动上板");
          else showToast(`生成失败：${res.error ?? "未知原因"}`);
        } catch {
          showToast("生成请求失败，请稍后重试");
        } finally {
          setGenBusyId(null);
          setDirectGenId(null);
          void refreshGraphFromServer();
        }
      })();
    },
    onDecreaseFont: (node) =>
      updateNode(node.id, {
        fontSize: Math.max(10, Math.round((node.fontSize ?? 12) - 2)),
      }),
    onIncreaseFont: (node) =>
      updateNode(node.id, {
        fontSize: Math.min(40, Math.round((node.fontSize ?? 12) + 2)),
      }),
    onUpload: (node) => {
      toolbarUploadTargetRef.current = node.id;
      if (toolbarUploadRef.current) {
        toolbarUploadRef.current.accept =
          node.type === "video" ? "video/*" : node.type === "audio" ? "audio/*" : "image/*";
        toolbarUploadRef.current.click();
      }
    },
    onCopyPrompt: (node) => {
      const prompt = (node.prompt || "").trim();
      if (!prompt) {
        showToast("这个节点没有提示词");
        return;
      }
      void (async () => {
        try {
          await navigator.clipboard.writeText(prompt);
          showToast("已复制提示词");
        } catch {
          const ta = document.createElement("textarea");
          ta.value = prompt;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
            showToast("已复制提示词");
          } catch {
            showToast("复制失败，请长按提示词手动复制");
          }
          ta.remove();
        }
      })();
    },
    onReversePrompt: (node) => {
      const tool = buildNode({
        type: "prompt-reverse",
        title: NODE_DEFAULTS["prompt-reverse"].title,
        x: node.x + node.width + 72,
        y: node.y,
        width: NODE_DEFAULTS["prompt-reverse"].w,
        height: NODE_DEFAULTS["prompt-reverse"].h,
        content: "",
        prompt: "",
        status: "idle",
        hidden: false,
        groupId: null,
        color: null,
      });
      if (!tool) return;
      const pid = projectIdRef.current;
      if (!pid) return;
      applyGraph(
        [...nodesRef.current, tool],
        [...edgesRef.current, { id: newId(), projectId: pid, fromNodeId: node.id, toNodeId: tool.id }],
      );
      updateSelectedIds(new Set([tool.id]));
      showToast("已创建逆推工具节点，正在运行");
      void (async () => {
        await flushSave();
        inFlightRunsRef.current.add(tool.id);
        beginRunFeedback(tool.id, "reverse:concise");
        setGenBusyId(tool.id);
        try {
          const res = await api.runToolNode({
            projectId: pid,
            nodeId: tool.id,
            options: { reverseMode: "concise" },
          });
          let isWorking = false;
          if (res.status === "done") {
            showToast("逆推完成，文本节点已上板（在面板里可换其它逆推方式再跑）");
            settleRunFeedback(tool.id, "done");
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
          } else if (res.status === "working") {
            isWorking = true;
            showToast("已提交后台逆推，完成后文本节点会自动上板");
          } else {
            showToast(`逆推失败：${res.error ?? "未知原因"}`);
            settleRunFeedback(tool.id, "failed");
          }
          if (!isWorking) inFlightRunsRef.current.delete(tool.id);
        } catch {
          showToast("逆推运行请求失败，请稍后重试");
          settleRunFeedback(tool.id, "failed");
          inFlightRunsRef.current.delete(tool.id);
        } finally {
          setGenBusyId(null);
          void refreshGraphFromServer();
        }
      })();
    },
    onToggleFreeResize: (node) => {
      updateNode(node.id, { freeResize: !node.freeResize });
      showToast(
        node.freeResize
          ? "已关闭自由尺寸：拖动缩放时保持比例"
          : "已开启自由尺寸：节点可非等比拉伸",
      );
    },
    onMaskEdit: (node) => setEditorDialog({ kind: "mask", node }),
    onCrop: (node) => setEditorDialog({ kind: "crop", node }),
    onSplit: (node) => setEditorDialog({ kind: "split", node }),
    onUpscale: (node) => setEditorDialog({ kind: "upscale", node }),
    onSuperResolve: (node) => setEditorDialog({ kind: "super", node }),
    onAngle: (node) => setEditorDialog({ kind: "angle", node }),
    onViewImage: (node) => openNodePreview(node),
  };

  const handleToolbarUpload = useCallback(
    async (files: FileList | null) => {
      const targetId = toolbarUploadTargetRef.current;
      toolbarUploadTargetRef.current = null;
      const file = files?.[0];
      if (!targetId || !file) return;
      const node = nodesRef.current.find((n) => n.id === targetId);
      if (!node) return;
      if (!file.type.startsWith(`${node.type}/`)) {
        showToast(`请选择${NODE_TYPE_LABEL[node.type]}文件`);
        return;
      }
      setGenBusyId(node.id);
      try {
        const { dataBase64, mimeType } = await fileToBase64(file);
        const res = await api.replaceNodeMedia({
          nodeId: node.id,
          fileName: file.name,
          mimeType,
          dataBase64,
        });
        const next = nodesRef.current.map((n) => (n.id === node.id ? { ...n, ...res.node } : n));
        nodesRef.current = next;
        setNodes(next);
        showToast(
          res.filePath
            ? `已替换「${node.title}」并落盘到项目目录`
            : `已替换「${node.title}」（落盘未成功，稍后会再试）`,
        );
        void refreshGraphFromServer();
      } catch {
        showToast("替换失败，请稍后重试");
      } finally {
        setGenBusyId(null);
      }
    },
    [nodesRef, refreshGraphFromServer, setGenBusyId, setNodes, showToast, toolbarUploadTargetRef],
  );

  const handleCropConfirm = useCallback(
    (node: CanvasNode, rect: CropRect) =>
      runEditorOp(node, "裁剪", () => api.cropNodeImage({ nodeId: node.id, rect }), () => "裁剪完成，新节点已上板"),
    [runEditorOp],
  );

  const handleSplitConfirm = useCallback(
    (node: CanvasNode, params: SplitParams) =>
      runEditorOp(
        node,
        "切分",
        () => api.splitNodeImage({ nodeId: node.id, ...params }),
        (res) => `切分完成，${res.resultNodeIds.length} 个节点已排布在原图下方`,
      ),
    [runEditorOp],
  );

  const handleUpscaleConfirm = useCallback(
    (node: CanvasNode, params: UpscaleParams) =>
      runEditorOp(node, "放大", () => api.upscaleNodeImage({ nodeId: node.id, ...params }), () => "放大完成，新节点已上板"),
    [runEditorOp],
  );

  const handleAngleConfirm = useCallback(
    async (node: CanvasNode, params: AngleParams) => {
      setEditorDialog(null);
      const prompt = `换一个视角：方位角 ${params.horizontalAngle}°、俯仰角 ${params.pitchAngle}°、距离 ${params.cameraDistance}，保持主体与风格不变`;
      const gen = createGeneratorNode(node, prompt, `${node.title || "图片"} · 换角度`);
      if (!gen) return;
      await flushSave();
      setGenBusyId(gen.id);
      try {
        const res = await api.generateImage({ projectId: gen.projectId, nodeId: gen.id });
        if (res.status === "working") showToast("换角度已开始后台生成，完成后结果会自动上板");
        else if (res.status === "done") showToast("生成完成，结果节点已上板");
        else showToast(`换角度失败：${res.error ?? "未知原因"}`);
      } catch {
        showToast("换角度请求失败，请稍后重试");
      } finally {
        setGenBusyId(null);
        void refreshGraphFromServer();
      }
    },
    [createGeneratorNode, flushSave, refreshGraphFromServer, setEditorDialog, setGenBusyId, showToast],
  );

  const handleMaskConfirm = useCallback(
    async (node: CanvasNode, payload: MaskPayload) => {
      setEditorDialog(null);
      const pid = projectIdRef.current;
      if (!pid) return;
      setGenBusyId(node.id);
      try {
        const maskBase64 = payload.maskDataUrl.replace(/^data:image\/png;base64,/, "");
        const uploaded = await api.uploadMedia({
          projectId: pid,
          kind: "image",
          fileName: `${node.title || "图片"} · 蒙版.png`,
          mimeType: "image/png",
          dataBase64: maskBase64,
          x: node.x,
          y: node.y + node.height + 40,
          width: node.width,
          height: node.height,
        });
        if (!nodesRef.current.some((n) => n.id === uploaded.node.id)) {
          nodesRef.current = [...nodesRef.current, uploaded.node];
          setNodes(nodesRef.current);
        }
        const maskNode = nodesRef.current.find((n) => n.id === uploaded.node.id) ?? uploaded.node;
        const gen = createGeneratorNode(
          node,
          payload.prompt,
          `${node.title || "图片"} · 蒙版重绘`,
          [maskNode],
        );
        if (!gen) return;
        await flushSave();
        const res = await api.generateImage({ projectId: pid, nodeId: gen.id });
        if (res.status === "working") showToast("蒙版重绘已开始后台生成（原图＋蒙版双参考近似重绘）");
        else if (res.status === "done") showToast("生成完成，结果节点已上板");
        else showToast(`蒙版重绘失败：${res.error ?? "未知原因"}`);
      } catch {
        showToast("蒙版重绘请求失败，请稍后重试");
      } finally {
        setGenBusyId(null);
        void refreshGraphFromServer();
      }
    },
    [createGeneratorNode, flushSave, nodesRef, projectIdRef, refreshGraphFromServer, setEditorDialog, setGenBusyId, setNodes, showToast],
  );

  return {
    toolbarHandlers,
    handleToolbarUpload,
    handleCropConfirm,
    handleSplitConfirm,
    handleUpscaleConfirm,
    handleAngleConfirm,
    handleMaskConfirm,
  };
}
