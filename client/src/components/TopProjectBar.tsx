import type { CSSProperties, RefObject } from "react";
import logoUrl from "../assets/logo.png";
import {
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconFileText,
  IconMenu,
  IconPanelLeft,
  IconPlus,
  IconQueue,
  IconTrash,
  IconUpload,
  IconX,
} from "../icons";
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
  panelOpen: boolean;
  setPanelOpen: (updater: (v: boolean) => boolean) => void;
  panelWidth: number;
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
  openQueue: () => void;
  queueCount: number;
  importReport: ImportReport | null;
  dismissImportReport: () => void;
}) {
  const {
    panelOpen,
    setPanelOpen,
    panelWidth,
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
    openQueue,
    queueCount,
    importReport,
    dismissImportReport,
  } = props;

  return (
    <>
      <header className="safe-top-offset pointer-events-none absolute inset-x-0 z-40 flex h-14 items-center gap-1 px-3">
        <div
          className="top-cluster-left pointer-events-none flex min-w-0 items-center gap-1"
          data-panel-open={panelOpen}
          style={{ "--panel-width": `${panelWidth}px` } as CSSProperties}
        >
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            className="hit-40 pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            aria-label={panelOpen ? "关闭左侧面板" : "打开左侧面板"}
            aria-pressed={panelOpen}
          >
            <IconPanelLeft size={16} />
          </button>
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
        <a
          href="/bridge-admin"
          target="_blank"
          rel="noopener noreferrer"
          className="hit-40 pointer-events-auto mr-1 flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[12px] font-medium text-[var(--text)] shadow-sm transition-colors hover:bg-[var(--hover)] sm:w-auto sm:px-2.5"
          aria-label="YoYo桥设置"
          title="连接 Muse YoYo 桥（账号与隧道管理）"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--teal)]" />
          <span className="hidden sm:inline">YoYo桥设置</span>
        </a>
        <button
          type="button"
          onClick={openQueue}
          className="hit-40 pointer-events-auto relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          aria-label="打开生成队列"
        >
          <IconQueue size={16} />
          {queueCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-0.5 text-[10px] font-semibold leading-none text-[var(--accent-ink)]">
              {queueCount}
            </span>
          ) : null}
        </button>
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
