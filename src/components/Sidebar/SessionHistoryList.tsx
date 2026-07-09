/**
 * SessionHistoryList.tsx —— 工作空间展开时显示的自管会话列表。
 * 数据源：tht-panel 自己持久化的 sessions.json（不再依赖 claude/codex 写文件）。
 * 每次展开自动刷新；支持会话重命名（双击名称进入编辑）、删除。
 */
import { useEffect, useState } from "react";
import type { Workspace, ManagedSession } from "../../api/types";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { managedSessionUpdate, managedSessionDelete } from "../../api/commands";

/** SessionHistoryList 组件对外 props */
export interface SessionHistoryListProps {
  ws: Workspace;
  /** 点击会话条目：激活/恢复该会话 */
  onResume: (wsId: string, session: ManagedSession) => void;
  /** 点击「+ 新会话」：无条件新建一个 AI 会话 */
  onNewSession: (wsId: string) => void;
}

/**
 * 把 ISO 时间字符串格式化为中文相对时间。
 * @param iso ISO 时间字符串
 * @returns 相对时间文案
 */
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

/**
 * 自管会话列表组件。
 * @param props 见 SessionHistoryListProps
 * @returns 会话列表 JSX
 */
export function SessionHistoryList({
  ws,
  onResume,
  onNewSession,
}: SessionHistoryListProps): React.JSX.Element {
  const entries = useWorkspaceStore((s) => s.historyCache[ws.id]) as ManagedSession[] | undefined;
  const loading = useWorkspaceStore((s) => s.historyLoading[ws.id] ?? false);
  const loadHistory = useWorkspaceStore((s) => s.loadHistory);

  // 正在重命名的会话 id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // 每次展开（挂载）时都刷新
  useEffect(() => {
    if (!loading) {
      void loadHistory(ws.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id]);

  /** 刷新按钮 */
  const onRefresh = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void loadHistory(ws.id);
  };

  /** 双击进入重命名模式 */
  const startRename = (session: ManagedSession): void => {
    setEditingId(session.id);
    setEditName(session.name);
  };

  /** 保存重命名 */
  const saveRename = async (session: ManagedSession): Promise<void> => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.name) {
      const updated = { ...session, name: trimmed, updatedAt: new Date().toISOString() };
      await managedSessionUpdate(updated);
      void loadHistory(ws.id);
    }
    setEditingId(null);
  };

  /** 删除会话记录 */
  const handleDelete = async (e: React.MouseEvent, id: string): Promise<void> => {
    e.stopPropagation();
    await managedSessionDelete(id);
    void loadHistory(ws.id);
  };

  return (
    <div className="session-history">
      {/* 顶部操作条 */}
      <div className="session-history-toolbar">
        <button
          type="button"
          className="session-history-new"
          onClick={() => onNewSession(ws.id)}
        >
          + 新会话
        </button>
        <button
          type="button"
          className="session-history-refresh"
          onClick={onRefresh}
          title="刷新"
        >
          ⟳
        </button>
      </div>

      {loading && <div className="session-history-loading">加载中…</div>}
      {!loading && entries !== undefined && entries.length === 0 && (
        <div className="session-history-empty">暂无会话</div>
      )}

      {entries?.map((entry) => (
        <div
          key={entry.id}
          className="session-history-entry"
          onClick={() => onResume(ws.id, entry)}
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
              ✕
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
