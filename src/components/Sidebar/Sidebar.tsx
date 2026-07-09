/**
 * Sidebar.tsx —— 左侧工作空间侧边栏容器。
 * 结构：顶部「+ 新建工作空间」按钮 / 中部工作空间列表（按 sortOrder，前 9 个显示 Ctrl+序号角标）/
 * 底部主题切换 + 设置齿轮。
 * 会话/分屏相关的落点动作（激活工作空间、恢复历史会话、新开纯 Shell）由组装阶段通过 props 注入，
 * Sidebar 只负责把它们向下透传给 WorkspaceItem，自身不持有分屏/PTY 逻辑。
 */
import { useEffect, useMemo } from "react";
import type { ManagedSession } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { WorkspaceItem } from "./WorkspaceItem";

/** Sidebar 组件对外 props：由组装层（App/PaneGrid 编排）提供的落点回调 */
export interface SidebarProps {
  /** 点击工作空间行主体：激活该工作空间（聚焦最近会话或新建） */
  onActivate: (wsId: string) => void;
  /** 点击会话条目：激活/恢复该会话 */
  onResume: (wsId: string, entry: ManagedSession) => void;
  /** 右键菜单「新开纯 Shell」：为该工作空间起一个纯 PowerShell 会话 */
  onNewShell: (wsId: string) => void;
  /** 历史列表「+ 新会话」：无条件为该工作空间新建一个 AI 会话 */
  onNewSession: (wsId: string) => void;
}

/**
 * 侧边栏容器组件。
 * @param props 落点回调（onActivate/onResume/onNewShell）
 * @returns 侧边栏 JSX
 */
export function Sidebar({ onActivate, onResume, onNewShell, onNewSession }: SidebarProps): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const theme = useSettingsStore((s) => s.config?.theme ?? "dark");
  const setTheme = useSettingsStore((s) => s.setTheme);
  const openWorkspaceDialog = useUiStore((s) => s.openWorkspaceDialog);
  const openSettings = useUiStore((s) => s.openSettings);

  // 首次挂载拉取工作空间列表（幂等：store.load 覆盖式写入）
  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // 按 sortOrder 升序排序（后端一般已排序，此处防御性再排一次）
  const ordered = useMemo(
    () => [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder),
    [workspaces],
  );

  /** 主题切换：在 light/dark 间反转并持久化 */
  const toggleTheme = (): void => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <aside className="sidebar">
      {/* 顶部：新建工作空间 */}
      <div className="sidebar-header">
        <button
          type="button"
          className="sidebar-new-btn"
          onClick={() => openWorkspaceDialog()}
          title="新建工作空间"
        >
          + 新建工作空间
        </button>
      </div>

      {/* 中部：工作空间列表（可滚动） */}
      <div className="sidebar-list">
        {ordered.length === 0 ? (
          <div className="sidebar-empty">暂无工作空间</div>
        ) : (
          ordered.map((ws, index) => (
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
      </div>

      {/* 底部：主题切换 + 设置齿轮 */}
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-btn"
          onClick={toggleTheme}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        >
          {theme === "dark" ? "☀" : "🌙"}
        </button>
        <button
          type="button"
          className="sidebar-footer-btn"
          onClick={() => openSettings()}
          title="设置"
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}
