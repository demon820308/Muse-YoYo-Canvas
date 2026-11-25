import type { RefObject } from "react";
import logoUrl from "../assets/logo.png";
import {
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconFileText,
  IconMenu,
  IconPlus,
  IconTrash,
  IconUpload,
  IconX,
} from "../icons";
import type { BridgeSummary } from "./BridgeSetupModal";
import type { AgyStatus } from "../hooks/use-agy";
import type { ProjectDialogState } from "./AppDialogs";
import { ProjectMenuItem } from "./ProjectChrome";

type ProjectSummary = {
  id: string;
  name: string;
  nodeCount: number;
  workspaceDir: string;
};

type ImportReport = {
  name: string;
  nodeCount: number;
  mediaImported: number;
  mediaMissing: { title: string; reason: string }[];
};

export function TopProjectBar(props: {
  projectMenuRef: RefObject<HTMLDivElement | null>;
  projectMenuOpen: boolean;
  setProjectMenuOpen: (updater: (v: boolean) => boolean) => void;
  openDialog: (d: Exclude<ProjectDialogState, null>) => void;
  importing: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  currentProject: ProjectSummary | undefined;
  exporting: boolean;
  handleExportPackage: () => Promise<void>;
  handleImportPackageFile: (file: File | null) => Promise<void>;
  projectSwitchRef: RefObject<HTMLDivElement | null>;
  projectSwitchOpen: boolean;
  setProjectSwitchOpen: (updater: (v: boolean) => boolean) => void;
  projects: ProjectSummary[];
  projectId: string | null;
  switchProject: (id: string | null) => void;
  bridgeSummary: BridgeSummary | null;
  bridgeSummaryTimeout: boolean;
  onOpenBridgeModal: () => void;
  agyStatus: AgyStatus | null;
  onOpenAgyModal: () => void;
  importReport: ImportReport | null;
  dismissImportReport: () => void;
}) {
  const {
    projectMenuRef,
    projectMenuOpen,
    setProjectMenuOpen,
    openDialog,
    importing,
    importInputRef,
    currentProject,
    exporting,
    handleExportPackage,
    handleImportPackageFile,
    projectSwitchRef,
    projectSwitchOpen,
    setProjectSwitchOpen,
    projects,
    projectId,
    switchProject,
    bridgeSummary,
    bridgeSummaryTimeout,
    onOpenBridgeModal,
    agyStatus,
    onOpenAgyModal,
    importReport,
    dismissImportReport,
  } = props;

  return (
    <>
      <header className="safe-top-offset pointer-events-none absolute inset-x-0 z-[60] flex h-14 items-center gap-1 px-3">
        <div
          className="pointer-events-none flex min-w-0 items-center gap-1"
        >
          <img
            src={logoUrl}
            alt="YoYo画布 logo"
            className="h-7 w-7 shrink-0 rounded-md"
            width={28}
            height={28}
          />
          <div className="pointer-events-auto relative shrink-0" ref={projectMenuRef}>
            <button
              type="button"
              onClick={() => setProjectMenuOpen((v) => !v)}
              className="hit-40 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              aria-label="项目菜单"
              aria-haspopup="menu"
              aria-expanded={projectMenuOpen}
            >
              <IconMenu size={16} />
            </button>
            {projectMenuOpen ? (
              <div
                role="menu"
                aria-label="项目菜单"
                className="absolute left-0 top-[calc(100%+6px)] z-50 w-52 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow)]"
              >
                <ProjectMenuItem
                  icon={<IconPlus size={15} />}
                  label="新建项目"
                  onClick={() => {
                    setProjectMenuOpen(() => false);
                    openDialog({ mode: "create" });
                  }}
                />
                <ProjectMenuItem
                  icon={<IconUpload size={15} />}
                  label={importing ? "导入中…" : "导入项目包"}
                  disabled={importing}
                  onClick={() => {
                    setProjectMenuOpen(() => false);
                    importInputRef.current?.click();
                  }}
                />
                {currentProject ? (
                  <>
                    <div className="mx-2 my-1 h-px bg-[var(--border)]" />
                    <ProjectMenuItem
                      icon={<IconFileText size={15} />}
                      label="重命名"
                      onClick={() => {
                        setProjectMenuOpen(() => false);
                        openDialog({ mode: "rename", id: currentProject.id, name: currentProject.name });
                      }}
                    />
                    <ProjectMenuItem
                      icon={<IconFileText size={15} />}
                      label="更改目录"
                      onClick={() => {
                        setProjectMenuOpen(() => false);
                        openDialog({
                          mode: "move-dir",
                          id: currentProject.id,
                          name: currentProject.name,
                          currentDir: currentProject.workspaceDir,
                        });
                      }}
                    />
                    <ProjectMenuItem
                      icon={<IconDownload size={15} />}
                      label={exporting ? "导出中…" : "导出项目包"}
                      disabled={exporting}
                      onClick={() => {
                        setProjectMenuOpen(() => false);
                        void handleExportPackage();
                      }}
                    />
                    <div className="mx-2 my-1 h-px bg-[var(--border)]" />
                    <ProjectMenuItem
                      icon={<IconTrash size={15} />}
                      label="删除项目"
                      danger
                      onClick={() => {
                        setProjectMenuOpen(() => false);
                        openDialog({ mode: "delete", id: currentProject.id, name: currentProject.name });
                      }}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="选择要导入的项目包文件"
            onChange={(e) => {
              void handleImportPackageFile(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <div className="pointer-events-auto relative min-w-0 max-w-[180px] shrink" ref={projectSwitchRef}>
            <button
              type="button"
              onClick={() => setProjectSwitchOpen((v) => !v)}
              disabled={projects.length === 0}
              className="flex w-full min-w-0 items-center gap-1 rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-left text-sm font-semibold outline-none hover:border-[var(--border)] focus:border-[var(--accent)] disabled:opacity-60"
              aria-label="切换项目"
              aria-haspopup="listbox"
              aria-expanded={projectSwitchOpen}
            >
              <span className="min-w-0 truncate">
                {currentProject
                  ? `${currentProject.name}（${currentProject.nodeCount}）`
                  : projects.length
                    ? "选择项目"
                    : "暂无项目"}
              </span>
              <span className="shrink-0 text-[var(--dim)]">
                <IconChevronDown size={14} />
              </span>
            </button>
            {projectSwitchOpen ? (
              <div
                role="listbox"
                aria-label="选择项目"
                className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-64 w-52 overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow)]"
              >
                {projects.map((p) => {
                  const active = p.id === projectId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setProjectSwitchOpen(() => false);
                        switchProject(p.id);
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-[var(--hover)]"
                      style={
                        active
                          ? { background: "var(--accent-soft)", color: "var(--accent)" }
                          : { color: "var(--text)" }
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {p.name}（{p.nodeCount}）
                      </span>
                      {active ? (
                        <span className="shrink-0">
                          <IconCheck size={14} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
        <span className="flex-1" />
        {(() => {
          const agyReady = Boolean(agyStatus?.ready);
          const agyInstalled = Boolean(agyStatus?.installed);
          const agyLabel = agyReady
            ? "AGY 已就绪"
            : agyInstalled
              ? agyStatus?.loggedIn
                ? "AGY 待启用"
                : "AGY 待登录"
              : "AGY 引擎";
          return (
            <button
              type="button"
              onClick={onOpenAgyModal}
              className="hit-40 pointer-events-auto mr-1.5 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[12px] font-medium text-[var(--text)] shadow-sm transition-colors hover:bg-[var(--hover)]"
              aria-label={agyLabel}
              title={
                agyReady
                  ? `AGY 本地引擎已就绪（模型：${agyStatus?.model}），可切换 Nano Banana 生图与本地推理`
                  : "一键部署并登录本地 agy CLI，解锁 Nano Banana 生图与本地模型"
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  agyReady
                    ? "bg-[var(--teal)]"
                    : agyInstalled
                      ? "bg-[var(--accent)]"
                      : "bg-[var(--dim)]"
                }`}
              />
              <span>{agyLabel}</span>
            </button>
          );
        })()}
        {(() => {
          const isLoading = bridgeSummary === null && !bridgeSummaryTimeout;
          const bState = bridgeSummary?.state ?? null;
          const bLabel = isLoading
            ? "检测YoYo桥…"
            : bridgeSummary?.label ?? "YoYo桥设置";
          const needsAttention = bState === "unconfigured" || bState === "unpaired";
          const isDisconnected = bState === "disconnected";
          const isConnected = bState === "connected";
          const isConnecting = bState === "connecting";
          return (
            <button
              type="button"
              onClick={onOpenBridgeModal}
              className={`hit-40 pointer-events-auto mr-1 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium shadow-sm transition-colors ${
                needsAttention
                  ? "bridge-attention-ring border-[var(--accent)]/60 bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  : isDisconnected
                    ? "border-[var(--danger)]/50 bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]"
              }`}
              aria-label={bLabel}
              title={bridgeSummary?.summary ?? "连接 Muse YoYo 桥（账号与隧道管理）"}
            >
              <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
                {needsAttention ? (
                  <span className="bridge-dot-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)]" />
                ) : null}
                <span
                  className={`relative h-2 w-2 rounded-full ${
                    isConnected
                      ? "bg-[var(--teal)]"
                      : isDisconnected
                        ? "bg-[var(--danger)]"
                        : isLoading || isConnecting || bState === null
                          ? "animate-pulse bg-[var(--dim)]"
                          : "bg-[var(--accent)]"
                  }`}
                />
              </span>
              <span className={isConnected ? "hidden sm:inline" : "inline"}>
                {bLabel}
              </span>
            </button>
          );
        })()}
      </header>

      {importReport ? (
        <div
          className="capsule-chrome absolute inset-x-3 top-16 z-40 flex flex-wrap items-start gap-2 rounded-xl px-3 py-2 text-[13px]"
          role="status"
          aria-label="导入结果报告"
        >
          <span className="font-medium">导入完成：「{importReport.name}」</span>
          <span className="text-[var(--dim)]">
            共 {importReport.nodeCount} 个节点，{importReport.mediaImported} 个媒体文件已恢复
            {importReport.mediaMissing.length
              ? `；${importReport.mediaMissing.length} 个媒体缺失：${importReport.mediaMissing
                  .map((m) => `「${m.title}」${m.reason}`)
                  .join("；")}（对应节点已标为缺失态）`
              : ""}
          </span>
          <button
            type="button"
            onClick={dismissImportReport}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--hover-strong)]"
            aria-label="关闭导入报告"
          >
            <IconX size={14} />
          </button>
        </div>
      ) : null}
    </>
  );
}
