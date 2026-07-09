/**
 * 会话 store：后端 PTY 会话表在前端的镜像（Rust 为真相来源）。
 * 仅存会话元信息用于徽标聚合与工作空间分组；终端输出永不进此 store。
 * 导出若干选择器函数，读取当前 store 快照做聚合计算。
 */
import { create } from "zustand";
import type { PtySessionInfo, SessionState } from "../api/types";
import { ptyList } from "../api/commands";

/** sessionStore 状态与动作定义 */
interface SessionStoreState {
  sessions: Record<string, PtySessionInfo>; // sessionId → 会话信息
  /** 从后端 ptyList 覆盖式同步整张会话表 */
  syncFromBackend: () => Promise<void>;
  /** 新增或更新一条会话信息 */
  upsert: (info: PtySessionInfo) => void;
  /** 仅更新某会话的运行状态（徽标用） */
  setState: (sessionId: string, state: SessionState) => void;
  /** 从表中移除某会话 */
  remove: (sessionId: string) => void;
}

/** PTY 会话 store */
export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: {},

  /** 从后端 ptyList 覆盖式同步整张会话表 */
  syncFromBackend: async () => {
    const list = await ptyList();
    const sessions: Record<string, PtySessionInfo> = {};
    for (const info of list) sessions[info.sessionId] = info;
    set({ sessions });
  },

  /** 新增或更新一条会话信息 */
  upsert: (info) => {
    set((s) => ({ sessions: { ...s.sessions, [info.sessionId]: info } }));
  },

  /** 仅更新某会话的运行状态；会话不存在时忽略 */
  setState: (sessionId, state) => {
    const cur = get().sessions[sessionId];
    if (!cur) return;
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: { ...cur, state } },
    }));
  },

  /** 从表中移除某会话 */
  remove: (sessionId) => {
    set((s) => {
      const next = { ...s.sessions };
      delete next[sessionId];
      return { sessions: next };
    });
  },
}));

/**
 * 取某工作空间下的全部会话（含 dead）。
 * @param wsId 工作空间 id
 * @returns 该工作空间的会话数组
 */
export function sessionsForWorkspace(wsId: string): PtySessionInfo[] {
  return Object.values(useSessionStore.getState().sessions).filter(
    (s) => s.workspaceId === wsId,
  );
}

/**
 * 聚合某工作空间的徽标状态：任一 waiting→waiting，否则任一 running→running，
 * 否则任一 idle→idle，否则 null；dead 不计入。
 * @param wsId 工作空间 id
 * @returns 聚合后的状态或 null
 */
export function badgeFor(wsId: string): SessionState | null {
  const list = sessionsForWorkspace(wsId).filter((s) => s.state !== "dead");
  if (list.some((s) => s.state === "waiting")) return "waiting";
  if (list.some((s) => s.state === "running")) return "running";
  if (list.some((s) => s.state === "idle")) return "idle";
  return null;
}

/**
 * 取某工作空间 createdAt 最新的非 dead 会话（用于点击工作空间时聚焦最近会话）。
 * @param wsId 工作空间 id
 * @returns 最近的活跃会话或 null
 */
export function latestForWorkspace(wsId: string): PtySessionInfo | null {
  const list = sessionsForWorkspace(wsId).filter((s) => s.state !== "dead");
  if (list.length === 0) return null;
  return list.reduce((latest, cur) =>
    Date.parse(cur.createdAt) > Date.parse(latest.createdAt) ? cur : latest,
  );
}

/**
 * 查找由某 AI 历史会话恢复而来的活跃会话（去重聚焦用）。
 * @param aiSessionId 历史 AI 会话 uuid
 * @returns resumedFrom 匹配的非 dead 会话或 null
 */
export function findResumed(aiSessionId: string): PtySessionInfo | null {
  return (
    Object.values(useSessionStore.getState().sessions).find(
      (s) => s.resumedFrom === aiSessionId && s.state !== "dead",
    ) ?? null
  );
}
