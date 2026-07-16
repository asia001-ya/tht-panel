// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutStore } from "../../store/layoutStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { Sidebar } from "./Sidebar";

const restoreMocks = vi.hoisted(() => ({
  collectCurrentSessionRefs: vi.fn(() => ({
    "pty-1": {
      workspaceId: "workspace-1",
      kind: "claude" as const,
      mode: "terminal" as const,
    },
  })),
}));

vi.mock("../../lib/workspaceRestore", () => restoreMocks);
vi.mock("./WorkspaceItem", () => ({
  WorkspaceItem: () => <div data-testid="workspace-item" />,
}));
vi.mock("./RecentSessionList", () => ({
  RecentSessionList: () => <div data-testid="recent-list" />,
}));
vi.mock("./SidebarFooter", () => ({
  SidebarFooter: () => <footer />,
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({
    workspaces: [],
    expandedIds: new Set<string>(),
    historyCache: {},
    historyLoading: {},
    load: vi.fn(async () => undefined),
    loadAllHistories: vi.fn(async () => undefined),
  });
  useLayoutStore.setState({
    tree: { type: "leaf", id: "leaf-1", sessionIds: [], activeSessionId: null, locked: false },
    activePaneId: "leaf-1",
    savedWorkspaces: [{
      id: "saved-1",
      name: "已有工作区",
      tree: { type: "leaf", id: "leaf-s", sessionIds: [], activeSessionId: null, locked: false },
      activePaneId: "leaf-s",
      createdAt: "2026-07-16T08:00:00.000Z",
    }],
    activeSavedWorkspaceId: null,
    persist: vi.fn(),
  });
});

/**
 * 渲染带默认回调的侧边栏。
 * @param onRestoreWorkspace 工作区恢复回调。
 * @returns 传入的恢复回调，便于断言。
 */
function renderSidebar(
  onRestoreWorkspace = vi.fn(),
): { onRestoreWorkspace: ReturnType<typeof vi.fn> } {
  render(
    <Sidebar
      locateWorkspaceId={null}
      onLocateWorkspaceHandled={vi.fn()}
      onResume={vi.fn()}
      onNewShell={vi.fn()}
      onNewSession={vi.fn()}
      onQuickShell={vi.fn()}
      onRestoreWorkspace={onRestoreWorkspace}
    />,
  );
  return { onRestoreWorkspace };
}

describe("Sidebar 工作区", () => {
  it("顶部导航不再提供保存当前工作区", () => {
    renderSidebar();
    expect(screen.queryByText("保存当前工作区")).toBeNull();
  });

  it("加号新建工作区即以当前引用创建并激活", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "新建工作区" }));
    fireEvent.change(screen.getByPlaceholderText("工作区名称"), {
      target: { value: "新布局" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("工作区名称"), { key: "Enter" });

    const { savedWorkspaces, activeSavedWorkspaceId } = useLayoutStore.getState();
    const created = savedWorkspaces.find((item) => item.name === "新布局");
    expect(created).toBeTruthy();
    expect(created?.sessionRefs).toEqual(restoreMocks.collectCurrentSessionRefs());
    expect(activeSavedWorkspaceId).toBe(created?.id);
  });

  it("点击工作区行触发恢复回调而非直接换树", () => {
    const { onRestoreWorkspace } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "已有工作区" }));

    expect(onRestoreWorkspace).toHaveBeenCalledWith("saved-1");
    expect(useLayoutStore.getState().tree.id).toBe("leaf-1");
  });

  it("激活中的工作区行带激活样式", () => {
    useLayoutStore.setState({ activeSavedWorkspaceId: "saved-1" });
    renderSidebar();
    expect(
      screen.getByRole("button", { name: "已有工作区" }).className,
    ).toContain("saved-workspace-open-active");
  });
});
