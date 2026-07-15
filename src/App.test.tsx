// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import App, { pendingSessions } from "./App";

const commandMocks = vi.hoisted(() => ({
  aiSessionDetect: vi.fn(async () => null),
  appQuit: vi.fn(async () => undefined),
  managedSessionCreate: vi.fn(async () => undefined),
  managedSessionUpdate: vi.fn(
    async (_session: ManagedSession): Promise<void> => undefined,
  ),
  ptyKill: vi.fn(async (_sessionId: string): Promise<void> => undefined),
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
vi.mock("./components/PaneGrid/PaneGrid", () => ({
  /**
   * 暴露 App 注入的关闭回调，避免在编排测试中渲染真实终端组件。
   * @param props App 注入的关闭 Tab 与关闭窗格回调。
   * @returns 可触发三类关闭操作的测试按钮集合。
   */
  PaneGrid: ({
    onCloseTab,
    onClosePane,
  }: {
    onCloseTab?: (leafId: string, sessionId: string) => Promise<void>;
    onClosePane?: (leaf: LeafNode) => Promise<void>;
  }) => (
    <section>
      <button
        type="button"
        onClick={() => void onCloseTab?.("leaf-1", "pty-1")}
      >
        关闭终端 Tab
      </button>
      <button
        type="button"
        onClick={() => void onCloseTab?.("leaf-1", "native:legacy-native-1")}
      >
        关闭原生 Tab
      </button>
      <button
        type="button"
        onClick={() => void onClosePane?.({
          type: "leaf",
          id: "leaf-1",
          sessionIds: ["pty-1", "native:legacy-native-1", "pty-2"],
          activeSessionId: "pty-1",
          locked: false,
        })}
      >
        关闭窗格
      </button>
    </section>
  ),
}));
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

const managedTerminalOne: ManagedSession = {
  id: "managed-terminal-1",
  workspaceId: workspace.id,
  name: "终端会话一",
  kind: "claude",
  mode: "terminal",
  ptySessionId: "pty-1",
  aiSessionId: "ai-session-1",
  createdAt: "2026-07-13T08:00:00.000Z",
  updatedAt: "2026-07-13T08:01:00.000Z",
};

const managedTerminalTwo: ManagedSession = {
  id: "managed-terminal-2",
  workspaceId: workspace.id,
  name: "终端会话二",
  kind: "codex",
  mode: "terminal",
  ptySessionId: "pty-2",
  aiSessionId: "ai-session-2",
  createdAt: "2026-07-13T08:02:00.000Z",
  updatedAt: "2026-07-13T08:03:00.000Z",
};

/**
 * 创建包含两个终端 Tab 和一个原生 Tab 的双窗格测试布局。
 * @returns 左侧承载待关闭会话、右侧为空的分屏树。
 */
function createSessionTree(): ReturnType<typeof useLayoutStore.getState>["tree"] {
  return {
    type: "split",
    id: "split-root",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      {
        type: "leaf",
        id: "leaf-1",
        sessionIds: ["pty-1", "native:legacy-native-1", "pty-2"],
        activeSessionId: "pty-1",
        locked: false,
      },
      {
        type: "leaf",
        id: "leaf-2",
        sessionIds: [],
        activeSessionId: null,
        locked: false,
      },
    ],
  };
}

/**
 * 创建指定 ID 的运行中终端会话。
 * @param sessionId PTY 会话 ID。
 * @param kind 终端代理类型。
 * @returns 可写入 sessionStore 的完整终端会话。
 */
function createPtySession(
  sessionId: string,
  kind: PtySessionInfo["kind"],
): PtySessionInfo {
  return {
    sessionId,
    workspaceId: workspace.id,
    kind,
    cwd: workspace.path,
    title: sessionId,
    state: "running",
    createdAt: "2026-07-13T08:04:00.000Z",
  };
}

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
        <button
          type="button"
          onClick={() => useLayoutStore.getState().restoreSavedWorkspace("saved-layout")}
        >
          恢复保存工作区
        </button>
      </aside>
    );
  },
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  pendingSessions.clear();
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
  commandMocks.ptyKill.mockResolvedValue(undefined);
  commandMocks.managedSessionUpdate.mockResolvedValue(undefined);
  useSettingsStore.setState({
    config,
    loaded: true,
    load: vi.fn(async () => undefined),
  });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set<string>(),
    historyCache: {
      [workspace.id]: [
        managedTerminalOne,
        legacyNativeSession,
        managedTerminalTwo,
      ],
    },
    historyLoading: { [workspace.id]: false },
    load: vi.fn(async () => undefined),
    loadHistory: vi.fn(async () => undefined),
  });
  useSessionStore.setState({
    sessions: {
      "pty-1": createPtySession("pty-1", "claude"),
      "pty-2": createPtySession("pty-2", "codex"),
    },
    syncFromBackend: vi.fn(async () => undefined),
  });
  useLayoutStore.setState({
    tree: createSessionTree(),
    activePaneId: "leaf-1",
    savedWorkspaces: [
      {
        id: "saved-layout",
        name: "已保存布局",
        tree: leaf,
        activePaneId: leaf.id,
        createdAt: "2026-07-13T08:05:00.000Z",
      },
    ],
    load: vi.fn(async () => undefined),
    persist: vi.fn(),
  });
  pendingSessions.set("pty-1", {
    workspaceId: workspace.id,
    kind: "claude",
    providerId: providers[0].id,
  });
  pendingSessions.set("pty-2", {
    workspaceId: workspace.id,
    kind: "codex",
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
    useLayoutStore.setState({ tree: leaf, activePaneId: leaf.id });
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
    useLayoutStore.setState({ tree: leaf, activePaneId: leaf.id });
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

describe("App 关闭会话生命周期", () => {
  it("关闭终端 Tab 后清理运行态、挂起态和历史绑定再关闭布局 Tab", async () => {
    const loadHistory = vi.mocked(useWorkspaceStore.getState().loadHistory);
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭终端 Tab" }));

    await waitFor(() => expect(commandMocks.ptyKill).toHaveBeenCalledWith("pty-1"));
    await waitFor(() => {
      const targetLeaf = preorderLeaves(useLayoutStore.getState().tree).find(
        (item) => item.id === "leaf-1",
      );
      expect(targetLeaf?.sessionIds).not.toContain("pty-1");
    });
    expect(useSessionStore.getState().sessions["pty-1"]).toBeUndefined();
    expect(pendingSessions.has("pty-1")).toBe(false);
    expect(commandMocks.managedSessionUpdate).toHaveBeenCalledWith({
      ...managedTerminalOne,
      ptySessionId: undefined,
      updatedAt: expect.any(String),
    });
    const updatedEntry = commandMocks.managedSessionUpdate.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(updatedEntry, "ptySessionId")).toBe(true);
    expect(loadHistory).toHaveBeenCalledWith(workspace.id);
  });

  it("关闭原生 Tab 只移除视图且不终止任何 PTY", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭原生 Tab" }));

    await waitFor(() => {
      const targetLeaf = preorderLeaves(useLayoutStore.getState().tree).find(
        (item) => item.id === "leaf-1",
      );
      expect(targetLeaf?.sessionIds).not.toContain("native:legacy-native-1");
    });
    expect(commandMocks.ptyKill).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions["pty-1"]).toBeDefined();
    expect(commandMocks.managedSessionUpdate).not.toHaveBeenCalled();
  });

  it("关闭窗格时按 Tab 顺序逐个释放终端并在全部成功后关闭布局窗格", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    commandMocks.ptyKill.mockImplementation((sessionId: string) =>
      new Promise<void>((resolve) => {
        if (sessionId === "pty-1") resolveFirst = resolve;
        if (sessionId === "pty-2") resolveSecond = resolve;
      }),
    );
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭窗格" }));

    await waitFor(() => expect(commandMocks.ptyKill).toHaveBeenCalledTimes(1));
    expect(commandMocks.ptyKill).toHaveBeenNthCalledWith(1, "pty-1");
    expect(useLayoutStore.getState().tree.type).toBe("split");
    await act(async () => resolveFirst?.());
    await waitFor(() => expect(commandMocks.ptyKill).toHaveBeenCalledTimes(2));
    expect(commandMocks.ptyKill).toHaveBeenNthCalledWith(2, "pty-2");
    expect(useLayoutStore.getState().tree.type).toBe("split");
    expect(useSessionStore.getState().sessions["pty-1"]).toBeUndefined();
    expect(useSessionStore.getState().sessions["pty-2"]).toBeDefined();

    await act(async () => resolveSecond?.());

    await waitFor(() => expect(useLayoutStore.getState().tree.type).toBe("leaf"));
    expect(useLayoutStore.getState().tree.id).toBe("leaf-2");
    expect(useSessionStore.getState().sessions["pty-2"]).toBeUndefined();
    expect(pendingSessions.has("pty-1")).toBe(false);
    expect(pendingSessions.has("pty-2")).toBe(false);
  });

  it("唯一根窗格释放成功后清空全部 Tab", async () => {
    const rootLeaf = createSessionTree();
    if (rootLeaf.type !== "split") throw new Error("测试布局必须为分屏");
    useLayoutStore.setState({
      tree: rootLeaf.children[0],
      activePaneId: "leaf-1",
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭窗格" }));

    await waitFor(() => {
      const tree = useLayoutStore.getState().tree;
      expect(tree.type).toBe("leaf");
      if (tree.type !== "leaf") return;
      expect(tree.sessionIds).toEqual([]);
      expect(tree.activeSessionId).toBeNull();
    });
    expect(commandMocks.ptyKill.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "pty-1",
      "pty-2",
    ]);
  });

  it("历史同步失败时继续释放后续终端并在全部终止后关闭根窗格", async () => {
    const rootLeaf = createSessionTree();
    if (rootLeaf.type !== "split") throw new Error("测试布局必须为分屏");
    useLayoutStore.setState({
      tree: rootLeaf.children[0],
      activePaneId: "leaf-1",
    });
    commandMocks.managedSessionUpdate.mockRejectedValueOnce(new Error("历史服务离线"));
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭窗格" }));

    await waitFor(() => expect(commandMocks.ptyKill).toHaveBeenCalledTimes(2));
    expect(commandMocks.ptyKill.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "pty-1",
      "pty-2",
    ]);
    await waitFor(() => {
      const tree = useLayoutStore.getState().tree;
      expect(tree.type).toBe("leaf");
      if (tree.type !== "leaf") return;
      expect(tree.sessionIds).toEqual([]);
      expect(tree.activeSessionId).toBeNull();
    });
    expect(screen.getByText("终端已关闭，但历史同步失败：历史服务离线")).toBeTruthy();
  });

  it("恢复保存工作区时不终止当前 PTY", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "恢复保存工作区" }));

    expect(useLayoutStore.getState().tree.id).toBe(leaf.id);
    expect(commandMocks.ptyKill).not.toHaveBeenCalled();
  });

  it("PTY 终止失败时保留窗格和会话并显示明确错误", async () => {
    commandMocks.ptyKill.mockRejectedValueOnce(new Error("PTY 后端离线"));
    const originalTree = useLayoutStore.getState().tree;
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "关闭窗格" }));

    await waitFor(() => {
      expect(screen.getByText(/终端.*关闭失败|关闭终端失败/)).toBeTruthy();
    });
    expect(useLayoutStore.getState().tree).toBe(originalTree);
    expect(useSessionStore.getState().sessions["pty-1"]).toBeDefined();
    expect(pendingSessions.has("pty-1")).toBe(true);
    expect(commandMocks.managedSessionUpdate).not.toHaveBeenCalled();
  });
});
