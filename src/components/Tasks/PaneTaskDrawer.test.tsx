// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneTask, PtySessionInfo } from "../../api/types";
import {
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
  it("创建任务时只列出当前布局中其他已命名 Pane", () => {
    render(<PaneTaskDrawer />);

    expect(screen.getByRole("option", { name: "server" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "web" })).toBeNull();
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
