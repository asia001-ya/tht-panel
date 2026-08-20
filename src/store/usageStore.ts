/**
 * Token 用量 store：持有仪表盘的查询结果与筛选条件。
 *
 * 与 settingsStore 的区别：此处数据是只读派生结果（后端扫描 JSONL 得出），
 * 前端不写回，故无防抖持久化逻辑。
 */
import { create } from "zustand";
import type { UsageQueryResult } from "../api/types";
import { usageQuery, usageRefresh } from "../api/commands";

/** 可选的统计时间窗口（天）。 */
export const RANGE_OPTIONS = [7, 30, 90] as const;

interface UsageState {
  /** 查询结果；未加载时为 null */
  data: UsageQueryResult | null;
  /** 首次加载或切换条件中 */
  loading: boolean;
  /** 重新扫描中（比 loading 慢，单独标记以便按钮显示转圈） */
  refreshing: boolean;
  /** 错误信息；无错误时为 null */
  error: string | null;
  /** 当前统计天数 */
  rangeDays: number;
  /** 限定的工作空间 id；undefined 表示全部项目 */
  workspaceId: string | undefined;

  /** 按当前条件读取缓存统计 */
  load: () => Promise<void>;
  /** 强制重新扫描会话文件后刷新 */
  refresh: () => Promise<void>;
  /** 切换统计天数并重新查询 */
  setRange: (rangeDays: number) => Promise<void>;
  /** 切换工作空间过滤并重新查询 */
  setWorkspace: (workspaceId: string | undefined) => Promise<void>;
}

/**
 * 把未知异常转为可展示的错误文本。
 * @param error 捕获到的异常，可能是 AppError 结构或任意值。
 * @returns 错误描述文本。
 */
function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Token 用量 store */
export const useUsageStore = create<UsageState>((set, get) => ({
  data: null,
  loading: false,
  refreshing: false,
  error: null,
  rangeDays: 30,
  workspaceId: undefined,

  /** 按当前条件读取缓存统计 */
  load: async () => {
    const { rangeDays, workspaceId } = get();
    set({ loading: true, error: null });
    try {
      const data = await usageQuery(workspaceId, rangeDays);
      set({ data, loading: false });
    } catch (error) {
      set({ error: describeError(error), loading: false });
    }
  },

  /** 强制重新扫描会话文件后刷新 */
  refresh: async () => {
    const { rangeDays, workspaceId } = get();
    set({ refreshing: true, error: null });
    try {
      const data = await usageRefresh(workspaceId, rangeDays);
      set({ data, refreshing: false });
    } catch (error) {
      set({ error: describeError(error), refreshing: false });
    }
  },

  /** 切换统计天数并重新查询 */
  setRange: async (rangeDays) => {
    set({ rangeDays });
    await get().load();
  },

  /** 切换工作空间过滤并重新查询 */
  setWorkspace: async (workspaceId) => {
    set({ workspaceId });
    await get().load();
  },
}));
