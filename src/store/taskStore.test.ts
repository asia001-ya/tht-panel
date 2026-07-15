import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneTask } from "../api/types";
import {
  taskCancel,
  taskClose,
  taskCreate,
  taskDispatch,
  taskForward,
  taskList,
  taskReport,
} from "../api/commands";
import { useTaskStore } from "./taskStore";

vi.mock("../api/commands", () => ({
  taskList: vi.fn(),
  taskCreate: vi.fn(),
  taskDispatch: vi.fn(),
  taskReport: vi.fn(),
  taskForward: vi.fn(),
  taskClose: vi.fn(),
  taskCancel: vi.fn(),
}));

/**
 * 构造指定状态的任务。
 * @param id 任务标识。
 * @param status 任务状态。
 * @returns 完整任务对象。
 */
function task(id: string, status: PaneTask["status"]): PaneTask {
  return {
    id,
    savedWorkspaceId: "saved-1",
    sourcePaneId: "pane-web",
    targetPaneId: "pane-server",
    sourcePaneName: "web",
    targetPaneName: "server",
    title: "同步接口",
    request: "增加 /users 接口",
    status,
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTaskStore.setState({
    tasks: [],
    loading: false,
    error: null,
    drawerPaneId: null,
  });
});

describe("taskStore", () => {
  it("加载后覆盖任务并维护抽屉 Pane", async () => {
    vi.mocked(taskList).mockResolvedValue([task("task-1", "queued")]);

    useTaskStore.getState().openDrawer("pane-web");
    await useTaskStore.getState().load("saved-1");

    expect(taskList).toHaveBeenCalledWith("saved-1");
    expect(useTaskStore.getState().tasks).toEqual([task("task-1", "queued")]);
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().drawerPaneId).toBe("pane-web");
    useTaskStore.getState().closeDrawer();
    expect(useTaskStore.getState().drawerPaneId).toBeNull();
  });

  it("忽略晚于当前工作区请求完成的旧加载响应", async () => {
    let resolveOld: ((tasks: PaneTask[]) => void) | undefined;
    let resolveCurrent: ((tasks: PaneTask[]) => void) | undefined;
    vi.mocked(taskList)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOld = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCurrent = resolve;
      }));

    const oldLoad = useTaskStore.getState().load("saved-old");
    const currentLoad = useTaskStore.getState().load("saved-current");
    resolveCurrent?.([task("task-current", "queued")]);
    await currentLoad;
    resolveOld?.([task("task-old", "queued")]);
    await oldLoad;

    expect(useTaskStore.getState().tasks).toEqual([
      task("task-current", "queued"),
    ]);
    expect(useTaskStore.getState().loading).toBe(false);
  });

  it("当前工作区加载失败时保留原任务数组并记录错误", async () => {
    const existing = task("task-old", "queued");
    useTaskStore.setState({ tasks: [existing] });
    vi.mocked(taskList).mockRejectedValue(new Error("加载失败"));

    await useTaskStore.getState().load("saved-current");

    expect(useTaskStore.getState().tasks).toEqual([existing]);
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().error).toBe("加载失败");
  });

  it("七个动作均使用后端返回对象覆盖对应任务", async () => {
    const queued = task("task-1", "queued");
    const dispatched = task("task-1", "dispatched");
    const reported = { ...task("task-1", "reported"), report: "完成", outcome: "completed" as const };
    const forwarded = task("task-1", "forwarded");
    const closed = task("task-1", "closed");
    const cancelled = task("task-2", "cancelled");
    vi.mocked(taskCreate).mockResolvedValue(queued);
    vi.mocked(taskDispatch).mockResolvedValue(dispatched);
    vi.mocked(taskReport).mockResolvedValue(reported);
    vi.mocked(taskForward).mockResolvedValue(forwarded);
    vi.mocked(taskClose).mockResolvedValue(closed);
    vi.mocked(taskCancel).mockResolvedValue(cancelled);

    await useTaskStore.getState().create({
      savedWorkspaceId: "saved-1",
      sourcePaneId: "pane-web",
      targetPaneId: "pane-server",
      sourcePaneName: "web",
      targetPaneName: "server",
      title: "同步接口",
      request: "增加 /users 接口",
    });
    await useTaskStore.getState().dispatch("task-1", "pane-server", "pty-server");
    await useTaskStore.getState().report("task-1", "completed", "完成");
    await useTaskStore.getState().forward("task-1", "pane-web", "pty-web");
    await useTaskStore.getState().close("task-1");
    useTaskStore.setState((state) => ({ tasks: [...state.tasks, task("task-2", "queued")] }));
    await useTaskStore.getState().cancel("task-2");

    expect(taskDispatch).toHaveBeenCalledWith("task-1", "pane-server", "pty-server");
    expect(taskReport).toHaveBeenCalledWith("task-1", "completed", "完成");
    expect(taskForward).toHaveBeenCalledWith("task-1", "pane-web", "pty-web");
    expect(useTaskStore.getState().tasks).toEqual([closed, cancelled]);
  });

  it("后端失败时保留旧任务并记录可见错误", async () => {
    const existing = task("task-1", "queued");
    useTaskStore.setState({ tasks: [existing] });
    vi.mocked(taskDispatch).mockRejectedValue(new Error("会话不可用"));

    const result = await useTaskStore
      .getState()
      .dispatch("task-1", "pane-server", "pty-server");

    expect(result).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([existing]);
    expect(useTaskStore.getState().error).toBe("会话不可用");
  });

  it("关闭并打开其他抽屉后忽略旧动作晚到的错误", async () => {
    let rejectDispatch: ((reason?: unknown) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((_, reject) => {
      rejectDispatch = reject;
    }));
    const existing = task("task-1", "queued");
    useTaskStore.setState({ tasks: [existing] });
    useTaskStore.getState().openDrawer("pane-server");
    const pendingDispatch = useTaskStore
      .getState()
      .dispatch("task-1", "pane-server", "pty-server");

    useTaskStore.getState().closeDrawer();
    useTaskStore.getState().openDrawer("pane-web");
    rejectDispatch?.(new Error("旧抽屉失败"));
    await pendingDispatch;

    expect(useTaskStore.getState().drawerPaneId).toBe("pane-web");
    expect(useTaskStore.getState().tasks).toEqual([existing]);
    expect(useTaskStore.getState().error).toBeNull();
  });

  it("加载新工作区后忽略旧动作晚到的错误", async () => {
    let rejectDispatch: ((reason?: unknown) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((_, reject) => {
      rejectDispatch = reject;
    }));
    const currentTask = {
      ...task("task-current", "queued"),
      savedWorkspaceId: "saved-current",
    };
    vi.mocked(taskList).mockResolvedValue([currentTask]);
    useTaskStore.setState({ tasks: [task("task-old", "queued")] });
    const pendingDispatch = useTaskStore
      .getState()
      .dispatch("task-old", "pane-server", "pty-server");

    await useTaskStore.getState().load("saved-current");
    rejectDispatch?.(new Error("旧工作区失败"));
    await pendingDispatch;

    expect(useTaskStore.getState().tasks).toEqual([currentTask]);
    expect(useTaskStore.getState().error).toBeNull();
  });

  it("抽屉变化后旧动作成功仍使用后端任务 upsert", async () => {
    let resolveDispatch: ((value: PaneTask) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((resolve) => {
      resolveDispatch = resolve;
    }));
    const existing = task("task-1", "queued");
    const dispatched = task("task-1", "dispatched");
    useTaskStore.setState({ tasks: [existing] });
    useTaskStore.getState().openDrawer("pane-server");
    const pendingDispatch = useTaskStore
      .getState()
      .dispatch("task-1", "pane-server", "pty-server");

    useTaskStore.getState().closeDrawer();
    useTaskStore.getState().openDrawer("pane-web");
    resolveDispatch?.(dispatched);
    await pendingDispatch;

    expect(useTaskStore.getState().tasks).toEqual([dispatched]);
    expect(useTaskStore.getState().error).toBeNull();
  });
});
