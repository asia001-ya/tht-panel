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

/** workspaceStore 状态与动作定义 */
interface WorkspaceState {
  workspaces: Workspace[]; // 全部工作空间，按 sortOrder 顺序由后端返回
  expandedIds: Set<string>; // 侧边栏已展开（显示会话子菜单）的工作空间 id 集合
  historyCache: Record<string, ManagedSession[]>; // 工作空间 id → 自管会话列表缓存
  historyLoading: Record<string, boolean>; // 工作空间 id → 是否加载中
  /** 从后端拉取工作空间列表覆盖本地 */
  load: () => Promise<void>;
  /** 保存（新增或更新）一个工作空间后刷新列表 */
  save: (ws: Workspace) => Promise<void>;
  /** 删除指定工作空间后刷新列表 */
  remove: (id: string) => Promise<void>;
  /** 切换某工作空间的展开/收起状态 */
  toggleExpand: (id: string) => void;
  /** 加载指定工作空间的自管会话到缓存 */
  loadHistory: (id: string) => Promise<void>;
}

/** 工作空间 store */
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  expandedIds: new Set<string>(),
  historyCache: {},
  historyLoading: {},

  /** 从后端拉取工作空间列表覆盖本地 */
  load: async () => {
    const workspaces = await workspaceList();
    set({ workspaces });
  },

  /** 保存（新增或更新）一个工作空间后刷新列表 */
  save: async (ws) => {
    await workspaceSave(ws);
    await get().load();
  },

  /** 删除指定工作空间后刷新列表 */
  remove: async (id) => {
    await workspaceDelete(id);
    await get().load();
  },

  /** 切换某工作空间的展开/收起状态（不可变更新 Set） */
  toggleExpand: (id) => {
    const next = new Set(get().expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ expandedIds: next });
  },

  /** 加载指定工作空间的自管会话到缓存，维护 loading 态 */
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
}));
