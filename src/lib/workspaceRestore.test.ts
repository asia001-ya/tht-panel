// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalConfig,
  ManagedSession,
  PaneNode,
  PtySessionInfo,
  SavedWorkspaceLayout,
  Workspace,
} from "../api/types";
import { useLayoutStore } from "../store/layoutStore";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingSessions } from "./pendingSessions";
import { collectCurrentSessionRefs, restoreWorkspaceById } from "./workspaceRestore";

const commandMocks = vi.hoisted(() => ({
  managedSessionList: vi.fn(async (_workspaceId: string): Promise<ManagedSession[]> => []),
  managedSessionUpdate: vi.fn(async (_session: ManagedSession): Promise<void> => undefined),
  ptySpawn: vi.fn(),
}));

vi.mock("../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/commands")>()),
  ...commandMocks,
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "项目一",
  path: "D:\\AI\\project-1",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-16T08:00:00.000Z",
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
  providers: [],
};

const managedAlive: ManagedSession = {
  id: "managed-1",
  workspaceId: workspace.id,
  name: "存活会话",
  kind: "claude",
  mode: "terminal",
  ptySessionId: "pty-alive",
  aiSessionId: "ai-1",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:01:00.000Z",
};

const managedDead: ManagedSession = {
  id: "managed-2",
  workspaceId: workspace.id,
  name: "已死会话",
  kind: "claude",
  mode: "terminal",
  ptySessionId: "pty-dead",
  aiSessionId: "ai-2",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:02:00.000Z",
};

/**
 * 创建运行中的 PTY 会话镜像。
 * @param sessionId PTY 会话 ID。
 * @returns 状态为 running 的会话信息。
 */
function alivePty(sessionId: string): PtySessionInfo {
  return {
    sessionId,
    workspaceId: workspace.id,
    kind: "claude",
    cwd: workspace.path,
    title: sessionId,
    state: "running",
    createdAt: "2026-07-16T08:00:00.000Z",
  };
}

/**
 * 创建包含两个终端 Tab 的单叶快照。
 * @returns 引用存活与已死会话各一个的保存工作区。
 */
function snapshotWithTwoTabs(): SavedWorkspaceLayout {
  const tree: PaneNode = {
    type: "leaf",
    id: "leaf-1",
    sessionIds: ["pty-alive", "pty-dead"],
    activeSessionId: "pty-alive",
    locked: false,
  };
  return {
    id: "saved-1",
    name: "双 Tab 工作区",
    tree,
    activePaneId: "leaf-1",
    createdAt: "2026-07-16T08:03:00.000Z",
    sessionRefs: {
      "pty-alive": {
        managedSessionId: managedAlive.id,
        workspaceId: workspace.id,
        kind: "claude",
        mode: "terminal",
      },
      "pty-dead": {
        managedSessionId: managedDead.id,
        workspaceId: workspace.id,
        kind: "claude",
        mode: "terminal",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingSessions.clear();
  useSettingsStore.setState({ config, loaded: true });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set<string>(),
    historyCache: { [workspace.id]: [managedAlive, managedDead] },
    historyLoading: {},
    loadHistory: vi.fn(async () => undefined),
  });
  useSessionStore.setState({ sessions: { "pty-alive": alivePty("pty-alive") } });
  useLayoutStore.setState({
    tree: { type: "leaf", id: "leaf-0", sessionIds: [], activeSessionId: null, locked: false },
    activePaneId: "leaf-0",
    savedWorkspaces: [snapshotWithTwoTabs()],
    restoreErrors: {},
    activeSavedWorkspaceId: null,
    persist: vi.fn(),
  });
  commandMocks.managedSessionList.mockResolvedValue([managedAlive, managedDead]);
});

describe("collectCurrentSessionRefs", () => {
  it("从当前布局与历史缓存构建稳定引用", () => {
    useLayoutStore.setState({
      tree: {
        type: "leaf",
        id: "leaf-0",
        sessionIds: ["pty-alive"],
        activeSessionId: "pty-alive",
        locked: false,
      },
    });

    const refs = collectCurrentSessionRefs();

    expect(refs["pty-alive"]).toEqual({
      managedSessionId: managedAlive.id,
      workspaceId: workspace.id,
      kind: "claude",
      mode: "terminal",
    });
  });
});

describe("restoreWorkspaceById", () => {
  it("快照不存在时不改动布局", async () => {
    const result = await restoreWorkspaceById("missing");

    expect(result).toEqual({ restored: false, errorCount: 0 });
    expect(useLayoutStore.getState().tree.id).toBe("leaf-0");
  });

  it("存活 PTY 原位保留，已死会话以 resume 重建并回绑", async () => {
    commandMocks.ptySpawn.mockResolvedValue(alivePty("pty-new"));
    const onResumeRebound = vi.fn();

    const result = await restoreWorkspaceById("saved-1", onResumeRebound);

    expect(result).toEqual({ restored: true, errorCount: 0 });
    expect(commandMocks.managedSessionList).toHaveBeenCalledWith(workspace.id);
    expect(commandMocks.ptySpawn).toHaveBeenCalledTimes(1);
    expect(commandMocks.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: workspace.id,
      kind: "claude",
      resumeSessionId: "ai-2",
    }));
    expect(commandMocks.managedSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: managedDead.id,
      ptySessionId: "pty-new",
    }));
    const tree = useLayoutStore.getState().tree;
    if (tree.type !== "leaf") throw new Error("恢复后应为单叶布局");
    expect(tree.sessionIds).toEqual(["pty-alive", "pty-new"]);
    expect(onResumeRebound).toHaveBeenCalledTimes(1);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBe("saved-1");
  });

  it("历史刷新失败时对应 Tab 记录恢复错误", async () => {
    commandMocks.managedSessionList.mockRejectedValue(new Error("离线"));
    useSessionStore.setState({ sessions: {} });
    useWorkspaceStore.setState({ historyCache: {} });

    const result = await restoreWorkspaceById("saved-1");

    expect(result.restored).toBe(true);
    expect(result.errorCount).toBe(2);
    expect(useLayoutStore.getState().restoreErrors["leaf-1"]).toBeTruthy();
    expect(commandMocks.ptySpawn).not.toHaveBeenCalled();
  });

  it("spawn 失败时记录窗格错误并继续执行其余动作", async () => {
    commandMocks.ptySpawn.mockRejectedValue(new Error("PTY 启动失败"));

    const result = await restoreWorkspaceById("saved-1");

    expect(result.errorCount).toBe(1);
    expect(useLayoutStore.getState().restoreErrors["leaf-1"]).toContain("PTY 启动失败");
  });

  it("无 managed 引用的 spawn 动作登记 pendingSessions", async () => {
    commandMocks.ptySpawn.mockResolvedValue(alivePty("pty-fresh"));
    const saved = snapshotWithTwoTabs();
    saved.sessionRefs = {
      "pty-dead": { workspaceId: workspace.id, kind: "claude", mode: "terminal" },
    };
    if (saved.tree.type !== "leaf") throw new Error("测试快照应为单叶");
    saved.tree.sessionIds = ["pty-dead"];
    saved.tree.activeSessionId = "pty-dead";
    useLayoutStore.setState({ savedWorkspaces: [saved] });
    useSessionStore.setState({ sessions: {} });
    useWorkspaceStore.setState({ historyCache: { [workspace.id]: [] } });
    commandMocks.managedSessionList.mockResolvedValue([]);

    const result = await restoreWorkspaceById("saved-1");

    expect(result.errorCount).toBe(0);
    expect(pendingSessions.get("pty-fresh")).toEqual({
      workspaceId: workspace.id,
      kind: "claude",
      providerId: undefined,
    });
    expect(commandMocks.managedSessionUpdate).not.toHaveBeenCalled();
  });
});
