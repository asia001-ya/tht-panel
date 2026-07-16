/**
 * workspaceRestore.ts —— 保存工作区的会话恢复编排。
 * 职责：刷新涉及项目的历史 → 换布局树 → 用 planWorkspaceRestore 规划 →
 * 串行执行 keep/native/spawn/error 动作。规划语义在 workspaceSnapshots.ts，不在此处。
 */
import type { ManagedSession, SavedSessionRef } from "../api/types";
import { managedSessionList, managedSessionUpdate, ptySpawn } from "../api/commands";
import {
  setActiveWorkspaceSyncSuspended,
  useLayoutStore,
} from "../store/layoutStore";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingSessions } from "./pendingSessions";
import { resolveTerminalResumeSelection } from "./providers";
import {
  buildSessionRefs,
  planWorkspaceRestore,
  type RestoreAction,
} from "./workspaceSnapshots";

const RESTORE_COLS = 80;
const RESTORE_ROWS = 24;

/** 进行中的恢复编排；并发点击时后续请求直接短路，防止 PTY 风暴。 */
let restoreInFlight: Promise<RestoreWorkspaceResult> | null = null;

/** 恢复结果：快照是否存在，以及记录到窗格的错误数量。 */
export interface RestoreWorkspaceResult {
  restored: boolean;
  errorCount: number;
}

/**
 * 从当前布局、运行时会话、历史缓存和待命名注册表构建稳定会话引用。
 * @returns 以当前 Tab ID 为键的稳定引用表。
 */
export function collectCurrentSessionRefs(): Record<string, SavedSessionRef> {
  return buildSessionRefs(
    useLayoutStore.getState().tree,
    useSessionStore.getState().sessions,
    useWorkspaceStore.getState().historyCache,
    pendingSessions,
  );
}

/**
 * 把未知异常转换为简短错误文案。
 * @param error 捕获到的未知异常。
 * @returns 非空错误信息。
 */
function restoreErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error);
  return message || "未知错误";
}

/**
 * 现场刷新快照引用的全部工作空间历史。
 * @param sessionRefs 快照中的稳定会话引用表。
 * @returns 刷新失败的工作空间 ID 集合。
 */
async function refreshReferencedHistories(
  sessionRefs: Record<string, SavedSessionRef> | undefined,
): Promise<Set<string>> {
  const workspaceIds = [...new Set(
    Object.values(sessionRefs ?? {}).map((ref) => ref.workspaceId),
  )];
  const failedWorkspaceIds = new Set<string>();
  await Promise.all(workspaceIds.map(async (workspaceId) => {
    try {
      const sessions = await managedSessionList(workspaceId);
      useWorkspaceStore.setState((state) => ({
        historyCache: { ...state.historyCache, [workspaceId]: sessions },
      }));
    } catch {
      failedWorkspaceIds.add(workspaceId);
    }
  }));
  return failedWorkspaceIds;
}

/**
 * 为 spawn 动作重建终端：启动 PTY、原位替换 Tab，并回绑或登记会话。
 * @param action 待执行的 spawn 恢复动作。
 * @param onResumeRebound resume 回绑成功后的回调（用于 AI 会话探测）。
 * @returns 重建完成后解析。
 */
async function spawnRestoredTerminal(
  action: Extract<RestoreAction, { kind: "spawn" }>,
  onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void,
): Promise<void> {
  const { ref, managed, leafId, oldTabId } = action;
  const workspace = useWorkspaceStore.getState().workspaces
    .find((item) => item.id === ref.workspaceId);
  if (!workspace) throw new Error(`工作空间不存在：${ref.workspaceId}`);
  const providers = useSettingsStore.getState().config?.providers ?? [];
  const selection = managed
    ? resolveTerminalResumeSelection(managed, workspace, providers)
    : { kind: ref.kind, providerId: ref.providerId, resumeSessionId: undefined };

  const info = await ptySpawn({
    workspaceId: ref.workspaceId,
    kind: selection.kind,
    providerId: selection.providerId,
    resumeSessionId: selection.resumeSessionId,
    cols: RESTORE_COLS,
    rows: RESTORE_ROWS,
  });
  useSessionStore.getState().upsert(info);
  useLayoutStore.getState().replaceSession(leafId, oldTabId, info.sessionId);

  if (managed) {
    const now = new Date().toISOString();
    await managedSessionUpdate({
      ...managed,
      kind: selection.kind,
      aiSessionId: selection.resumeSessionId,
      ptySessionId: info.sessionId,
      updatedAt: now,
    });
    void useWorkspaceStore.getState().loadHistory(managed.workspaceId);
    if (selection.resumeSessionId) {
      onResumeRebound?.({ ...managed, ptySessionId: info.sessionId }, now);
    }
  } else {
    pendingSessions.set(info.sessionId, {
      workspaceId: ref.workspaceId,
      kind: selection.kind,
      providerId: selection.providerId,
    });
  }
}

/**
 * 恢复保存工作区：换布局树并按恢复计划重建会话。
 * 同一时刻只允许一个恢复编排；编排期间暂停激活工作区写回。
 * @param savedWorkspaceId 保存工作区 ID。
 * @param onResumeRebound resume 回绑成功后的回调（用于 AI 会话探测）。
 * @returns 恢复结果；快照不存在或已有编排进行中时 restored 为 false。
 */
export async function restoreWorkspaceById(
  savedWorkspaceId: string,
  onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void,
): Promise<RestoreWorkspaceResult> {
  if (restoreInFlight) return { restored: false, errorCount: 0 };
  const restorePromise = executeRestore(savedWorkspaceId, onResumeRebound)
    .finally(() => {
      restoreInFlight = null;
    });
  restoreInFlight = restorePromise;
  return restorePromise;
}

/**
 * 执行单次恢复编排：刷新历史、换树、按计划重建会话。
 * @param savedWorkspaceId 保存工作区 ID。
 * @param onResumeRebound resume 回绑成功后的回调（用于 AI 会话探测）。
 * @returns 恢复结果；快照不存在时 restored 为 false。
 */
async function executeRestore(
  savedWorkspaceId: string,
  onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void,
): Promise<RestoreWorkspaceResult> {
  const saved = useLayoutStore.getState().savedWorkspaces
    .find((item) => item.id === savedWorkspaceId);
  if (!saved) return { restored: false, errorCount: 0 };

  setActiveWorkspaceSyncSuspended(true);
  try {
    const failedWorkspaceIds = await refreshReferencedHistories(saved.sessionRefs);

    const snapshot = useLayoutStore.getState().restoreSavedWorkspace(savedWorkspaceId);
    if (!snapshot) return { restored: false, errorCount: 0 };

    const actions = planWorkspaceRestore({
      snapshot,
      runtimeSessions: useSessionStore.getState().sessions,
      managedSessions: Object.values(useWorkspaceStore.getState().historyCache).flat(),
      workspaces: useWorkspaceStore.getState().workspaces,
      providers: useSettingsStore.getState().config?.providers ?? [],
      failedWorkspaceIds,
    });

    let errorCount = 0;
    for (const action of actions) {
      if (action.kind === "error") {
        useLayoutStore.getState().setRestoreError(action.leafId, action.message);
        errorCount += 1;
        continue;
      }
      if (action.kind === "keep" || action.kind === "native") {
        if (action.sessionId !== action.oldTabId) {
          useLayoutStore.getState()
            .replaceSession(action.leafId, action.oldTabId, action.sessionId);
        }
        continue;
      }
      try {
        await spawnRestoredTerminal(action, onResumeRebound);
      } catch (error) {
        useLayoutStore.getState()
          .setRestoreError(action.leafId, restoreErrorMessage(error));
        errorCount += 1;
      }
    }
    return { restored: true, errorCount };
  } finally {
    setActiveWorkspaceSyncSuspended(false);
    // 编排结束后把最终状态（含重建出的会话）写回激活工作区
    useLayoutStore.getState().persist();
  }
}
