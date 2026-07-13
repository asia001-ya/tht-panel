/**
 * SessionHistoryList.tsx —— 工作空间展开时显示的自管会话列表。
 */
import { useEffect, useState } from "react";
import type { Workspace, ManagedSession } from "../../api/types";
import { useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSettingsStore } from "../../store/settingsStore";
import {
  managedSessionDelete,
  managedSessionUpdate,
  ptyKill,
} from "../../api/commands";
import { resolveConversationProvider } from "../../lib/providers";
import { ContextMenu } from "../ui/ContextMenu";
import { X } from "../ui/icons";

export interface SessionHistoryListProps {
  ws: Workspace;
  onResume: (wsId: string, session: ManagedSession) => void;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString();
}

export function SessionHistoryList({
  ws,
  onResume,
}: SessionHistoryListProps): React.JSX.Element {
  const entries = useWorkspaceStore((s) => s.historyCache[ws.id]) as ManagedSession[] | undefined;
  const loading = useWorkspaceStore((s) => s.historyLoading[ws.id] ?? false);
  const loadHistory = useWorkspaceStore((s) => s.loadHistory);
  const providers = useSettingsStore((s) => s.config?.providers ?? []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; entry: ManagedSession } | null>(null);

  useEffect(() => {
    if (!loading) {
      void loadHistory(ws.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id]);

  const startRename = (session: ManagedSession): void => {
    setEditingId(session.id);
    setEditName(session.name);
  };

  const saveRename = async (session: ManagedSession): Promise<void> => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.name) {
      const updated = { ...session, name: trimmed, updatedAt: new Date().toISOString() };
      await managedSessionUpdate(updated);
      void loadHistory(ws.id);
    }
    setEditingId(null);
  };

  const handleDelete = async (e: React.MouseEvent, id: string): Promise<void> => {
    e.stopPropagation();
    await managedSessionDelete(id);
    void loadHistory(ws.id);
  };

  const changeProvider = async (
    session: ManagedSession,
    providerId?: string,
  ): Promise<void> => {
    const currentProvider = resolveConversationProvider(session, ws, providers);
    const nextSelection = { ...session, providerId };
    const nextProvider = resolveConversationProvider(nextSelection, ws, providers);
    const nextKind = nextProvider?.driver ?? ws.agent;
    const shouldRestart =
      currentProvider?.id !== nextProvider?.id || nextKind !== session.kind;
    if (shouldRestart && session.ptySessionId) {
      await ptyKill(session.ptySessionId).catch(() => undefined);
      useSessionStore.getState().remove(session.ptySessionId);
    }
    const updated: ManagedSession = {
      ...nextSelection,
      kind: nextKind,
      aiSessionId: nextKind === session.kind ? session.aiSessionId : undefined,
      updatedAt: new Date().toISOString(),
    };
    await managedSessionUpdate(updated);
    await loadHistory(ws.id);
    if (shouldRestart) {
      onResume(ws.id, updated);
    }
  };

  return (
    <div className="session-history">
      {loading && <div className="session-history-loading">加载中…</div>}
      {!loading && entries !== undefined && entries.length === 0 && (
        <div className="session-history-empty">暂无会话</div>
      )}

      {entries?.map((entry) => (
        <div
          key={entry.id}
          className="session-history-entry"
          onClick={() => onResume(ws.id, entry)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, entry });
          }}
          title={entry.name}
        >
          {editingId === entry.id ? (
            <input
              className="session-history-rename-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => void saveRename(entry)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRename(entry);
                if (e.key === "Escape") setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              className="session-history-title"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(entry);
              }}
            >
              {entry.name}
            </span>
          )}
          <span className="session-history-meta">
            <span className="session-history-time">{relativeTime(entry.updatedAt)}</span>
            <button
              type="button"
              className="session-history-delete"
              onClick={(e) => void handleDelete(e, entry.id)}
              title="删除"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </span>
        </div>
      ))}

      {menu && (
        <ContextMenu
          pos={menu}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "current-provider",
              label: `当前供应商：${resolveConversationProvider(menu.entry, ws, providers)?.name ?? "未配置"}`,
              onClick: () => undefined,
            },
            {
              id: "inherit-provider",
              label: "跟随项目默认",
              onClick: () => void changeProvider(menu.entry),
            },
            ...providers.map((provider) => ({
              id: `provider-${provider.id}`,
              label: `切换到 ${provider.name}`,
              onClick: () => void changeProvider(menu.entry, provider.id),
            })),
            { id: "rename", label: "重命名", onClick: () => startRename(menu.entry) },
            { id: "delete", label: "删除", danger: true, onClick: () => {
              void managedSessionDelete(menu.entry.id).then(() => loadHistory(ws.id));
            }},
          ]}
        />
      )}
    </div>
  );
}
