/**
 * 应用根组件：组装侧边栏 + 分屏区 + 对话框宿主，注册全局快捷键/主题，
 * 并实现「工作空间展开定位 / 新会话 / 恢复历史 / 新开 Shell」的落点与启动编排。
 *
 * 落点规则（Tab 化后）：
 *  ① 会话已在某 Tab → setActive(leaf) + activateTab（绝不覆盖当前窗格）
 *  ② 某未锁 leaf 仅含同 workspace 会话（不含异项目会话）→ 该 leaf 追加 Tab
 *  ③ 空 leaf（无 Tab 且未锁）→ 追加 Tab
 *  ④ 自动分屏（splitPane）→ 新 leaf 追加 Tab；全锁时 toast 提示
 * PTY 生命周期在 Rust，前端切换仅改 leaf.activeSessionId（TerminalPane 负责 attach/回放）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { PaneGrid } from "./components/PaneGrid/PaneGrid";
import { MainWallpaperLayer } from "./components/layout/MainWallpaperLayer";
import { ActivityBar } from "./components/layout/ActivityBar";
import { StatusBar } from "./components/layout/StatusBar";
import { TitleBar } from "./components/layout/TitleBar";
import { PanelLeftClose, PanelLeftOpen } from "./components/ui/icons";
import WorkspaceDialog from "./components/dialogs/WorkspaceDialog";
import TerminalCreateDialog, {
  type TerminalCreateOptions,
} from "./components/dialogs/TerminalCreateDialog";
import ConfirmDialog from "./components/dialogs/ConfirmDialog";
import { UsageView } from "./components/views/UsageView";
import { ProviderView } from "./components/views/ProviderView";
import { SettingsView } from "./components/views/SettingsView";
import { PaneTaskDrawer } from "./components/Tasks/PaneTaskDrawer";
import { useHotkeys } from "./hooks/useHotkeys";
import { useTheme } from "./hooks/useTheme";
import { selectProviders, useSettingsStore } from "./store/settingsStore";
import { DEFAULT_WALLPAPER } from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import { useLayoutStore, preorderLeaves } from "./store/layoutStore";
import { useSessionStore } from "./store/sessionStore";
import { useUiStore } from "./store/uiStore";
import { useTaskStore } from "./store/taskStore";
import {
  ptySpawn,
  ptyKill,
  appQuit,
  managedSessionList,
  managedSessionCreate,
  managedSessionUpdate,
  aiSessionDetect,
} from "./api/commands";
import { onSessionState, onSessionExit, onQuitRequest } from "./api/events";
import type { LeafNode, ManagedSession, SpawnRequest } from "./api/types";
import {
  resolveTerminalResumeSelection,
} from "./lib/providers";
import { planWorkspaceRestore, type RestoreAction } from "./lib/workspaceSnapshots";
import { nativeConversationTabId, parseNativeConversationTabId } from "./lib/nativeConversation";
import { workspaceIdForTab } from "./lib/workItems";

const INIT_COLS = 80;
const INIT_ROWS = 24;

/**
 * 通知侧边栏定位指定项目行。
 * @param workspaceId 目标工作空间 ID。
 * @returns 无返回值。
 */
function dispatchWorkspaceLocation(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent("app:locate-workspace", { detail: workspaceId }));
}

/**
 * "待命名"会话注册表：spawn 后登记 ptySessionId→{workspaceId, kind}，
 * 等 TerminalPane 检测到用户首次按 Enter 时，以输入行作为名称创建 ManagedSession。
 */
export const pendingSessions = new Map<
  string,
  { workspaceId: string; kind: string; providerId?: string }
>();
const resumingIds = new Set<string>();

type TerminalReleaseResult =
  | { status: "released" }
  | { status: "kill-failed"; error: unknown }
  | { status: "history-failed"; error: unknown };
const terminalReleasePromises = new Map<
  string,
  Promise<TerminalReleaseResult>
>();

interface RestoreActionContext {
  replaceSession: (leafId: string, oldTabId: string, newSessionId: string) => void;
}

/** 执行单个保存工作区恢复动作；失败只影响当前 Tab，不中断其它窗格。 */
async function applyRestoreAction(
  action: RestoreAction,
  context: RestoreActionContext,
): Promise<string | null> {
  if (action.kind === "error") {
    return action.message;
  }

  if (action.kind === "keep" || action.kind === "native") {
    context.replaceSession(action.leafId, action.oldTabId, action.sessionId);
    return null;
  }

  try {
    const info = await ptySpawn({
      workspaceId: action.ref.workspaceId,
      kind: action.ref.kind,
      providerId: action.ref.providerId,
      strictProvider: action.ref.kind !== "shell",
      resumeSessionId: action.managed?.aiSessionId,
      cols: INIT_COLS,
      rows: INIT_ROWS,
    });
    useSessionStore.getState().upsert(info);
    context.replaceSession(action.leafId, action.oldTabId, info.sessionId);

    if (action.managed) {
      const updated: ManagedSession = {
        ...action.managed,
        kind: info.kind,
        providerId: action.ref.providerId,
        ptySessionId: info.sessionId,
        updatedAt: new Date().toISOString(),
      };
      await managedSessionUpdate(updated);
      void useWorkspaceStore.getState().loadHistory(updated.workspaceId);
    } else {
      pendingSessions.set(info.sessionId, {
        workspaceId: action.ref.workspaceId,
        kind: action.ref.kind,
        providerId: action.ref.providerId,
      });
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "会话启动失败";
  }
}

/**
 * 用指定后端结果覆盖工作空间历史缓存。
 * @param workspaceId 目标工作空间 ID。
 * @param sessions 后端返回的完整 ManagedSession 列表。
 * @returns 无返回值。
 */
function replaceHistoryCache(
  workspaceId: string,
  sessions: ManagedSession[],
): void {
  useWorkspaceStore.setState((state) => ({
    historyCache: {
      ...state.historyCache,
      [workspaceId]: sessions,
    },
  }));
}

/**
 * 执行一次终端释放，并清理前端镜像与 ManagedSession 的运行时绑定。
 * @param sessionId 待释放的 PTY 会话 ID。
 * @returns 释放结果；区分终止失败与终止后历史同步失败。
 */
async function releaseTerminalSessionOnce(
  sessionId: string,
): Promise<TerminalReleaseResult> {
  const runtimeWorkspaceId = useSessionStore.getState().sessions[sessionId]?.workspaceId;
  const wasPending = pendingSessions.has(sessionId);
  try {
    await ptyKill(sessionId);
  } catch (error) {
    return { status: "kill-failed", error };
  }

  try {
    useSessionStore.getState().remove(sessionId);
    pendingSessions.delete(sessionId);

    let managedSession: ManagedSession | undefined;
    for (const list of Object.values(
      useWorkspaceStore.getState().historyCache,
    )) {
      managedSession = list.find((entry) => entry.ptySessionId === sessionId);
      if (managedSession) break;
    }
    if (!managedSession && runtimeWorkspaceId && !wasPending) {
      const listedSessions = await managedSessionList(runtimeWorkspaceId);
      replaceHistoryCache(runtimeWorkspaceId, listedSessions);
      managedSession = listedSessions.find(
        (entry) => entry.ptySessionId === sessionId,
      );
    }
    if (managedSession) {
      await managedSessionUpdate({
        ...managedSession,
        ptySessionId: undefined,
        updatedAt: new Date().toISOString(),
      });
      const refreshedSessions = await managedSessionList(managedSession.workspaceId);
      replaceHistoryCache(managedSession.workspaceId, refreshedSessions);
    }
    return { status: "released" };
  } catch (error) {
    return { status: "history-failed", error };
  }
}

/**
 * 合并同一终端的并发释放请求，避免重复执行非幂等后端操作。
 * @param sessionId 待释放的 PTY 会话 ID。
 * @returns 当前会话共享的释放结果 Promise。
 */
function releaseTerminalSession(
  sessionId: string,
): Promise<TerminalReleaseResult> {
  const existingPromise = terminalReleasePromises.get(sessionId);
  if (existingPromise) return existingPromise;

  const releasePromise = releaseTerminalSessionOnce(sessionId).finally(() => {
    terminalReleasePromises.delete(sessionId);
  });
  terminalReleasePromises.set(sessionId, releasePromise);
  return releasePromise;
}

/**
 * 把未知异常转换为适合 toast 展示的简短文本。
 * @param error 捕获到的未知异常。
 * @returns 非空错误信息。
 */
function releaseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error);
  return message || "未知错误";
}

/**
 * 判断两个窗格会话集合是否保持一致。
 * @param originalSessionIds 释放开始时的会话 ID。
 * @param currentSessionIds 当前窗格的会话 ID。
 * @returns 两边包含完全相同会话时返回 true。
 */
function hasSameSessions(
  originalSessionIds: readonly string[],
  currentSessionIds: readonly string[],
): boolean {
  const currentSessionSet = new Set(currentSessionIds);
  return originalSessionIds.length === currentSessionIds.length
    && originalSessionIds.every((sessionId) => currentSessionSet.has(sessionId));
}

/**
 * 按会话当前所在窗格移除已经终止的终端 Tab。
 * @param sessionIds 已成功终止的会话 ID。
 * @returns 无返回值。
 */
function removeReleasedTabsAtCurrentLocations(sessionIds: readonly string[]): void {
  const layout = useLayoutStore.getState();
  for (const sessionId of sessionIds) {
    const currentLeafId = layout.findLeafBySession(sessionId);
    if (currentLeafId) layout.closeTab(currentLeafId, sessionId);
  }
}

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

/**
 * 渲染应用根界面并注册全局事件编排。
 * @returns 应用根界面。
 */
export default function App(): React.JSX.Element {
  const [toast, setToast] = useState<string | null>(null);
  const closingSessionIdsRef = useRef(new Set<string>());
  const closingPaneIdsRef = useRef(new Set<string>());
  const [closingSessionIds, setClosingSessionIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [closingPaneIds, setClosingPaneIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampW(Number(localStorage.getItem(SIDEBAR_KEY)) || 240));
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const setSidebarVisible = useUiStore((state) => state.setSidebarVisible);
  const toggleSidebarVisibility = useUiStore((state) => state.toggleSidebar);
  const [sidebarLocateWorkspaceId, setSidebarLocateWorkspaceId] = useState<string | null>(null);
  const [terminalCreateOpen, setTerminalCreateOpen] = useState(false);
  const [terminalCreateWorkspaceId, setTerminalCreateWorkspaceId] = useState<string | undefined>();
  const [terminalCreateError, setTerminalCreateError] = useState<string | null>(null);
  const [terminalCreating, setTerminalCreating] = useState(false);
  const mainView = useUiStore((state) => state.mainView);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const providers = useSettingsStore(selectProviders);
  const wallpaper = useSettingsStore((state) => state.config?.wallpaper ?? DEFAULT_WALLPAPER);
  const wallpaperActive = wallpaper.enabled && wallpaper.kind === "image"
    && Boolean(wallpaper.dataUrl || wallpaper.file);
  const activeSavedWorkspaceId = useLayoutStore((state) => state.activeSavedWorkspaceId);
  const loadTasks = useTaskStore((state) => state.load);
  useHotkeys();
  useTheme();

  useEffect(() => {
    void loadTasks(activeSavedWorkspaceId ?? undefined);
  }, [activeSavedWorkspaceId, loadTasks]);

  /**
   * 清除侧边栏已消费的折叠定位请求。
   * @returns 无返回值。
   */
  const clearSidebarLocation = useCallback((): void => {
    setSidebarLocateWorkspaceId(null);
  }, []);

  const showToast = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2200);
  }, []);

  /**
   * 更新终端关闭中集合，并同步用于即时互斥的 ref。
   * @param sessionId 目标终端会话 ID。
   * @param closing 是否进入关闭中状态。
   * @returns 无返回值。
   */
  const setSessionClosing = useCallback((
    sessionId: string,
    closing: boolean,
  ): void => {
    const nextIds = new Set(closingSessionIdsRef.current);
    if (closing) nextIds.add(sessionId);
    else nextIds.delete(sessionId);
    closingSessionIdsRef.current = nextIds;
    setClosingSessionIds(nextIds);
  }, []);

  /**
   * 更新窗格关闭中集合，并同步用于即时互斥的 ref。
   * @param leafId 目标窗格 ID。
   * @param closing 是否进入关闭中状态。
   * @returns 无返回值。
   */
  const setPaneClosing = useCallback((leafId: string, closing: boolean): void => {
    const nextIds = new Set(closingPaneIdsRef.current);
    if (closing) nextIds.add(leafId);
    else nextIds.delete(leafId);
    closingPaneIdsRef.current = nextIds;
    setClosingPaneIds(nextIds);
  }, []);

  /**
   * 关闭一个 Tab；原生会话只关闭视图，终端会话完成资源释放后再关闭视图。
   * @param leafId Tab 所在窗格 ID。
   * @param sessionId 待关闭的 Tab 会话 ID。
   * @returns 关闭流程完成后解析。
   */
  const closeSessionTab = useCallback(async (
    leafId: string,
    sessionId: string,
  ): Promise<void> => {
    if (closingSessionIdsRef.current.has(sessionId)) return;
    const layout = useLayoutStore.getState();
    if (parseNativeConversationTabId(sessionId) !== null) {
      layout.closeTab(leafId, sessionId);
      return;
    }

    setSessionClosing(sessionId, true);
    try {
      const result = await releaseTerminalSession(sessionId);
      if (result.status === "kill-failed") {
        showToast(`终端关闭失败，Tab 已保留：${releaseErrorMessage(result.error)}`);
        return;
      }
      removeReleasedTabsAtCurrentLocations([sessionId]);
      if (result.status === "history-failed") {
        showToast(
          `终端已关闭，但历史同步失败：${releaseErrorMessage(result.error)}`,
        );
      }
    } finally {
      setSessionClosing(sessionId, false);
    }
  }, [setSessionClosing, showToast]);

  /**
   * 按 Tab 顺序释放窗格内的终端；仅终止失败保留窗格，历史同步失败统一提示。
   * @param leaf 待关闭窗格的当前快照。
   * @returns 关闭流程完成后解析。
   */
  const closeSessionPane = useCallback(async (leaf: LeafNode): Promise<void> => {
    if (closingPaneIdsRef.current.has(leaf.id)) return;
    setPaneClosing(leaf.id, true);
    const originalSavedWorkspaceId = useLayoutStore.getState().activeSavedWorkspaceId;
    const originalSessionIds = [...leaf.sessionIds];
    const releasedSessionIds: string[] = [];
    const historyErrors: unknown[] = [];
    try {
      for (const sessionId of originalSessionIds) {
        if (parseNativeConversationTabId(sessionId) !== null) continue;

        setSessionClosing(sessionId, true);
        const result = await releaseTerminalSession(sessionId).finally(() => {
          setSessionClosing(sessionId, false);
        });

        if (result.status === "kill-failed") {
          removeReleasedTabsAtCurrentLocations(releasedSessionIds);
          showToast(`终端关闭失败，窗格已保留：${releaseErrorMessage(result.error)}`);
          return;
        }
        releasedSessionIds.push(sessionId);
        if (result.status === "history-failed") historyErrors.push(result.error);
      }

      const layout = useLayoutStore.getState();
      const currentLeaf = preorderLeaves(layout.tree).find((item) => item.id === leaf.id);
      const contextUnchanged = layout.activeSavedWorkspaceId === originalSavedWorkspaceId
        && currentLeaf !== undefined
        && hasSameSessions(originalSessionIds, currentLeaf.sessionIds);
      if (!contextUnchanged) {
        removeReleasedTabsAtCurrentLocations(releasedSessionIds);
        const historyMessage = historyErrors.length > 0
          ? `；历史同步失败：${historyErrors.map(releaseErrorMessage).join("；")}`
          : "";
        showToast(`窗格内容已变化，已仅移除关闭的终端 Tab${historyMessage}`);
        return;
      }

      if (layout.tree.type === "leaf" && layout.tree.id === leaf.id) {
        for (const sessionId of currentLeaf.sessionIds) {
          layout.closeTab(leaf.id, sessionId);
        }
      } else {
        layout.closePane(leaf.id);
      }
      if (historyErrors.length > 0) {
        showToast(
          `终端已关闭，但历史同步失败：${historyErrors.map(releaseErrorMessage).join("；")}`,
        );
      }
    } finally {
      setPaneClosing(leaf.id, false);
    }
  }, [setPaneClosing, setSessionClosing, showToast]);

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
    const conversations = useWorkspaceStore.getState().historyCache;
    const leaves = preorderLeaves(tree);
    const match = (l: LeafNode) =>
      !l.locked &&
      l.sessionIds.some(
        (sid) => workspaceIdForTab(sid, sessions, conversations) === wsId,
      ) &&
      !l.sessionIds.some((sid) => {
        const tabWorkspaceId = workspaceIdForTab(sid, sessions, conversations);
        return tabWorkspaceId != null && tabWorkspaceId !== wsId;
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
    // 切回终端视图，确保 PaneGrid 可见
    useUiStore.getState().setMainView("panes");
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

  const openNativeConversation = useCallback(
    (conversation: ManagedSession): void => {
      // 切回终端视图，确保 PaneGrid 可见
      useUiStore.getState().setMainView("panes");
      const tabId = nativeConversationTabId(conversation.id);
      const layout = useLayoutStore.getState();
      const existing = layout.findLeafBySession(tabId);
      if (existing) {
        layout.setActive(existing);
        layout.activateTab(existing, tabId);
        return;
      }
      const leafId = pickLeafFor(conversation.workspaceId);
      if (!leafId) return;
      layout.setActive(leafId);
      layout.openSessionInLeaf(leafId, tabId);
    },
    [pickLeafFor],
  );

  /** spawn 后绑定到指定 leaf 的 Tab */
  const spawnInto = useCallback(async (leafId: string, req: SpawnRequest, rebindEntry?: ManagedSession): Promise<void> => {
    // 切回终端视图，确保 PaneGrid 可见
    useUiStore.getState().setMainView("panes");
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
        providerId: req.providerId,
      });
    }
  }, []);

  /** 打开指定项目的 AI 终端创建向导。 */
  const newSession = useCallback(
    (wsId: string): void => {
      setTerminalCreateWorkspaceId(wsId);
      setTerminalCreateError(null);
      setTerminalCreateOpen(true);
    },
    [],
  );

  /** 点击侧边栏已有会话：PTY 活着则聚焦，否则 resume */
  const resumeSession = useCallback(
    async (wsId: string, entry: ManagedSession): Promise<void> => {
      if (entry.mode === "native") {
        openNativeConversation(entry);
        return;
      }
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
        const providers = useSettingsStore.getState().config?.providers ?? [];
        const selection = resolveTerminalResumeSelection(entry, ws, providers);
        await spawnInto(leafId, {
          workspaceId: wsId,
          kind: selection.kind,
          providerId: selection.providerId,
          resumeSessionId: selection.resumeSessionId,
          cols: INIT_COLS,
          rows: INIT_ROWS,
        }, {
          ...entry,
          kind: selection.kind,
          aiSessionId: selection.resumeSessionId,
        });
      } finally {
        resumingIds.delete(entry.id);
      }
    },
    [openNativeConversation, openSession, pickLeafFor, spawnInto],
  );

  /** 打开终端创建向导；快捷入口默认定位当前活动工作区。 */
  const openTerminalCreate = useCallback((workspaceId?: string): void => {
    if (workspaces.length === 0) {
      showToast("请先创建项目");
      return;
    }
    setTerminalCreateWorkspaceId(workspaceId);
    setTerminalCreateError(null);
    setTerminalCreateOpen(true);
  }, [showToast, workspaces.length]);

  /** 提交终端创建向导，并在 spawn 失败时保留表单。 */
  const createTerminal = useCallback(async (options: TerminalCreateOptions): Promise<void> => {
    if (terminalCreating) return;
    const leafId = pickLeafFor(options.workspaceId);
    if (!leafId) return;
    setTerminalCreating(true);
    try {
      await spawnInto(leafId, {
        workspaceId: options.workspaceId,
        kind: options.kind,
        providerId: options.providerId,
        // 创建向导已显式选择 AI 类型，系统默认也不能回退到项目默认渠道商。
        strictProvider: true,
        executionMode: options.executionMode,
        cols: INIT_COLS,
        rows: INIT_ROWS,
      });
      setTerminalCreateOpen(false);
      setTerminalCreateError(null);
    } catch (error) {
      setTerminalCreateError(error instanceof Error ? error.message : "会话启动失败");
    } finally {
      setTerminalCreating(false);
    }
  }, [pickLeafFor, spawnInto, terminalCreating]);

  /** 保留纯 Shell 入口，仅用于项目右键菜单。 */
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
    if (workspaces.length === 0) { showToast("请先创建项目"); return; }
    let wsId: string | undefined;
    if (activePaneId && tree) {
      const leaves = preorderLeaves(tree);
      const active = leaves.find((l) => l.id === activePaneId);
      const sid = active?.activeSessionId;
      if (sid) {
        wsId = workspaceIdForTab(
          sid,
          useSessionStore.getState().sessions,
          useWorkspaceStore.getState().historyCache,
        ) ?? undefined;
      }
    }
    if (!wsId) wsId = workspaces[0].id;
    openTerminalCreate(wsId);
  }, [openTerminalCreate, showToast]);

  /**
   * 恢复保存工作区：先用稳定引用规划动作，再复用存活 PTY 或重建已失效会话。
   * 供应商 ID 始终来自快照引用，避免恢复时被项目默认供应商静默替换。
   */
  const restoreSavedWorkspace = useCallback(async (savedWorkspaceId: string): Promise<void> => {
    const layout = useLayoutStore.getState();
    const snapshot = layout.savedWorkspaces.find((item) => item.id === savedWorkspaceId);
    if (!snapshot) return;

    const workspaceStore = useWorkspaceStore.getState();
    if (workspaceStore.loadAllHistories) {
      await workspaceStore.loadAllHistories();
    }
    const currentWorkspaceStore = useWorkspaceStore.getState();
    const settings = useSettingsStore.getState();
    const config = settings.config;
    if (!config) {
      showToast("配置尚未加载，暂时无法恢复工作区");
      return;
    }

    const managedSessions = Object.values(currentWorkspaceStore.historyCache).flat();
    const actions = planWorkspaceRestore({
      snapshot,
      runtimeSessions: useSessionStore.getState().sessions,
      managedSessions,
      workspaces: currentWorkspaceStore.workspaces,
      providers: config.providers,
    });

    // 先切换到快照骨架，后续动作只做原位替换，避免分屏比例和锁定状态被破坏。
    layout.restoreSavedWorkspace(savedWorkspaceId);
    const restoreErrors: string[] = [];
    for (const action of actions) {
      const actionError = await applyRestoreAction(action, {
        replaceSession: layout.replaceSession,
      });
      if (actionError) {
        restoreErrors.push(actionError);
        layout.closeTab(action.leafId, action.oldTabId);
        layout.setRestoreError(action.leafId, actionError);
      }
    }
    layout.persist();
    if (restoreErrors.length > 0) {
      showToast(`工作区恢复完成，但有 ${restoreErrors.length} 个会话未恢复`);
    }
  }, [showToast]);

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
        providerId: pending.providerId,
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
    /**
     * 展开快捷键对应项目，并在侧边栏可见后定位项目行。
     * @param event 包含项目排序索引的激活事件。
     * @returns 无返回值。
     */
    const onActivateIdx = (e: Event): void => {
      const idx = (e as CustomEvent<number>).detail;
      const workspaceStore = useWorkspaceStore.getState();
      const ordered = [...workspaceStore.workspaces].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      const ws = ordered[idx];
      if (!ws) return;
      if (!workspaceStore.expandedIds.has(ws.id)) {
        workspaceStore.toggleExpand(ws.id);
      }
      if (!sidebarVisible) {
        setSidebarLocateWorkspaceId(ws.id);
        setSidebarVisible(true);
        return;
      }
      dispatchWorkspaceLocation(ws.id);
    };
    window.addEventListener("app:activate-workspace", onActivateIdx as EventListener);
    return () => window.removeEventListener("app:activate-workspace", onActivateIdx as EventListener);
  }, [setSidebarVisible, sidebarVisible]);

  const toggleSidebar = useCallback((): void => {
    toggleSidebarVisibility();
    window.setTimeout(() => window.dispatchEvent(new Event("app:refit")), 50);
  }, [toggleSidebarVisibility]);

  // 切回终端视图时终端刚从 hidden 恢复，尺寸为 0，需重新 fit 一次。
  useEffect(() => {
    if (mainView !== "panes") return;
    window.setTimeout(() => window.dispatchEvent(new Event("app:refit")), 50);
  }, [mainView]);

  return (
    <div className="app-frame">
      <TitleBar />
      <div
        className="app-shell"
        style={!sidebarVisible ? undefined : { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <ActivityBar />
        {sidebarVisible && (
          <>
            <Sidebar
              locateWorkspaceId={sidebarLocateWorkspaceId}
              onLocateWorkspaceHandled={clearSidebarLocation}
              onResume={resumeSession}
              onNewShell={newShell}
              onNewSession={newSession}
              onQuickShell={quickShell}
              onRestoreSavedWorkspace={(savedWorkspaceId) => {
                void restoreSavedWorkspace(savedWorkspaceId);
              }}
            />
            <div className="sidebar-resizer" onMouseDown={startSidebarDrag} />
          </>
        )}
        <main className="app-main">
          <button
            type="button"
            className={`sidebar-toggle${!sidebarVisible ? " sidebar-toggle-visible" : ""}`}
            onClick={toggleSidebar}
            title={!sidebarVisible ? "显示侧边栏" : "隐藏侧边栏"}
          >
            {!sidebarVisible
              ? <PanelLeftOpen size={16} strokeWidth={1.5} />
              : <PanelLeftClose size={16} strokeWidth={1.5} />}
          </button>
          {/* PaneGrid 始终挂载：卸载会销毁 xterm 实例并丢失 PTY 输出回放，
              故切走时仅隐藏，切回时派发 app:refit 让终端重新适配尺寸。 */}
          <div
            className={`pane-workspace-shell${wallpaperActive ? " wallpaper-active" : ""}`}
            style={
              {
                display: mainView === "panes" ? "flex" : "none",
                "--wallpaper-glass-blur": `${wallpaper.glassBlur}px`,
                "--wallpaper-terminal-opacity": wallpaper.terminalOpacity,
              } as React.CSSProperties
            }
          >
            <MainWallpaperLayer />
            <div className="pane-workspace-content">
              <div className="pane-grid-wrap">
                <PaneGrid
                  onCloseTab={closeSessionTab}
                  onClosePane={closeSessionPane}
                  closingSessionIds={closingSessionIds}
                  closingPaneIds={closingPaneIds}
                  onCreateTerminal={openTerminalCreate}
                />
              </div>
            </div>
          </div>
          {mainView === "usage" && <UsageView />}
          {mainView === "providers" && <ProviderView />}
          {mainView === "settings" && <SettingsView />}
        </main>

        <WorkspaceDialog />
        <TerminalCreateDialog
          open={terminalCreateOpen}
          workspaces={workspaces}
          providers={providers}
          initialWorkspaceId={terminalCreateWorkspaceId}
          error={terminalCreateError}
          creating={terminalCreating}
          onClose={() => {
            setTerminalCreateOpen(false);
            setTerminalCreateError(null);
          }}
          onCreate={createTerminal}
        />
        <ConfirmDialog />
        <PaneTaskDrawer />

        {toast && <div className="app-toast">{toast}</div>}
      </div>
      <StatusBar />
    </div>
  );
}
