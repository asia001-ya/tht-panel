// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../api/types";
import { useSessionStore } from "../../store/sessionStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { WorkspaceItem } from "./WorkspaceItem";

const workspace: Workspace = {
  id: "project-1",
  name: "Panel",
  path: "D:\\AI\\panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-13T09:00:00.000Z",
};

afterEach(cleanup);

beforeEach(() => {
  useSettingsStore.setState({ config: null, loaded: false });
  useSessionStore.setState({ sessions: {} });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set(),
    historyCache: {},
    historyLoading: {},
  });
});

describe("WorkspaceItem", () => {
  it("配置尚未加载时仍能稳定渲染项目", () => {
    render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onActivate={vi.fn()}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Panel")).toBeTruthy();
  });
});
