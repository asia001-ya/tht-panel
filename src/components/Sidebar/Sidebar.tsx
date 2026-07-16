/**
 * Sidebar.tsx —— 左侧侧边栏容器。
 * 新结构：快捷导航区 / 搜索 / 「项目」工作空间列表 / 「对话」最近会话 / 底部头像设置。
 */
import { useEffect, useMemo, useState } from "react";
import type { ManagedSession } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useLayoutStore } from "../../store/layoutStore";
import { collectCurrentSessionRefs } from "../../lib/workspaceRestore";
import { WorkspaceItem } from "./WorkspaceItem";
import { SidebarNavItem } from "./SidebarNavItem";
import { RecentSessionList } from "./RecentSessionList";
import { SidebarFooter } from "./SidebarFooter";
import {
  LayoutTemplate,
  Plus,
  Search,
  SquarePen,
  SquareTerminal,
  X,
  ICON_DEFAULTS,
} from "../ui/icons";

export interface SidebarProps {
  locateWorkspaceId: string | null;
  onLocateWorkspaceHandled: () => void;
  onResume: (wsId: string, entry: ManagedSession) => void;
  onNewShell: (wsId: string) => void;
  onNewSession: (wsId: string) => void;
  onQuickShell: () => void;
  onRestoreWorkspace: (savedWorkspaceId: string) => void;
}

/**
 * 将目标项目行滚动到侧边栏可视区域。
 * @param workspaceId 目标工作空间 ID。
 * @returns 无返回值。
 */
function scrollWorkspaceIntoView(workspaceId: string): void {
  const target = [...document.querySelectorAll<HTMLElement>("[data-workspace-id]")]
    .find((element) => element.dataset.workspaceId === workspaceId);
  target?.scrollIntoView?.({ block: "nearest" });
}

/**
 * 渲染侧边栏导航、项目列表和最近会话。
 * @param props 定位目标以及会话、Shell 与快捷终端操作回调。
 * @returns 侧边栏界面。
 */
export function Sidebar({ locateWorkspaceId, onLocateWorkspaceHandled, onResume, onNewShell, onNewSession, onQuickShell, onRestoreWorkspace }: SidebarProps): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const loadAllHistories = useWorkspaceStore((s) => s.loadAllHistories);
  const openWorkspaceDialog = useUiStore((s) => s.openWorkspaceDialog);
  const savedWorkspaces = useLayoutStore((s) => s.savedWorkspaces);
  const activeSavedWorkspaceId = useLayoutStore((s) => s.activeSavedWorkspaceId);
  const saveCurrentWorkspace = useLayoutStore((s) => s.saveCurrentWorkspace);
  const removeSavedWorkspace = useLayoutStore((s) => s.removeSavedWorkspace);

  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");

  useEffect(() => {
    void loadWorkspaces().then(() => {
      void loadAllHistories();
    });
  }, [loadWorkspaces, loadAllHistories]);

  // 折叠侧栏重新挂载时直接消费定位目标，避免全局事件监听尚未注册的竞态。
  useEffect(() => {
    if (locateWorkspaceId) {
      scrollWorkspaceIntoView(locateWorkspaceId);
      onLocateWorkspaceHandled();
    }
  }, [locateWorkspaceId, onLocateWorkspaceHandled]);

  useEffect(() => {
    /**
     * 清除项目过滤，并在重新渲染后定位目标项目行。
     * @param event 包含目标工作空间 ID 的定位事件。
     * @returns 无返回值。
     */
    const onLocateWorkspace = (event: Event): void => {
      const workspaceId = (event as CustomEvent<string>).detail;
      setFilter("");
      window.setTimeout(scrollWorkspaceIntoView, 0, workspaceId);
    };
    window.addEventListener("app:locate-workspace", onLocateWorkspace);
    return () => window.removeEventListener("app:locate-workspace", onLocateWorkspace);
  }, []);

  const ordered = useMemo(
    () => [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder),
    [workspaces],
  );

  const filteredWs = filter
    ? ordered.filter((ws) => ws.name.toLowerCase().includes(filter.toLowerCase()))
    : ordered;

  return (
    <aside className="sidebar">
      {/* 顶部快捷导航 */}
      <nav className="sidebar-nav">
        <SidebarNavItem
          icon={<SquarePen {...ICON_DEFAULTS} />}
          label="新建项目"
          onClick={() => openWorkspaceDialog()}
        />
        <SidebarNavItem
          icon={<Search {...ICON_DEFAULTS} />}
          label="搜索"
          onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setFilter(""); }}
        />
        <SidebarNavItem
          icon={<SquareTerminal {...ICON_DEFAULTS} />}
          label="新开终端"
          onClick={onQuickShell}
        />
      </nav>

      {/* 搜索框 */}
      {searchOpen && (
        <div className="sidebar-search">
          <input
            className="sidebar-search-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤项目与对话…"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setFilter(""); } }}
          />
          {filter && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setFilter("")}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>
      )}

      {/* 可滚动列表区 */}
      <div className="sidebar-scroll">
        {/* 项目组 */}
        <div className="sidebar-group-title">项目</div>
        {filteredWs.length === 0 ? (
          <div className="sidebar-empty">暂无项目</div>
        ) : (
          filteredWs.map((ws, index) => (
            <WorkspaceItem
              key={ws.id}
              ws={ws}
              index={index}
              onResume={onResume}
              onNewShell={onNewShell}
              onNewSession={onNewSession}
            />
          ))
        )}

        <div className="sidebar-group-title sidebar-group-title-row">
          <span>工作区</span>
          <button
            type="button"
            className="sidebar-group-add"
            aria-label="新建工作区"
            title="以当前布局新建工作区"
            onClick={() => setCreatingWorkspace(true)}
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        {creatingWorkspace && (
          <div className="sidebar-save-workspace">
            <input
              className="sidebar-search-input"
              value={workspaceName}
              placeholder="工作区名称"
              autoFocus
              onChange={(event) => setWorkspaceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setCreatingWorkspace(false);
                  setWorkspaceName("");
                }
                if (event.key === "Enter" && workspaceName.trim()) {
                  saveCurrentWorkspace(workspaceName, collectCurrentSessionRefs());
                  setCreatingWorkspace(false);
                  setWorkspaceName("");
                }
              }}
            />
          </div>
        )}
        {savedWorkspaces.length === 0 ? (
          <div className="sidebar-empty sidebar-empty-compact">暂无已保存工作区</div>
        ) : (
          <div className="saved-workspace-list">
            {savedWorkspaces.map((saved) => (
              <div className="saved-workspace-row" key={saved.id}>
                <button
                  type="button"
                  className={`saved-workspace-open${
                    saved.id === activeSavedWorkspaceId ? " saved-workspace-open-active" : ""
                  }`}
                  onClick={() => onRestoreWorkspace(saved.id)}
                  title={saved.name}
                >
                  <LayoutTemplate size={14} strokeWidth={1.5} />
                  <span>{saved.name}</span>
                </button>
                <button
                  type="button"
                  className="saved-workspace-delete"
                  aria-label={`删除工作区 ${saved.name}`}
                  onClick={() => removeSavedWorkspace(saved.id)}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 对话组 */}
        <div className="sidebar-group-title">对话</div>
        <RecentSessionList filter={filter} onResume={onResume} />
      </div>

      {/* 底部 */}
      <SidebarFooter />
    </aside>
  );
}
