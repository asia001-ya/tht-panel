/**
 * 窗格协作任务 store：后端状态机是真相来源，前端只覆盖后端返回对象。
 */
import { create } from "zustand";
import type {
  CreatePaneTaskRequest,
  PaneTask,
  TaskOutcome,
} from "../api/types";
import {
  taskCancel,
  taskClose,
  taskCreate,
  taskDispatch,
  taskForward,
  taskList,
  taskReport,
} from "../api/commands";

interface TaskState {
  tasks: PaneTask[];
  loading: boolean;
  error: string | null;
  drawerPaneId: string | null;
  load: (savedWorkspaceId?: string) => Promise<void>;
  create: (request: CreatePaneTaskRequest) => Promise<PaneTask | null>;
  dispatch: (
    taskId: string,
    targetPaneId: string,
    sessionId: string,
  ) => Promise<PaneTask | null>;
  report: (
    taskId: string,
    outcome: TaskOutcome,
    report: string,
  ) => Promise<PaneTask | null>;
  forward: (
    taskId: string,
    sourcePaneId: string,
    sessionId: string,
  ) => Promise<PaneTask | null>;
  close: (taskId: string) => Promise<PaneTask | null>;
  cancel: (taskId: string) => Promise<PaneTask | null>;
  openDrawer: (paneId: string) => void;
  closeDrawer: () => void;
}

/**
 * 用后端返回对象新增或覆盖同标识任务。
 * @param tasks 当前任务列表。
 * @param task 后端返回任务。
 * @returns 更新后的任务列表。
 */
function upsertTask(tasks: PaneTask[], task: PaneTask): PaneTask[] {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) return [...tasks, task];
  const next = [...tasks];
  next[index] = task;
  return next;
}

/**
 * 把未知后端异常转换为可见错误文本。
 * @param error 未知异常。
 * @returns 可展示错误文本。
 */
function taskErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export const useTaskStore = create<TaskState>((set) => {
  /**
   * 执行一次后端状态迁移，成功时 upsert，失败时保留原任务。
   * @param command 返回后端任务的异步操作。
   * @returns 后端任务；失败时返回 null。
   */
  async function updateFromCommand(
    command: () => Promise<PaneTask>,
  ): Promise<PaneTask | null> {
    set({ error: null });
    try {
      const task = await command();
      set((state) => ({ tasks: upsertTask(state.tasks, task) }));
      return task;
    } catch (error) {
      set({ error: taskErrorMessage(error) });
      return null;
    }
  }

  return {
    tasks: [],
    loading: false,
    error: null,
    drawerPaneId: null,

    load: async (savedWorkspaceId) => {
      set({ loading: true, error: null });
      try {
        const tasks = await taskList(savedWorkspaceId);
        set({ tasks, loading: false });
      } catch (error) {
        set({ loading: false, error: taskErrorMessage(error) });
      }
    },

    create: (request) => updateFromCommand(() => taskCreate(request)),
    dispatch: (taskId, targetPaneId, sessionId) =>
      updateFromCommand(() => taskDispatch(taskId, targetPaneId, sessionId)),
    report: (taskId, outcome, report) =>
      updateFromCommand(() => taskReport(taskId, outcome, report)),
    forward: (taskId, sourcePaneId, sessionId) =>
      updateFromCommand(() => taskForward(taskId, sourcePaneId, sessionId)),
    close: (taskId) => updateFromCommand(() => taskClose(taskId)),
    cancel: (taskId) => updateFromCommand(() => taskCancel(taskId)),
    openDrawer: (paneId) => set({ drawerPaneId: paneId, error: null }),
    closeDrawer: () => set({ drawerPaneId: null, error: null }),
  };
});

/**
 * 计算某窗格当前需要处理的任务数量。
 * @param tasks 当前布局任务。
 * @param paneId 窗格标识。
 * @returns queued/dispatched/reported/forwarded 中该窗格待处理数量。
 */
export function pendingTaskCount(tasks: PaneTask[], paneId: string): number {
  return tasks.filter((task) => (
    (task.targetPaneId === paneId
      && (task.status === "queued" || task.status === "dispatched"))
    || (task.sourcePaneId === paneId
      && (task.status === "reported" || task.status === "forwarded"))
  )).length;
}
