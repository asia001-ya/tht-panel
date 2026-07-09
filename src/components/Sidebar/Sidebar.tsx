/**
 * Sidebar.tsx —— 左侧侧边栏容器。
 * 新结构：快捷导航区 / 搜索 / 「项目」工作空间列表 / 「对话」最近会话 / 底部头像设置。
 */
import { useEffect, useMemo, useState } from "react";
import type { ManagedSession } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { WorkspaceItem } from "./WorkspaceItem";
import { SidebarNavItem } from "./SidebarNavItem";
import { RecentSessionList } from "./RecentSessionList";
import { SidebarFooter } from "./SidebarFooter";
import { SquarePen, Search, SquareTerminal, X, ICON_DEFAULTS } from "../ui/icons";

export interface SidebarProps {
  onActivate: (wsId: string) => void;
  onResume: (wsId: string, entry: ManagedSession) => void;
  onNewShell: (wsId: string) => void;
  onNewSession: (wsId: string) => void;
  onQuickShell: () => void;
}

export function Sidebar({ onActivate, onResume, onNewShell, onNewSession, onQuickShell }: SidebarProps): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const loadAllHistories = useWorkspaceStore((s) => s.loadAllHistories);
  const openWorkspaceDialog = useUiStore((s) => s.openWorkspaceDialog);

  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void loadWorkspaces().then(() => {
      void loadAllHistories();
    });
  }, [loadWorkspaces, loadAllHistories]);

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
          label="新建工作空间"
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
          <div className="sidebar-empty">暂无工作空间</div>
        ) : (
          filteredWs.map((ws, index) => (
            <WorkspaceItem
              key={ws.id}
              ws={ws}
              index={index}
              onActivate={onActivate}
              onResume={onResume}
              onNewShell={onNewShell}
              onNewSession={onNewSession}
            />
          ))
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
