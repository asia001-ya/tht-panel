// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalConfig,
  LeafNode,
  ManagedSession,
  ProviderProfile,
  PtySessionInfo,
  SpawnRequest,
  Workspace,
} from "./api/types";
import { useLayoutStore, preorderLeaves } from "./store/layoutStore";
import { useSessionStore } from "./store/sessionStore";
import { useSettingsStore } from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import App from "./App";

const commandMocks = vi.hoisted(() => ({
  aiSessionDetect: vi.fn(async () => null),
  appQuit: vi.fn(async () => undefined),
  managedSessionCreate: vi.fn(async () => undefined),
  managedSessionUpdate: vi.fn(async () => undefined),
  ptySpawn: vi.fn(),
}));

const sidebarMocks = vi.hoisted(() => ({
  locateWorkspace: vi.fn(),
}));

vi.mock("./api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/commands")>()),
  ...commandMocks,
}));

vi.mock("./api/events", () => ({
  onQuitRequest: vi.fn(async () => vi.fn()),
  onSessionExit: vi.fn(async () => vi.fn()),
  onSessionState: vi.fn(async () => vi.fn()),
}));

vi.mock("./hooks/useHotkeys", () => ({ useHotkeys: vi.fn() }));
vi.mock("./hooks/useTheme", () => ({ useTheme: vi.fn() }));
vi.mock("./components/PaneGrid/PaneGrid", () => ({ PaneGrid: () => null }));
vi.mock("./components/dialogs/WorkspaceDialog", () => ({ default: () => null }));
vi.mock("./components/dialogs/SettingsDialog", () => ({ default: () => null }));
vi.mock("./components/dialogs/ConfirmDialog", () => ({ default: () => null }));

const providers: ProviderProfile[] = [
  {
    id: "claude-provider",
    name: "Claude 企业源",
    driver: "claude",
    baseUrl: "https://claude.example.com",
    apiKey: "test-key",
    model: "claude-test",
    extraArgs: ["--verbose"],
  },
];

const workspace: Workspace = {
  id: "workspace-1",
  name: "终端项目",
  path: "D:\\AI\\terminal-project",
  agent: "codex",
  useGlobalConfig: true,
  config: {},
  sortOrder: 0,
  createdAt: "2026-07-13T08:00:00.000Z",
  keepAlive: {
    enabled: false,
    command: "",
    intervalMin: 5,
  },
  defaultProviderId: providers[0].id,
};

const config: GlobalConfig = {
  theme: "dark",
  shellPath: "powershell.exe",
  fontSize: 14,
  scrollbackBytes: 5 * 1024 * 1024,
  scrollbackLines: 10000,
  notifyOnWaiting: true,
  claudeDefaults: {},
  codexDefaults: {},
  providers,
};

const leaf: LeafNode = {
  type: "leaf",
  id: "leaf-1",
  sessionIds: [],
  activeSessionId: null,
  locked: false,
};

const legacyNativeSession: ManagedSession = {
  id: "legacy-native-1",
  workspaceId: workspace.id,
  name: "旧原生会话",
  kind: "claude",
  mode: "native",
  messages: [
    {
      id: "message-1",
      role: "user",
      content: "继续旧会话",
      createdAt: "2026-07-13T08:01:00.000Z",
    },
  ],
  createdAt: "2026-07-13T08:00:00.000Z",
  updatedAt: "2026-07-13T08:01:00.000Z",
};

vi.mock("./components/Sidebar/Sidebar", () => ({
  /** 测试侧边栏记录定位请求，并模拟真实组件完成后的消费回调。 */
  Sidebar: ({
    locateWorkspaceId,
    onLocateWorkspaceHandled,
    onResume,
    onNewSession,
  }: {
    locateWorkspaceId: string | null;
    onLocateWorkspaceHandled?: () => void;
    onResume: (workspaceId: string, session: ManagedSession) => void;
    onNewSession: (workspaceId: string) => void;
  }) => {
    useEffect(() => {
      if (locateWorkspaceId) {
        sidebarMocks.locateWorkspace(locateWorkspaceId);
        onLocateWorkspaceHandled?.();
      }
    }, [locateWorkspaceId, onLocateWorkspaceHandled]);
    return (
      <aside>
        <output data-testid="sidebar-locate-workspace">{locateWorkspaceId}</output>
        <button type="button" onClick={() => onNewSession(workspace.id)}>
          新会话
        </button>
        <button
          type="button"
          onClick={() => onResume(workspace.id, legacyNativeSession)}
        >
          恢复旧原生会话
        </button>
      </aside>
    );
  },
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  const spawnedSession: PtySessionInfo = {
    sessionId: "pty-new-1",
    workspaceId: workspace.id,
    kind: "claude",
    cwd: workspace.path,
    title: "Claude",
    resumedFrom: undefined,
    state: "running",
    createdAt: "2026-07-13T08:02:00.000Z",
  };
  commandMocks.ptySpawn.mockImplementation(
    async (_request: SpawnRequest): Promise<PtySessionInfo> => spawnedSession,
  );
  useSettingsStore.setState({
    config,
    loaded: true,
    load: vi.fn(async () => undefined),
  });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set<string>(),
    historyCache: { [workspace.id]: [] },
    historyLoading: { [workspace.id]: false },
    load: vi.fn(async () => undefined),
    loadHistory: vi.fn(async () => undefined),
  });
  useSessionStore.setState({
    sessions: {},
    syncFromBackend: vi.fn(async () => undefined),
  });
  useLayoutStore.setState({
    tree: leaf,
    activePaneId: leaf.id,
    savedWorkspaces: [],
    load: vi.fn(async () => undefined),
    persist: vi.fn(),
  });
});

/**
 * 渲染应用根组件，供测试通过 Sidebar 回调驱动真实编排。
 * @returns 无返回值。
 */
function renderApp(): void {
  render(<App />);
}

describe("App 会话编排", () => {
  it("项目新会话按默认供应商启动 PowerShell PTY", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    await waitFor(() => expect(commandMocks.ptySpawn).toHaveBeenCalledTimes(1));
    expect(commandMocks.ptySpawn).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      kind: "claude",
      providerId: providers[0].id,
      cols: 80,
      rows: 24,
    });
    await waitFor(() => {
      expect(preorderLeaves(useLayoutStore.getState().tree)[0].sessionIds).toEqual([
        "pty-new-1",
      ]);
    });
    expect(commandMocks.managedSessionCreate).not.toHaveBeenCalled();
  });

  it("Ctrl 项目快捷键只展开并定位目标项目", async () => {
    const onLocateWorkspace = vi.fn();
    window.addEventListener("app:locate-workspace", onLocateWorkspace);
    renderApp();

    window.dispatchEvent(new CustomEvent("app:activate-workspace", { detail: 0 }));
    window.dispatchEvent(new CustomEvent("app:activate-workspace", { detail: 0 }));
    window.removeEventListener("app:locate-workspace", onLocateWorkspace);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().expandedIds.has(workspace.id)).toBe(true);
    });
    expect(commandMocks.ptySpawn).not.toHaveBeenCalled();
    expect(onLocateWorkspace).toHaveBeenCalledTimes(2);
    expect((onLocateWorkspace.mock.calls[0][0] as CustomEvent<string>).detail).toBe(
      workspace.id,
    );
  });

  it("折叠侧栏时可靠交付并一次性消费项目定位目标", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "隐藏侧边栏" }));
    expect(screen.queryByTestId("sidebar-locate-workspace")).toBeNull();

    window.dispatchEvent(new CustomEvent("app:activate-workspace", { detail: 0 }));

    await waitFor(() => expect(sidebarMocks.locateWorkspace).toHaveBeenCalledWith(workspace.id));
    await waitFor(() => expect(screen.getByTestId("sidebar-locate-workspace").textContent).toBe(""));
    expect(useWorkspaceStore.getState().expandedIds.has(workspace.id)).toBe(true);
    expect(commandMocks.ptySpawn).not.toHaveBeenCalled();

    sidebarMocks.locateWorkspace.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "隐藏侧边栏" }));
    fireEvent.click(screen.getByRole("button", { name: "显示侧边栏" }));

    await waitFor(() => expect(screen.getByTestId("sidebar-locate-workspace")).toBeTruthy());
    expect(sidebarMocks.locateWorkspace).not.toHaveBeenCalled();
  });

  it("恢复旧 native 历史时打开 native Tab 且不启动 PTY", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "恢复旧原生会话" }));

    await waitFor(() => {
      expect(preorderLeaves(useLayoutStore.getState().tree)[0].sessionIds).toEqual([
        "native:legacy-native-1",
      ]);
    });
    expect(commandMocks.ptySpawn).not.toHaveBeenCalled();
  });
});
