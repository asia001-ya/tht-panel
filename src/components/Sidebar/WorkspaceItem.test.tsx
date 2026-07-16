// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../api/types";
import { useSessionStore } from "../../store/sessionStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { WorkspaceItem } from "./WorkspaceItem";

vi.mock("./SessionHistoryList", () => ({
  SessionHistoryList: () => <div data-testid="history-list" />,
}));

const workspace: Workspace = {
  id: "project-1",
  name: "Panel",
  path: "D:\\AI\\panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-13T09:00:00.000Z",
};

const toggleExpandMock = vi.fn();

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ config: null, loaded: false });
  useSessionStore.setState({ sessions: {} });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set(),
    historyCache: {},
    historyLoading: {},
    toggleExpand: toggleExpandMock,
  });
});

describe("WorkspaceItem", () => {
  it("配置尚未加载时仍能稳定渲染项目", () => {
    render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("点击项目名称时只切换展开状态", () => {
    const onNewSession = vi.fn();
    render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={onNewSession}
      />,
    );

    fireEvent.click(screen.getByText("Panel"));

    expect(toggleExpandMock).toHaveBeenCalledOnce();
    expect(toggleExpandMock).toHaveBeenCalledWith(workspace.id);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("点击加号时只新建一次会话", () => {
    const onNewSession = vi.fn();
    render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={onNewSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onNewSession).toHaveBeenCalledWith(workspace.id);
    expect(toggleExpandMock).not.toHaveBeenCalled();
  });

  it("折叠显示文件夹图标，展开切换为打开的文件夹", () => {
    const { container } = render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(container.querySelector(".lucide-folder")).toBeTruthy();
    expect(container.querySelector(".lucide-folder-open")).toBeNull();

    act(() => {
      useWorkspaceStore.setState({ expandedIds: new Set([workspace.id]) });
    });

    expect(container.querySelector(".lucide-folder-open")).toBeTruthy();
  });

  it("会话历史容器常驻并以风琴类名控制展开", () => {
    const { container } = render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("history-list")).toBeNull();

    act(() => {
      useWorkspaceStore.setState({ expandedIds: new Set([workspace.id]) });
    });
    expect(screen.getByTestId("history-list")).toBeTruthy();
    expect(container.querySelector(".ws-item-history-open")).toBeTruthy();

    act(() => {
      useWorkspaceStore.setState({ expandedIds: new Set() });
    });
    expect(screen.getByTestId("history-list")).toBeTruthy();
    expect(container.querySelector(".ws-item-history-open")).toBeNull();
  });
});
