/**
 * WorkspaceItem.tsx —— 侧边栏中的单个工作空间行。
 * 一行显示：展开箭头 + 名称 + 状态徽标（+ 前 9 个的 Ctrl+序号角标）；
 * 点击行主体激活工作空间；右键弹出菜单（编辑 / 删除 / 新开纯 Shell）；
 * 展开时在行下方渲染该工作空间的历史会话列表 SessionHistoryList。
 */
import { useEffect, useRef, useState } from "react";
import type { Workspace, ManagedSession, SessionState } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useSessionStore, badgeFor } from "../../store/sessionStore";
import { SessionHistoryList } from "./SessionHistoryList";

/** WorkspaceItem 组件对外 props */
export interface WorkspaceItemProps {
  ws: Workspace; // 本行对应的工作空间
  index: number; // 在排序后列表中的下标（0 基），前 9 个显示 Ctrl+序号角标
  onActivate: (wsId: string) => void; // 点击行主体：激活工作空间
  onResume: (wsId: string, entry: ManagedSession) => void; // 点击会话条目
  onNewShell: (wsId: string) => void; // 新开纯 Shell 会话
  onNewSession: (wsId: string) => void; // 「+ 新会话」：无条件新建 AI 会话
}

/** 状态徽标对应的 CSS 变量名（背景色） */
const BADGE_VAR: Record<SessionState, string> = {
  running: "var(--badge-running)",
  waiting: "var(--badge-waiting)",
  idle: "var(--badge-idle)",
  dead: "var(--badge-dead)",
};

/**
 * 单个工作空间行组件。
 * @param props 见 WorkspaceItemProps
 * @returns 工作空间行 JSX（含展开的历史列表）
 */
export function WorkspaceItem({
  ws,
  index,
  onActivate,
  onResume,
  onNewShell,
  onNewSession,
}: WorkspaceItemProps): React.JSX.Element {
  const expanded = useWorkspaceStore((s) => s.expandedIds.has(ws.id));
  const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
  const removeWorkspace = useWorkspaceStore((s) => s.remove);
  const openWorkspaceDialog = useUiStore((s) => s.openWorkspaceDialog);
  const openConfirm = useUiStore((s) => s.openConfirm);

  // 订阅会话表变化以触发徽标重算：badgeFor 返回原始值（string|null），
  // zustand 以 Object.is 比对，仅当本工作空间聚合徽标真正变化时才重渲染本行。
  const badge = useSessionStore(() => badgeFor(ws.id));

  // 右键上下文菜单的屏幕坐标；null=未打开
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 菜单打开时，点击别处 / 按 Esc 关闭菜单
  useEffect(() => {
    if (!menuPos) return;
    const onGlobalDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPos(null);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuPos(null);
    };
    window.addEventListener("mousedown", onGlobalDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onGlobalDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuPos]);

  /** 右键行：在光标处打开上下文菜单 */
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  /** 点击展开箭头：切换历史子菜单展开态（阻止冒泡以免误触发激活） */
  const onToggleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    toggleExpand(ws.id);
  };

  /** 菜单项「编辑」：打开工作空间对话框（编辑模式） */
  const onEdit = (): void => {
    setMenuPos(null);
    openWorkspaceDialog(ws);
  };

  /** 菜单项「删除」：弹确认框，确认后移除工作空间 */
  const onDelete = (): void => {
    setMenuPos(null);
    openConfirm({
      title: "删除工作空间",
      message: `确定删除工作空间「${ws.name}」吗？该操作不可撤销。`,
      onConfirm: () => {
        void removeWorkspace(ws.id);
      },
    });
  };

  /** 菜单项「新开纯 Shell」：为该工作空间起一个纯 PowerShell 会话 */
  const onNewShellClick = (): void => {
    setMenuPos(null);
    onNewShell(ws.id);
  };

  return (
    <div className="ws-item">
      {/* 工作空间行主体 */}
      <div
        className="ws-item-row"
        onClick={() => onActivate(ws.id)}
        onContextMenu={onContextMenu}
        title={ws.path}
      >
        {/* 展开/收起箭头 */}
        <span
          className={`ws-item-arrow${expanded ? " ws-item-arrow-open" : ""}`}
          onClick={onToggleClick}
        >
          ▶
        </span>

        {/* 状态徽标：无活跃会话时不占色（透明点） */}
        <span
          className="ws-item-badge"
          style={{ background: badge ? BADGE_VAR[badge] : "transparent" }}
        />

        {/* 名称 */}
        <span className="ws-item-name">{ws.name}</span>

        {/* 前 9 个显示 Ctrl+序号角标 */}
        {index < 9 && <span className="ws-item-hotkey">Ctrl+{index + 1}</span>}
      </div>

      {/* 展开时渲染历史会话列表；「+ 新会话」用独立回调（无条件新建，区别于 onActivate 的聚焦最近） */}
      {expanded && (
        <SessionHistoryList
          ws={ws}
          onResume={onResume}
          onNewSession={onNewSession}
        />
      )}

      {/* 右键上下文菜单 */}
      {menuPos && (
        <div
          ref={menuRef}
          className="ws-item-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button type="button" className="ws-item-menu-btn" onClick={onEdit}>
            编辑
          </button>
          <button
            type="button"
            className="ws-item-menu-btn"
            onClick={onNewShellClick}
          >
            新开纯 Shell
          </button>
          <button
            type="button"
            className="ws-item-menu-btn ws-item-menu-danger"
            onClick={onDelete}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
