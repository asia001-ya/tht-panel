// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneTask, PtySessionInfo } from "../../api/types";
import {
  taskCancel,
  taskClose,
  taskCreate,
  taskDispatch,
  taskForward,
  taskReport,
} from "../../api/commands";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useTaskStore } from "../../store/taskStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import {
  injectionBlockReason,
  PaneTaskDrawer,
} from "./PaneTaskDrawer";

vi.mock("../../api/commands", () => ({
  taskList: vi.fn(),
  taskCreate: vi.fn(),
  taskDispatch: vi.fn(),
  taskReport: vi.fn(),
  taskForward: vi.fn(),
  taskClose: vi.fn(),
  taskCancel: vi.fn(),
}));

/**
 * 构造指定状态的协作任务。
 * @param status 任务状态。
 * @returns web 到 server 的任务。
 */
function task(status: PaneTask["status"]): PaneTask {
  return {
    id: `task-${status}`,
    savedWorkspaceId: "saved-1",
    sourcePaneId: "pane-web",
    targetPaneId: "pane-server",
    sourcePaneName: "web",
    targetPaneName: "server",
    title: "同步接口",
    request: "增加 /users 接口",
    status,
    report: status === "reported" ? "接口已完成" : undefined,
    outcome: status === "reported" ? "completed" : undefined,
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
  };
}

/**
 * 构造终端会话。
 * @param sessionId 会话标识。
 * @param kind 会话类型。
 * @param state 运行状态。
 * @returns 会话信息。
 */
function session(
  sessionId: string,
  kind: PtySessionInfo["kind"] = "codex",
  state: PtySessionInfo["state"] = "idle",
): PtySessionInfo {
  return {
    sessionId,
    workspaceId: "project-1",
    kind,
    cwd: "D:\\AI\\panel",
    title: sessionId,
    state,
    createdAt: "2026-07-15T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useLayoutStore.setState({
    tree: {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        {
          type: "leaf",
          id: "pane-web",
          name: "web",
          sessionIds: ["pty-web"],
          activeSessionId: "pty-web",
          locked: false,
        },
        {
          type: "leaf",
          id: "pane-server",
          name: "server",
          sessionIds: ["pty-server", "pty-server-2"],
          activeSessionId: "pty-server",
          locked: false,
        },
      ],
    },
    activePaneId: "pane-web",
    activeSavedWorkspaceId: "saved-1",
    persist: vi.fn(),
  });
  useSessionStore.setState({
    sessions: {
      "pty-web": session("pty-web", "claude", "running"),
      "pty-server": session("pty-server"),
      "pty-server-2": session("pty-server-2"),
    },
  });
  useWorkspaceStore.setState({ workspaces: [], historyCache: {} });
  useTaskStore.setState({
    tasks: [],
    loading: false,
    error: null,
    drawerPaneId: "pane-web",
  });
});

afterEach(() => {
  cleanup();
});

describe("PaneTaskDrawer", () => {
  it("加载当前工作区任务时不展示或操作旧任务", () => {
    useTaskStore.setState({
      tasks: [task("queued")],
      loading: true,
      drawerPaneId: "pane-server",
    });

    render(<PaneTaskDrawer />);

    expect(screen.getByText("正在加载")).toBeTruthy();
    expect(screen.queryByText("同步接口")).toBeNull();
    expect(screen.queryByRole("button", { name: "接收并注入" })).toBeNull();
    expect((screen.getByLabelText("目标窗格") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("任务标题") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "创建任务" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("不展示 Pane ID 相同但属于其他保存工作区的任务", () => {
    useTaskStore.setState({
      tasks: [{ ...task("queued"), savedWorkspaceId: "saved-old" }],
      loading: false,
      drawerPaneId: "pane-server",
    });

    render(<PaneTaskDrawer />);

    expect(screen.queryByText("同步接口")).toBeNull();
    expect(screen.queryByRole("button", { name: "接收并注入" })).toBeNull();
  });

  it("创建任务时只列出当前布局中其他已命名 Pane", () => {
    render(<PaneTaskDrawer />);

    expect(screen.getByRole("option", { name: "server" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "web" })).toBeNull();
  });

  it("使用 Native 会话所属项目名作为未显式命名 Pane 的默认名", () => {
    const tree = useLayoutStore.getState().tree;
    if (tree.type !== "split") throw new Error("测试布局必须为分屏");
    const targetLeaf = tree.children[1];
    if (targetLeaf.type !== "leaf") throw new Error("目标节点必须为叶子");
    useLayoutStore.setState({
      tree: {
        ...tree,
        children: [
          tree.children[0],
          {
            ...targetLeaf,
            name: undefined,
            sessionIds: ["native:chat-1"],
            activeSessionId: "native:chat-1",
          },
        ],
      },
    });
    useWorkspaceStore.setState({
      workspaces: [{
        id: "project-native",
        name: "Native 项目",
        path: "D:\\AI\\native-project",
        agent: "codex",
        useGlobalConfig: true,
        sortOrder: 0,
        createdAt: "2026-07-15T00:00:00Z",
      }],
      historyCache: {
        "project-native": [{
          id: "chat-1",
          workspaceId: "project-native",
          name: "原生对话",
          kind: "codex",
          mode: "native",
          createdAt: "2026-07-15T00:00:00Z",
          updatedAt: "2026-07-15T00:00:00Z",
        }],
      },
    });

    render(<PaneTaskDrawer />);

    expect(screen.getByRole("option", { name: "Native 项目" })).toBeTruthy();
  });

  it("使用冻结的 Pane 标识和名称创建任务", async () => {
    vi.mocked(taskCreate).mockResolvedValue(task("queued"));
    render(<PaneTaskDrawer />);

    await userEvent.type(screen.getByLabelText("任务标题"), "同步接口");
    await userEvent.type(screen.getByLabelText("任务内容"), "增加 /users 接口");
    await userEvent.click(screen.getByRole("button", { name: "创建任务" }));

    expect(taskCreate).toHaveBeenCalledWith({
      savedWorkspaceId: "saved-1",
      sourcePaneId: "pane-web",
      targetPaneId: "pane-server",
      sourcePaneName: "web",
      targetPaneName: "server",
      title: "同步接口",
      request: "增加 /users 接口",
    });
  });

  it("创建提交中禁用按钮并忽略重复点击", async () => {
    let resolveCreate: ((value: PaneTask) => void) | undefined;
    vi.mocked(taskCreate).mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    render(<PaneTaskDrawer />);
    await userEvent.type(screen.getByLabelText("任务标题"), "同步接口");
    await userEvent.type(screen.getByLabelText("任务内容"), "增加 /users 接口");
    const createButton = screen.getByRole("button", { name: "创建任务" });

    await userEvent.click(createButton);
    await userEvent.click(createButton);

    expect(taskCreate).toHaveBeenCalledTimes(1);
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveCreate?.(task("queued"));
    });
  });

  it("空 Pane、Native、Shell、waiting 和 dead 会话均不可注入", () => {
    const sessions = useSessionStore.getState().sessions;

    expect(injectionBlockReason(null, sessions)).not.toBeNull();
    expect(injectionBlockReason("native:chat-1", sessions)).not.toBeNull();
    expect(injectionBlockReason("shell", { shell: session("shell", "shell") })).not.toBeNull();
    expect(
      injectionBlockReason("waiting", {
        waiting: session("waiting", "claude", "waiting"),
      }),
    ).not.toBeNull();
    expect(
      injectionBlockReason("dead", { dead: session("dead", "codex", "dead") }),
    ).not.toBeNull();
    expect(injectionBlockReason("pty-server", sessions)).toBeNull();
  });

  it("接收确认冻结活动会话，Tab 变化后要求重新确认", async () => {
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);

    await userEvent.click(screen.getByRole("button", { name: "接收并注入" }));
    expect(screen.getByText("pty-server")).toBeTruthy();
    expect(screen.getByText(/任务 ID：task-queued/)).toBeTruthy();
    expect(screen.getByText(/仅在目标 AI 界面仍打开时执行/)).toBeTruthy();
    expect((
      screen.getByRole("button", { name: "确认接收并注入" }) as HTMLButtonElement
    ).disabled).toBe(false);

    act(() => {
      useLayoutStore.getState().activateTab("pane-server", "pty-server-2");
    });

    expect(screen.getByText("活动会话已变化，请重新确认")).toBeTruthy();
    expect((
      screen.getByRole("button", { name: "确认接收并注入" }) as HTMLButtonElement
    ).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "重新确认" })).toBeTruthy();
  });

  it("Tab 切回冻结会话后仍要求重新确认", async () => {
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);
    await userEvent.click(screen.getByRole("button", { name: "接收并注入" }));

    act(() => {
      useLayoutStore.getState().activateTab("pane-server", "pty-server-2");
    });
    act(() => {
      useLayoutStore.getState().activateTab("pane-server", "pty-server");
    });

    expect(screen.getByText("活动会话已变化，请重新确认")).toBeTruthy();
    expect((
      screen.getByRole("button", { name: "确认接收并注入" }) as HTMLButtonElement
    ).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "重新确认" })).toBeTruthy();
  });

  it("关闭并重新打开抽屉时不保留旧确认态", async () => {
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);
    await userEvent.click(screen.getByRole("button", { name: "接收并注入" }));
    expect(screen.getByRole("button", { name: "确认接收并注入" })).toBeTruthy();

    await userEvent.click(screen.getByTitle("关闭任务抽屉"));
    act(() => useTaskStore.getState().openDrawer("pane-server"));

    expect(screen.queryByRole("button", { name: "确认接收并注入" })).toBeNull();
  });

  it("注入提交中立即禁用确认并忽略重复点击", async () => {
    let resolveDispatch: ((value: PaneTask) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((resolve) => {
      resolveDispatch = resolve;
    }));
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);
    await userEvent.click(screen.getByRole("button", { name: "接收并注入" }));
    const confirmButton = screen.getByRole("button", { name: "确认接收并注入" });

    await userEvent.click(confirmButton);
    await userEvent.click(confirmButton);

    expect(taskDispatch).toHaveBeenCalledTimes(1);
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveDispatch?.(task("dispatched"));
    });
  });

  it("注入未完成时关闭或切换抽屉仍锁定同一任务", async () => {
    let resolveDispatch: ((value: PaneTask) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((resolve) => {
      resolveDispatch = resolve;
    }));
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);
    await userEvent.click(screen.getByRole("button", { name: "接收并注入" }));
    await userEvent.click(screen.getByRole("button", { name: "确认接收并注入" }));

    await userEvent.click(screen.getByTitle("关闭任务抽屉"));
    act(() => useTaskStore.getState().openDrawer("pane-web"));
    expect((
      screen.getByRole("button", { name: "取消任务" }) as HTMLButtonElement
    ).disabled).toBe(true);
    act(() => useTaskStore.getState().openDrawer("pane-server"));
    expect((
      screen.getByRole("button", { name: "接收并注入" }) as HTMLButtonElement
    ).disabled).toBe(true);
    expect(taskDispatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch?.({ ...task("dispatched"), id: "task-queued" });
    });
  });

  it("旧注入成功后不清除随后打开的其他任务确认", async () => {
    let resolveDispatch: ((value: PaneTask) => void) | undefined;
    vi.mocked(taskDispatch).mockImplementation(() => new Promise((resolve) => {
      resolveDispatch = resolve;
    }));
    const firstTask = task("queued");
    const secondTask = {
      ...task("queued"),
      id: "task-second",
      title: "第二个任务",
    };
    useTaskStore.setState({
      tasks: [firstTask, secondTask],
      drawerPaneId: "pane-server",
    });
    render(<PaneTaskDrawer />);
    await userEvent.click(screen.getAllByRole("button", { name: "接收并注入" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "确认接收并注入" }));

    await userEvent.click(screen.getByTitle("关闭任务抽屉"));
    act(() => useTaskStore.getState().openDrawer("pane-server"));
    const secondReceiveButton = screen
      .getAllByRole<HTMLButtonElement>("button", { name: "接收并注入" })
      .find((button) => !button.disabled);
    expect(secondReceiveButton).toBeDefined();
    await userEvent.click(secondReceiveButton as HTMLButtonElement);
    expect(screen.getByText(/任务 ID：task-second/)).toBeTruthy();

    await act(async () => {
      resolveDispatch?.({ ...task("dispatched"), id: firstTask.id });
    });

    expect(screen.getByText(/任务 ID：task-second/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认接收并注入" })).toBeTruthy();
    expect(
      useTaskStore.getState().tasks.find((item) => item.id === firstTask.id)?.status,
    ).toBe("dispatched");
  });

  it("目标 Pane 可以按完成或受阻上报", async () => {
    const reported = { ...task("reported"), id: "task-dispatched" };
    vi.mocked(taskReport).mockResolvedValue(reported);
    useTaskStore.setState({ tasks: [task("dispatched")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);

    await userEvent.type(screen.getByRole("textbox", { name: "上报内容" }), "接口已完成");
    await userEvent.click(screen.getByRole("button", { name: "完成并上报" }));
    expect(taskReport).toHaveBeenCalledWith(
      "task-dispatched",
      "completed",
      "接口已完成",
    );
  });

  it("目标 Pane 可以上报受阻结果", async () => {
    const reported = {
      ...task("reported"),
      id: "task-dispatched",
      outcome: "blocked" as const,
    };
    vi.mocked(taskReport).mockResolvedValue(reported);
    useTaskStore.setState({ tasks: [task("dispatched")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);

    await userEvent.type(screen.getByRole("textbox", { name: "上报内容" }), "接口受阻");
    await userEvent.click(screen.getByRole("button", { name: "受阻并上报" }));

    expect(taskReport).toHaveBeenCalledWith("task-dispatched", "blocked", "接口受阻");
  });

  it("上报进行中禁用输入和两种结果动作并忽略重复提交", async () => {
    const resolvers: Array<(value: PaneTask) => void> = [];
    vi.mocked(taskReport).mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    useTaskStore.setState({ tasks: [task("dispatched")], drawerPaneId: "pane-server" });
    render(<PaneTaskDrawer />);
    const reportInput = screen.getByRole("textbox", { name: "上报内容" });
    const completedButton = screen.getByRole("button", { name: "完成并上报" });
    const blockedButton = screen.getByRole("button", { name: "受阻并上报" });
    await userEvent.type(reportInput, "接口已完成");

    await userEvent.click(completedButton);

    expect((reportInput as HTMLTextAreaElement).disabled).toBe(true);
    expect((completedButton as HTMLButtonElement).disabled).toBe(true);
    expect((blockedButton as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(blockedButton);
    expect(taskReport).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers.forEach((resolve) => resolve({
        ...task("reported"),
        id: "task-dispatched",
      }));
    });
  });

  it("取消进行中禁用动作并忽略重复提交", async () => {
    const resolvers: Array<(value: PaneTask) => void> = [];
    vi.mocked(taskCancel).mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    useTaskStore.setState({ tasks: [task("queued")], drawerPaneId: "pane-web" });
    render(<PaneTaskDrawer />);
    const cancelButton = screen.getByRole("button", { name: "取消任务" });

    await userEvent.click(cancelButton);

    expect((cancelButton as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(cancelButton);
    expect(taskCancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers.forEach((resolve) => resolve({
        ...task("cancelled"),
        id: "task-queued",
      }));
    });
  });

  it("关闭进行中禁用动作并忽略重复提交", async () => {
    const resolvers: Array<(value: PaneTask) => void> = [];
    vi.mocked(taskClose).mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    useTaskStore.setState({ tasks: [task("forwarded")], drawerPaneId: "pane-web" });
    render(<PaneTaskDrawer />);
    const closeButton = screen.getByRole("button", { name: "关闭任务" });

    await userEvent.click(closeButton);

    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(closeButton);
    expect(taskClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers.forEach((resolve) => resolve({
        ...task("closed"),
        id: "task-forwarded",
      }));
    });
  });

  it("reported 任务可确认转交来源会话", async () => {
    const forwarded = { ...task("forwarded"), id: "task-reported" };
    vi.mocked(taskForward).mockResolvedValue(forwarded);
    useTaskStore.setState({ tasks: [task("reported")], drawerPaneId: "pane-web" });
    render(<PaneTaskDrawer />);

    await userEvent.click(screen.getByRole("button", { name: "转交来源" }));
    expect(screen.getByText("pty-web")).toBeTruthy();
    expect(screen.getByText(/报告：接口已完成/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "确认转交" }));
    expect(taskForward).toHaveBeenCalledWith("task-reported", "pane-web", "pty-web");
  });
});
