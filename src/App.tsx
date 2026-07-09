/**
 * 应用根组件：组装侧边栏 + 分屏区 + 对话框宿主，注册全局快捷键/主题，
 * 并实现「工作空间激活 / 新会话 / 恢复历史 / 新开 Shell」的落点与启动编排。
 *
 * 落点规则：所有起会话动作都先 layoutStore.findTargetLeaf() 找落点分屏
 *（活动且未锁 → 先序第一个未锁 → 全锁则提示），再把新/旧会话绑定到该 leaf。
 * PTY 生命周期在 Rust，前端切换仅改 leaf.sessionId（TerminalPane 负责 attach/回放）。
 */
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { PaneGrid } from "./components/PaneGrid/PaneGrid";
import WorkspaceDialog from "./components/dialogs/WorkspaceDialog";
import SettingsDialog from "./components/dialogs/SettingsDialog";
import ConfirmDialog from "./components/dialogs/ConfirmDialog";
import { useHotkeys } from "./hooks/useHotkeys";
import { useTheme } from "./hooks/useTheme";
import { useSettingsStore } from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import { useLayoutStore } from "./store/layoutStore";
import { useSessionStore, latestForWorkspace } from "./store/sessionStore";
import { useUiStore } from "./store/uiStore";
import { ptySpawn, appQuit, managedSessionCreate } from "./api/commands";
import { onSessionState, onSessionExit, onQuitRequest } from "./api/events";
import type { ManagedSession, SpawnRequest } from "./api/types";

// 新会话初始行列（占位）。TerminalPane 挂载后 FitAddon 会立即用真实尺寸 ptyResize 覆盖。
const INIT_COLS = 80;
const INIT_ROWS = 24;

/**
 * "待命名"会话注册表：spawn 后登记 ptySessionId→{workspaceId, kind}，
 * 等 TerminalPane 检测到用户首次按 Enter 时，以输入行作为名称创建 ManagedSession。
 * 创建后从此表移除。
 */
export const pendingSessions = new Map<string, { workspaceId: string; kind: string }>();

/** 应用根组件 */
export default function App() {
  const [toast, setToast] = useState<string | null>(null);
  useHotkeys(); // 全局快捷键（Ctrl+1..9 / Ctrl+Shift+F / Ctrl+=,-）
  useTheme(); // 主题应用到 DOM + 所有 xterm

  /** 显示一条短暂的顶部提示（2.2s 自动消失） */
  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2200);
  }, []);

  /** 取落点 leaf；全锁时提示并返回 null */
  const pickLeaf = useCallback((): string | null => {
    const id = useLayoutStore.getState().findTargetLeaf();
    if (!id) showToast("所有分屏已锁定，请先解锁一个分屏");
    return id;
  }, [showToast]);

  /** 起一个新会话并绑定到指定落点 leaf。不立即创建 ManagedSession，
   *  而是登记到 pendingSessions 等用户首次发送指令时再创建（以首条指令为名称）。 */
  const spawnInto = useCallback(async (leafId: string, req: SpawnRequest, sessionName?: string): Promise<void> => {
    const info = await ptySpawn(req);
    useSessionStore.getState().upsert(info);
    useLayoutStore.getState().assignSession(leafId, info.sessionId);
    if (sessionName) {
      // 已有名称（如恢复旧会话）→ 直接创建记录
      const now = new Date().toISOString();
      const managed: ManagedSession = {
        id: crypto.randomUUID(),
        workspaceId: req.workspaceId ?? "",
        name: sessionName,
        kind: info.kind as ManagedSession["kind"],
        ptySessionId: info.sessionId,
        aiSessionId: req.resumeSessionId,
        createdAt: now,
        updatedAt: now,
      };
      await managedSessionCreate(managed);
      if (req.workspaceId) void useWorkspaceStore.getState().loadHistory(req.workspaceId);
    } else {
      // 新会话→登记待命名，等 TerminalPane 检测到首次 Enter 再创建
      pendingSessions.set(info.sessionId, {
        workspaceId: req.workspaceId ?? "",
        kind: info.kind,
      });
    }
  }, []);

  /** 点击工作空间：聚焦该空间最近活跃会话；没有则按其 agent 新建 */
  const activateWorkspace = useCallback(
    async (wsId: string): Promise<void> => {
      const leafId = pickLeaf();
      if (!leafId) return;
      const latest = latestForWorkspace(wsId);
      if (latest) {
        useLayoutStore.getState().assignSession(leafId, latest.sessionId);
        return;
      }
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: ws.agent, cols: INIT_COLS, rows: INIT_ROWS });
    },
    [pickLeaf, spawnInto],
  );

  /** 「+ 新会话」：无条件按工作空间 agent 新建一个会话（与聚焦最近区分） */
  const newSession = useCallback(
    async (wsId: string): Promise<void> => {
      const leafId = pickLeaf();
      if (!leafId) return;
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: ws.agent, cols: INIT_COLS, rows: INIT_ROWS });
    },
    [pickLeaf, spawnInto],
  );

  /** 点击左侧已有会话：若 PTY 还活着则直接聚焦，否则 resume 新建 */
  const resumeSession = useCallback(
    async (wsId: string, entry: ManagedSession): Promise<void> => {
      const leafId = pickLeaf();
      if (!leafId) return;
      // 若该自管会话绑定的 PTY 还活着，直接聚焦（不重复 spawn）
      if (entry.ptySessionId) {
        const live = useSessionStore.getState().sessions[entry.ptySessionId];
        if (live && live.state !== "dead") {
          useLayoutStore.getState().assignSession(leafId, entry.ptySessionId);
          return;
        }
      }
      // PTY 已死或无绑定：重新 spawn（可能 resume AI 会话）
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      await spawnInto(leafId, {
        workspaceId: wsId,
        kind: entry.kind,
        resumeSessionId: entry.aiSessionId,
        cols: INIT_COLS,
        rows: INIT_ROWS,
      }, entry.name);
    },
    [pickLeaf, spawnInto],
  );

  /** 新开纯 PowerShell 会话（挂在该工作空间目录下） */
  const newShell = useCallback(
    async (wsId: string): Promise<void> => {
      const leafId = pickLeaf();
      if (!leafId) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: "shell", cols: INIT_COLS, rows: INIT_ROWS });
    },
    [pickLeaf, spawnInto],
  );

  // 启动：并行加载配置/工作空间/布局，并同步后端存活会话（HMR/重开后可重新聚焦）
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useWorkspaceStore.getState().load();
    void useLayoutStore.getState().load();
    void useSessionStore.getState().syncFromBackend();
  }, []);

  // 监听 TerminalPane 派发的 "app:session-named"：用户首次按 Enter，以输入行创建 ManagedSession
  useEffect(() => {
    const onNamed = async (e: Event): Promise<void> => {
      const { sessionId, name } = (e as CustomEvent<{ sessionId: string; name: string }>).detail;
      const pending = pendingSessions.get(sessionId);
      if (!pending) return;
      pendingSessions.delete(sessionId);
      const now = new Date().toISOString();
      const managed: ManagedSession = {
        id: crypto.randomUUID(),
        workspaceId: pending.workspaceId,
        name: name || "新会话",
        kind: pending.kind as ManagedSession["kind"],
        ptySessionId: sessionId,
        createdAt: now,
        updatedAt: now,
      };
      await managedSessionCreate(managed);
      if (pending.workspaceId) void useWorkspaceStore.getState().loadHistory(pending.workspaceId);
    };
    window.addEventListener("app:session-named", onNamed as EventListener);
    return () => window.removeEventListener("app:session-named", onNamed as EventListener);
  }, []);

  // 订阅后端会话事件：状态徽标 / 退出置 dead / 托盘退出确认
  useEffect(() => {
    const pending = [
      onSessionState((p) => useSessionStore.getState().setState(p.sessionId, p.state)),
      onSessionExit((p) => {
        const session = useSessionStore.getState().sessions[p.sessionId];
        useSessionStore.getState().setState(p.sessionId, "dead");
        // 会话退出后延迟刷新历史（等 claude/codex 写完 sessions-index.json）
        if (session?.workspaceId) {
          const wsId = session.workspaceId;
          window.setTimeout(() => void useWorkspaceStore.getState().loadHistory(wsId), 1500);
        }
      }),
      onQuitRequest(() => {
        useUiStore.getState().openConfirm({
          title: "退出 tht-panel",
          message: "仍有活跃会话，退出将终止全部终端。确定退出？",
          onConfirm: () => void appQuit(true),
        });
      }),
    ];
    return () => {
      for (const p of pending) void p.then((un) => un());
    };
  }, []);

  // Ctrl+1..9（useHotkeys 派发 app:activate-workspace，detail=排序后索引）→ 激活对应工作空间
  useEffect(() => {
    const onActivateIdx = (e: Event): void => {
      const idx = (e as CustomEvent<number>).detail;
      const ordered = [...useWorkspaceStore.getState().workspaces].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      const ws = ordered[idx];
      if (ws) void activateWorkspace(ws.id);
    };
    window.addEventListener("app:activate-workspace", onActivateIdx as EventListener);
    return () => window.removeEventListener("app:activate-workspace", onActivateIdx as EventListener);
  }, [activateWorkspace]);

  return (
    <div className="app-shell">
      <Sidebar
        onActivate={activateWorkspace}
        onResume={resumeSession}
        onNewShell={newShell}
        onNewSession={newSession}
      />
      <main className="app-main">
        <PaneGrid />
      </main>

      {/* 对话框宿主：各自受 uiStore 控制显隐 */}
      <WorkspaceDialog />
      <SettingsDialog />
      <ConfirmDialog />

      {/* 顶部瞬时提示 */}
      {toast && <div className="app-toast">{toast}</div>}
    </div>
  );
}
