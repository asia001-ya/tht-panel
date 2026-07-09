/**
 * RecentSessionList — 侧边栏「对话」组：跨工作空间最近会话平铺列表。
 */
import { useMemo } from "react";
import type { ManagedSession } from "../../api/types";
import { useWorkspaceStore, selectRecentSessions } from "../../store/workspaceStore";
import { useSessionStore } from "../../store/sessionStore";
import { relativeTime } from "../../lib/time";

interface RecentSessionListProps {
  filter: string;
  onResume: (wsId: string, entry: ManagedSession) => void;
}

export function RecentSessionList({ filter, onResume }: RecentSessionListProps): React.JSX.Element {
  const historyCache = useWorkspaceStore((s) => s.historyCache);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const sessions = useSessionStore((s) => s.sessions);

  const recent = useMemo(
    () => selectRecentSessions(historyCache, workspaces, 15),
    [historyCache, workspaces],
  );

  const filtered = filter
    ? recent.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
    : recent;

  if (filtered.length === 0) return <></>;

  return (
    <div className="sidebar-recent">
      {filtered.map((entry) => {
        const live = entry.ptySessionId ? sessions[entry.ptySessionId] : undefined;
        const isAlive = live && live.state !== "dead";
        return (
          <div
            key={entry.id}
            className="sidebar-recent-item"
            onClick={() => onResume(entry.workspaceId, entry)}
            title={`${entry.workspaceName} / ${entry.name}`}
          >
            {isAlive && <span className="pane-status-dot" data-state={live.state} />}
            <span className="sidebar-recent-name">{entry.name}</span>
            <span className="sidebar-recent-time">{relativeTime(entry.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
