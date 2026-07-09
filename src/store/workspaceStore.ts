/**
 * 工作空间 store：工作空间列表 CRUD、展开状态、每工作空间历史会话缓存。
 * 历史会话懒加载（展开子菜单时才拉取），失败与加载态在此维护。
 */
import { create } from "zustand";
import type { Workspace, ManagedSession } from "../api/types";
import {
  workspaceList,
  workspaceSave,
  workspaceDelete,
  managedSessionList,
} from "../api/commands";

/** 跨工作空间最近会话条目（「对话」组数据源） */
export interface RecentSessionEntry extends ManagedSession {
  workspaceName: string;
}

/** 从 historyCache 聚合跨空间最近会话（纯函数，组件 useMemo 调用） */
export function selectRecentSessions(
  cache: Record<string, ManagedSession[]>,
  workspaces: Workspace[],
  limit = 15,
): RecentSessionEntry[] {
  const wsMap = new Map(workspaces.map((w) => [w.id, w.name]));
  const all: RecentSessionEntry[] = [];
  for (const [wsId, entries] of Object.entries(cache)) {
    const wsName = wsMap.get(wsId) ?? "";
    for (const e of entries) {
      all.push({ ...e, workspaceName: wsName });
    }
  }
  all.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return all.slice(0, limit);
}

interface WorkspaceState {
  workspaces: Workspace[];
  expandedIds: Set<string>;
  historyCache: Record<string, ManagedSession[]>;
  historyLoading: Record<string, boolean>;
  load: () => Promise<void>;
  save: (ws: Workspace) => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggleExpand: (id: string) => void;
  loadHistory: (id: string) => Promise<void>;
  loadAllHistories: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  expandedIds: new Set<string>(),
  historyCache: {},
  historyLoading: {},

  load: async () => {
    const workspaces = await workspaceList();
    set({ workspaces });
  },

  save: async (ws) => {
    await workspaceSave(ws);
    await get().load();
  },

  remove: async (id) => {
    await workspaceDelete(id);
    await get().load();
  },

  toggleExpand: (id) => {
    const next = new Set(get().expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ expandedIds: next });
  },

  loadHistory: async (id) => {
    set((s) => ({ historyLoading: { ...s.historyLoading, [id]: true } }));
    try {
      const entries = await managedSessionList(id);
      set((s) => ({
        historyCache: { ...s.historyCache, [id]: entries },
        historyLoading: { ...s.historyLoading, [id]: false },
      }));
    } catch {
      set((s) => ({ historyLoading: { ...s.historyLoading, [id]: false } }));
    }
  },

  /** 并行预热全部工作空间的 historyCache（「对话」组数据源） */
  loadAllHistories: async () => {
    const { workspaces, loadHistory } = get();
    await Promise.allSettled(workspaces.map((ws) => loadHistory(ws.id)));
  },
}));
