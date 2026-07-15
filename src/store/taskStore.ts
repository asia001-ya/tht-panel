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

/**
 * 筛选属于当前保存工作区或未保存布局的任务。
 * @param tasks 后端任务数组。
 * @param savedWorkspaceId 当前保存工作区标识；null 表示未保存布局。
 * @returns 当前工作区范围内的任务。
 */
export function tasksForSavedWorkspace(
  tasks: PaneTask[],
  savedWorkspaceId: string | null,
): PaneTask[] {
  return tasks.filter(
    (task) => (task.savedWorkspaceId ?? null) === savedWorkspaceId,
  );
}

export const useTaskStore = create<TaskState>((set) => {
  let loadGeneration = 0;
  let errorGeneration = 0;

  /**
   * 执行一次后端状态迁移；成功时 upsert，失败时保留原任务并仅在当前范围显示错误。
   * @param command 返回后端任务的异步操作。
   * @returns 后端任务；失败时返回 null。
   */
  async function updateFromCommand(
    command: () => Promise<PaneTask>,
  ): Promise<PaneTask | null> {
    const generation = errorGeneration;
    set({ error: null });
    try {
      const task = await command();
      set((state) => ({ tasks: upsertTask(state.tasks, task) }));
      return task;
    } catch (error) {
      if (generation === errorGeneration) {
        set({ error: taskErrorMessage(error) });
      }
      return null;
    }
  }

  return {
    tasks: [],
    loading: false,
    error: null,
    drawerPaneId: null,

    /**
     * 加载指定保存工作区或未保存布局的任务。
     * @param savedWorkspaceId 保存工作区标识；省略表示未保存布局。
     * @returns 加载完成时解决的 Promise。
     */
    load: async (savedWorkspaceId) => {
      const generation = ++loadGeneration;
      errorGeneration += 1;
      set({ loading: true, error: null });
      try {
        const tasks = await taskList(savedWorkspaceId);
        if (generation !== loadGeneration) return;
        set({ tasks, loading: false });
      } catch (error) {
        if (generation !== loadGeneration) return;
        set({ loading: false, error: taskErrorMessage(error) });
      }
    },

    /**
     * 创建 queued 协作任务。
     * @param request 受控任务创建输入。
     * @returns 后端任务；失败时返回 null。
     */
    create: (request) => updateFromCommand(() => taskCreate(request)),
    /**
     * 把任务派发到目标 Pane 的冻结会话。
     * @param taskId 任务标识。
     * @param targetPaneId 目标 Pane 标识。
     * @param sessionId 冻结的目标 PTY 会话标识。
     * @returns dispatched 任务；失败时返回 null。
     */
    dispatch: (taskId, targetPaneId, sessionId) =>
      updateFromCommand(() => taskDispatch(taskId, targetPaneId, sessionId)),
    /**
     * 上报任务完成或受阻结果。
     * @param taskId 任务标识。
     * @param outcome 完成或受阻结果。
     * @param report 上报正文。
     * @returns reported 任务；失败时返回 null。
     */
    report: (taskId, outcome, report) =>
      updateFromCommand(() => taskReport(taskId, outcome, report)),
    /**
     * 把上报结果转交到来源 Pane 的冻结会话。
     * @param taskId 任务标识。
     * @param sourcePaneId 来源 Pane 标识。
     * @param sessionId 冻结的来源 PTY 会话标识。
     * @returns forwarded 任务；失败时返回 null。
     */
    forward: (taskId, sourcePaneId, sessionId) =>
      updateFromCommand(() => taskForward(taskId, sourcePaneId, sessionId)),
    /**
     * 关闭已转交任务。
     * @param taskId 任务标识。
     * @returns closed 任务；失败时返回 null。
     */
    close: (taskId) => updateFromCommand(() => taskClose(taskId)),
    /**
     * 取消尚未派发的任务。
     * @param taskId 任务标识。
     * @returns cancelled 任务；失败时返回 null。
     */
    cancel: (taskId) => updateFromCommand(() => taskCancel(taskId)),
    /**
     * 打开指定 Pane 的任务抽屉。
     * @param paneId Pane 标识。
     * @returns 无返回值。
     */
    openDrawer: (paneId) => {
      errorGeneration += 1;
      set({ drawerPaneId: paneId, error: null });
    },
    /**
     * 关闭任务抽屉并清除当前错误。
     * @returns 无返回值。
     */
    closeDrawer: () => {
      errorGeneration += 1;
      set({ drawerPaneId: null, error: null });
    },
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
