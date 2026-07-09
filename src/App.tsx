/**
 * 应用根组件：组装侧边栏 + 分屏区 + 对话框宿主，注册全局快捷键/主题，
 * 并实现「工作空间激活 / 新会话 / 恢复历史 / 新开 Shell」的落点与启动编排。
 *
 * 落点规则（Tab 化后）：
 *  ① 会话已在某 Tab → setActive(leaf) + activateTab（绝不覆盖当前窗格）
 *  ② 某未锁 leaf 仅含同 workspace 会话（不含异项目会话）→ 该 leaf 追加 Tab
 *  ③ 空 leaf（无 Tab 且未锁）→ 追加 Tab
 *  ④ 自动分屏（splitPane）→ 新 leaf 追加 Tab；全锁时 toast 提示
 * PTY 生命周期在 Rust，前端切换仅改 leaf.activeSessionId（TerminalPane 负责 attach/回放）。
 */
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { PaneGrid } from "./components/PaneGrid/PaneGrid";
import { PanelLeftClose, PanelLeftOpen } from "./components/ui/icons";
import WorkspaceDialog from "./components/dialogs/WorkspaceDialog";
import SettingsDialog from "./components/dialogs/SettingsDialog";
import ConfirmDialog from "./components/dialogs/ConfirmDialog";
import { useHotkeys } from "./hooks/useHotkeys";
import { useTheme } from "./hooks/useTheme";
import { useSettingsStore } from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import { useLayoutStore, preorderLeaves } from "./store/layoutStore";
import { useSessionStore, latestForWorkspace } from "./store/sessionStore";
import { useUiStore } from "./store/uiStore";
import { ptySpawn, appQuit, managedSessionCreate, managedSessionUpdate, aiSessionDetect } from "./api/commands";
import { onSessionState, onSessionExit, onQuitRequest } from "./api/events";
import type { LeafNode, ManagedSession, SpawnRequest } from "./api/types";

const INIT_COLS = 80;
const INIT_ROWS = 24;

/**
 * "待命名"会话注册表：spawn 后登记 ptySessionId→{workspaceId, kind}，
 * 等 TerminalPane 检测到用户首次按 Enter 时，以输入行作为名称创建 ManagedSession。
 */
export const pendingSessions = new Map<string, { workspaceId: string; kind: string }>();
const resumingIds = new Set<string>();

function scheduleAiDetect(
  managed: ManagedSession,
  spawnedAt: string,
  delays = [1500, 3500, 8000],
): void {
  const wsId = managed.workspaceId;
  let attempt = 0;
  const tryDetect = (): void => {
    const cache = useWorkspaceStore.getState().historyCache[wsId] ?? [];
    const exclude = cache
      .map((m) => m.aiSessionId)
      .filter((id): id is string => id != null && id !== "");
    void aiSessionDetect({
      workspaceId: wsId,
      kind: managed.kind,
      spawnedAt,
      exclude,
    }).then((detectedId) => {
      if (detectedId) {
        const fresh = (useWorkspaceStore.getState().historyCache[wsId] ?? [])
          .find((m) => m.id === managed.id);
        if (fresh) {
          void managedSessionUpdate({ ...fresh, aiSessionId: detectedId, updatedAt: new Date().toISOString() });
          void useWorkspaceStore.getState().loadHistory(wsId);
        }
      } else if (attempt < delays.length) {
        window.setTimeout(tryDetect, delays[attempt++]);
      }
    }).catch(() => {});
  };
  if (delays.length > 0) {
    window.setTimeout(tryDetect, delays[attempt++]);
  }
}

const SIDEBAR_KEY = "tht-panel:sidebarWidth";
const clampW = (w: number) => Math.min(480, Math.max(180, w));

export default function App() {
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampW(Number(localStorage.getItem(SIDEBAR_KEY)) || 240));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useHotkeys();
  useTheme();

  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2200);
  }, []);

  const startSidebarDrag = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let raf = 0;
    const onMove = (ev: MouseEvent): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setSidebarWidth(clampW(startW + ev.clientX - startX));
        window.dispatchEvent(new Event("app:refit"));
      });
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((w) => { localStorage.setItem(SIDEBAR_KEY, String(w)); return w; });
      window.dispatchEvent(new Event("app:refit"));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  /** 取落点 leaf；全锁时提示并返回 null */
  const pickLeaf = useCallback((): string | null => {
    const id = useLayoutStore.getState().findTargetLeaf();
    if (!id) showToast("所有分屏已锁定，请先解锁一个分屏");
    return id;
  }, [showToast]);

  /** 找正在显示同 workspace 会话且不含异项目会话的未锁 leaf（活动优先） */
  const findLeafForWorkspace = useCallback((wsId: string): string | null => {
    const { tree, activePaneId } = useLayoutStore.getState();
    const sessions = useSessionStore.getState().sessions;
    const leaves = preorderLeaves(tree);
    const match = (l: LeafNode) =>
      !l.locked &&
      l.sessionIds.some((sid) => sessions[sid]?.workspaceId === wsId) &&
      !l.sessionIds.some((sid) => {
        const w = sessions[sid]?.workspaceId;
        return w != null && w !== wsId;
      });
    const active = leaves.find((l) => l.id === activePaneId);
    if (active && match(active)) return active.id;
    return leaves.find(match)?.id ?? null;
  }, []);

  /** 找未锁且无 Tab 的空 leaf：活动优先，否则先序第一个 */
  const findEmptyLeaf = useCallback((): string | null => {
    const { tree, activePaneId } = useLayoutStore.getState();
    const leaves = preorderLeaves(tree);
    const isEmpty = (l: LeafNode) => !l.locked && l.sessionIds.length === 0;
    const active = leaves.find((l) => l.id === activePaneId);
    if (active && isEmpty(active)) return active.id;
    return leaves.find(isEmpty)?.id ?? null;
  }, []);

  /** 落点选择：① 同项目同质 leaf → ② 空 leaf → ③ 自动分屏 */
  const pickLeafFor = useCallback((wsId?: string): string | null => {
    if (!wsId) return pickLeaf();
    const same = findLeafForWorkspace(wsId);
    if (same) return same;
    const empty = findEmptyLeaf();
    if (empty) return empty;
    const base = useLayoutStore.getState().findTargetLeaf();
    if (!base) { showToast("所有分屏已锁定，请先解锁一个分屏"); return null; }
    return useLayoutStore.getState().splitPane(base, "horizontal");
  }, [findLeafForWorkspace, findEmptyLeaf, pickLeaf, showToast]);

  /**
   * 统一打开已存在的 PTY 会话（需求 2 核心）：
   * ① 已在某 Tab → 激活那个窗格+Tab ② 同项目窗格追加 ③ 落点追加
   */
  const openSession = useCallback((sessionId: string): void => {
    const ls = useLayoutStore.getState();
    const existing = ls.findLeafBySession(sessionId);
    if (existing) {
      ls.setActive(existing);
      ls.activateTab(existing, sessionId);
      return;
    }
    const wsId = useSessionStore.getState().sessions[sessionId]?.workspaceId ?? undefined;
    const leafId = pickLeafFor(wsId);
    if (!leafId) return;
    ls.setActive(leafId);
    ls.openSessionInLeaf(leafId, sessionId);
  }, [pickLeafFor]);

  /** spawn 后绑定到指定 leaf 的 Tab */
  const spawnInto = useCallback(async (leafId: string, req: SpawnRequest, rebindEntry?: ManagedSession): Promise<void> => {
    const info = await ptySpawn(req);
    useSessionStore.getState().upsert(info);
    const ls = useLayoutStore.getState();
    ls.setActive(leafId);
    ls.openSessionInLeaf(leafId, info.sessionId);
    if (rebindEntry) {
      const now = new Date().toISOString();
      await managedSessionUpdate({
        ...rebindEntry,
        ptySessionId: info.sessionId,
        updatedAt: now,
      });
      if (req.workspaceId) void useWorkspaceStore.getState().loadHistory(req.workspaceId);
      if (req.resumeSessionId) {
        scheduleAiDetect({ ...rebindEntry, ptySessionId: info.sessionId }, now, [5000, 15000]);
      }
    } else {
      pendingSessions.set(info.sessionId, {
        workspaceId: req.workspaceId ?? "",
        kind: info.kind,
      });
    }
  }, []);

  /** 点击工作空间：聚焦最近活跃会话或新建 */
  const activateWorkspace = useCallback(
    async (wsId: string): Promise<void> => {
      const latest = latestForWorkspace(wsId);
      if (latest) {
        openSession(latest.sessionId);
        return;
      }
      const leafId = pickLeafFor(wsId);
      if (!leafId) return;
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: ws.agent, cols: INIT_COLS, rows: INIT_ROWS });
    },
    [openSession, pickLeafFor, spawnInto],
  );

  /** 「+ 新会话」 */
  const newSession = useCallback(
    async (wsId: string): Promise<void> => {
      const leafId = pickLeafFor(wsId);
      if (!leafId) return;
      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: ws.agent, cols: INIT_COLS, rows: INIT_ROWS });
    },
    [pickLeafFor, spawnInto],
  );

  /** 点击侧边栏已有会话：PTY 活着则聚焦，否则 resume */
  const resumeSession = useCallback(
    async (wsId: string, entry: ManagedSession): Promise<void> => {
      if (entry.ptySessionId) {
        const live = useSessionStore.getState().sessions[entry.ptySessionId];
        if (live && live.state !== "dead") {
          openSession(entry.ptySessionId);
          return;
        }
        // 清理旧 dead Tab（防同一会话 resume 后出现双 Tab）
        const ls = useLayoutStore.getState();
        const oldLeaf = ls.findLeafBySession(entry.ptySessionId);
        if (oldLeaf) ls.closeTab(oldLeaf, entry.ptySessionId);
      }
      if (resumingIds.has(entry.id)) return;
      resumingIds.add(entry.id);
      try {
        const leafId = pickLeafFor(wsId);
        if (!leafId) return;
        const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId);
        if (!ws) return;
        await spawnInto(leafId, {
          workspaceId: wsId,
          kind: entry.kind,
          resumeSessionId: entry.aiSessionId,
          cols: INIT_COLS,
          rows: INIT_ROWS,
        }, entry);
      } finally {
        resumingIds.delete(entry.id);
      }
    },
    [openSession, pickLeafFor, spawnInto],
  );

  /** 新开纯 Shell */
  const newShell = useCallback(
    async (wsId: string): Promise<void> => {
      const leafId = pickLeafFor(wsId);
      if (!leafId) return;
      await spawnInto(leafId, { workspaceId: wsId, kind: "shell", cols: INIT_COLS, rows: INIT_ROWS });
    },
    [pickLeafFor, spawnInto],
  );

  /** 快捷新开终端：取活动 pane 所属工作空间 */
  const quickShell = useCallback((): void => {
    const { activePaneId, tree } = useLayoutStore.getState();
    const workspaces = useWorkspaceStore.getState().workspaces;
    if (workspaces.length === 0) { showToast("请先创建工作空间"); return; }
    let wsId: string | undefined;
    if (activePaneId && tree) {
      const leaves = preorderLeaves(tree);
      const active = leaves.find((l) => l.id === activePaneId);
      const sid = active?.activeSessionId;
      if (sid) {
        const s = useSessionStore.getState().sessions[sid];
        if (s?.workspaceId) wsId = s.workspaceId;
      }
    }
    if (!wsId) wsId = workspaces[0].id;
    void newShell(wsId);
  }, [newShell, showToast]);

  // 启动
  useEffect(() => {
    void useSettingsStore.getState().load();
    void useWorkspaceStore.getState().load();
    void useLayoutStore.getState().load();
    void useSessionStore.getState().syncFromBackend();
  }, []);

  // 用户首次 Enter → 创建 ManagedSession
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
      scheduleAiDetect(managed, now);
    };
    window.addEventListener("app:session-named", onNamed as EventListener);
    return () => window.removeEventListener("app:session-named", onNamed as EventListener);
  }, []);

  // 后端事件
  useEffect(() => {
    const pending = [
      onSessionState((p) => useSessionStore.getState().setState(p.sessionId, p.state)),
      onSessionExit((p) => {
        const session = useSessionStore.getState().sessions[p.sessionId];
        useSessionStore.getState().setState(p.sessionId, "dead");
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

  // Ctrl+1..9
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

  const toggleSidebar = useCallback((): void => {
    setSidebarCollapsed((c) => !c);
    window.setTimeout(() => window.dispatchEvent(new Event("app:refit")), 50);
  }, []);

  return (
    <div className="app-shell" style={sidebarCollapsed ? undefined : { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      {!sidebarCollapsed && (
        <>
          <Sidebar
            onActivate={activateWorkspace}
            onResume={resumeSession}
            onNewShell={newShell}
            onNewSession={newSession}
            onQuickShell={quickShell}
          />
          <div className="sidebar-resizer" onMouseDown={startSidebarDrag} />
        </>
      )}
      <main className="app-main">
        <button
          type="button"
          className={`sidebar-toggle${sidebarCollapsed ? " sidebar-toggle-visible" : ""}`}
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}
        >
          {sidebarCollapsed
            ? <PanelLeftOpen size={16} strokeWidth={1.5} />
            : <PanelLeftClose size={16} strokeWidth={1.5} />}
        </button>
        <div className="pane-grid-wrap">
          <PaneGrid />
        </div>
      </main>

      <WorkspaceDialog />
      <SettingsDialog />
      <ConfirmDialog />

      {toast && <div className="app-toast">{toast}</div>}
    </div>
  );
}
