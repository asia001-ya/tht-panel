/**
 * WorkspaceItem.tsx —— 侧边栏中的单个工作空间行。
 */
import { useState } from "react";
import type { Workspace, ManagedSession, SessionState } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useSessionStore, badgeFor } from "../../store/sessionStore";
import { useSettingsStore } from "../../store/settingsStore";
import { resolveProjectProvider } from "../../lib/providers";
import { startKeepAlive, stopKeepAlive, isKeepAliveActive } from "../../keepAliveManager";
import { SessionHistoryList } from "./SessionHistoryList";
import { ContextMenu } from "../ui/ContextMenu";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { ChevronRight, Plus } from "../ui/icons";

export interface WorkspaceItemProps {
  ws: Workspace;
  index: number;
  onActivate: (wsId: string) => void;
  onResume: (wsId: string, entry: ManagedSession) => void;
  onNewShell: (wsId: string) => void;
  onNewSession: (wsId: string) => void;
}

const BADGE_VAR: Record<SessionState, string> = {
  running: "var(--badge-running)",
  waiting: "var(--badge-waiting)",
  idle: "var(--badge-idle)",
  dead: "var(--badge-dead)",
};

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
  const providers = useSettingsStore((s) => s.config?.providers ?? []);
  const provider = resolveProjectProvider(ws, providers);

  const badge = useSessionStore(() => badgeFor(ws.id));

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [, forceUpdate] = useState(0);

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const onToggleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    toggleExpand(ws.id);
  };

  const buildMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "编辑", onClick: () => openWorkspaceDialog(ws) },
      { label: "新开纯 Shell", onClick: () => onNewShell(ws.id) },
    ];

    const ka = ws.keepAlive;
    if (ka?.enabled && ka.command) {
      const active = isKeepAliveActive(ws.id);
      items.push({
        label: active ? "停止 Keep-Alive" : "开启 Keep-Alive",
        onClick: () => {
          if (active) {
            stopKeepAlive(ws.id);
          } else {
            startKeepAlive(ws.id, ka.command, ka.intervalMin);
          }
          forceUpdate((n) => n + 1);
        },
      });
    }

    items.push({
      label: "删除", danger: true, onClick: () => {
        openConfirm({
          title: "删除项目",
          message: `确定删除项目「${ws.name}」吗？该操作不可撤销。`,
          onConfirm: () => { void removeWorkspace(ws.id); },
        });
      },
    });

    return items;
  };

  return (
    <div className="ws-item">
      <div
        className="ws-item-row"
        onClick={() => onActivate(ws.id)}
        onContextMenu={onContextMenu}
        title={ws.path}
      >
        <span
          className={`ws-item-arrow${expanded ? " ws-item-arrow-open" : ""}`}
          onClick={onToggleClick}
        >
          <ChevronRight size={12} strokeWidth={1.5} />
        </span>

        <span
          className="ws-item-badge"
          style={{ background: badge ? BADGE_VAR[badge] : "transparent" }}
        />

        <span className="ws-item-name">{ws.name}</span>

        {provider && <span className="ws-item-provider">{provider.name}</span>}

        <button
          type="button"
          className="ws-item-add"
          title="新会话"
          onClick={(e) => { e.stopPropagation(); onNewSession(ws.id); }}
        >
          <Plus size={14} strokeWidth={1.5} />
        </button>

        {index < 9 && <span className="ws-item-hotkey">Ctrl+{index + 1}</span>}
      </div>

      {expanded && (
        <SessionHistoryList
          ws={ws}
          onResume={onResume}
        />
      )}

      {menuPos && (
        <ContextMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={buildMenuItems()}
        />
      )}
    </div>
  );
}
