import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PaneNode,
  PersistedLayout,
  SavedSessionRef,
  SavedWorkspaceLayout,
} from "../api/types";

const commandMocks = vi.hoisted(() => ({
  layoutGet: vi.fn(),
  layoutSave: vi.fn(),
}));

vi.mock("../api/commands", () => commandMocks);

import { useLayoutStore } from "./layoutStore";

const originalLoad = useLayoutStore.getState().load;
const originalPersist = useLayoutStore.getState().persist;

const namedTree: PaneNode = {
  type: "split",
  id: "root",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    {
      type: "leaf",
      id: "left",
      name: "web",
      sessionIds: ["pty-old"],
      activeSessionId: "pty-old",
      locked: false,
    },
    {
      type: "leaf",
      id: "right",
      name: "server",
      sessionIds: [],
      activeSessionId: null,
      locked: false,
    },
  ],
};

const savedWorkspaceOne: SavedWorkspaceLayout = {
  id: "saved-1",
  name: "开发布局",
  tree: namedTree,
  activePaneId: "left",
  createdAt: "2026-07-15T08:00:00.000Z",
};

const savedWorkspaceTwo: SavedWorkspaceLayout = {
  id: "saved-2",
  name: "测试布局",
  tree: namedTree,
  activePaneId: "right",
  createdAt: "2026-07-15T09:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  commandMocks.layoutGet.mockReset();
  commandMocks.layoutSave.mockReset().mockResolvedValue(undefined);
  useLayoutStore.setState({
    tree: structuredClone(namedTree),
    activePaneId: "left",
    savedWorkspaces: [],
    restoreErrors: {},
    activeSavedWorkspaceId: null,
    load: originalLoad,
    persist: originalPersist,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("布局状态", () => {
  it("窗格名称忽略大小写不可重复", () => {
    useLayoutStore.setState({ persist: vi.fn() });

    const error = useLayoutStore.getState().renamePane("right", " WEB ");

    expect(error).toBe("窗格名称已存在");
    expect(useLayoutStore.getState().tree).toEqual(namedTree);
  });

  it("空名称清除显式名称", () => {
    useLayoutStore.setState({ persist: vi.fn() });

    const error = useLayoutStore.getState().renamePane("left", "   ");
    const tree = useLayoutStore.getState().tree;
    if (tree.type !== "split") throw new Error("测试树必须是 split");
    const left = tree.children[0];
    if (left.type !== "leaf") throw new Error("左侧节点必须是 leaf");

    expect(error).toBeNull();
    expect(left.name).toBeUndefined();
  });

  it("加载旧布局并再次持久化时保留窗格名称", async () => {
    const persistedLayout: PersistedLayout = {
      version: 1,
      tree: {
        type: "leaf",
        id: "persisted-leaf",
        name: "terminal",
        locked: true,
        workspaceId: "workspace-1",
      },
      activePaneId: "persisted-leaf",
      savedWorkspaces: [],
    };
    commandMocks.layoutGet.mockResolvedValue(persistedLayout);

    await useLayoutStore.getState().load();

    const runtimeTree = useLayoutStore.getState().tree;
    if (runtimeTree.type !== "leaf") throw new Error("运行时节点必须是 leaf");
    expect(runtimeTree.name).toBe("terminal");
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBeNull();

    useLayoutStore.setState({ activeSavedWorkspaceId: "saved-active" });
    useLayoutStore.getState().persist();
    await vi.advanceTimersByTimeAsync(300);

    expect(commandMocks.layoutSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tree: expect.objectContaining({ name: "terminal" }),
        activeSavedWorkspaceId: "saved-active",
      }),
    );
  });

  it("加载时把不存在的活动工作区 ID 归一为空值", async () => {
    commandMocks.layoutGet.mockResolvedValue({
      version: 1,
      tree: {
        type: "leaf",
        id: "persisted-leaf",
        locked: false,
      },
      activePaneId: "persisted-leaf",
      activeSavedWorkspaceId: "missing-saved-workspace",
      savedWorkspaces: [savedWorkspaceOne],
    } satisfies PersistedLayout);

    await useLayoutStore.getState().load();

    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBeNull();
  });

  it("保存当前工作区时复制稳定会话引用并设为活动快照", () => {
    useLayoutStore.setState({ persist: vi.fn() });
    const sessionRefs: Record<string, SavedSessionRef> = {
      "pty-old": {
        managedSessionId: "managed-1",
        workspaceId: "workspace-1",
        kind: "claude",
        providerId: "provider-1",
        mode: "terminal",
      },
    };

    const saved = useLayoutStore
      .getState()
      .saveCurrentWorkspace(" 开发布局 ", sessionRefs);

    expect(saved).not.toBeNull();
    expect(saved?.name).toBe("开发布局");
    expect(saved?.sessionRefs).not.toBe(sessionRefs);
    expect(useLayoutStore.getState().savedWorkspaces).toEqual([saved]);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBe(saved?.id);
  });

  it("恢复保存工作区时返回快照并记录活动快照", () => {
    useLayoutStore.setState({ persist: vi.fn() });
    const saved: SavedWorkspaceLayout = {
      id: "saved-1",
      name: "开发布局",
      tree: namedTree,
      activePaneId: "right",
      createdAt: "2026-07-15T08:00:00.000Z",
    };
    useLayoutStore.setState({ savedWorkspaces: [saved] });

    const restored = useLayoutStore.getState().restoreSavedWorkspace(saved.id);

    expect(restored).toBe(saved);
    expect(useLayoutStore.getState().tree).toEqual(namedTree);
    expect(useLayoutStore.getState().tree).not.toBe(namedTree);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBe(saved.id);
  });

  it("删除活动保存工作区时清除活动工作区 ID", () => {
    useLayoutStore.setState({
      savedWorkspaces: [savedWorkspaceOne, savedWorkspaceTwo],
      activeSavedWorkspaceId: savedWorkspaceOne.id,
      persist: vi.fn(),
    });

    useLayoutStore.getState().removeSavedWorkspace(savedWorkspaceOne.id);

    expect(useLayoutStore.getState().savedWorkspaces).toEqual([savedWorkspaceTwo]);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBeNull();
  });

  it("删除非活动保存工作区时保留活动工作区 ID", () => {
    useLayoutStore.setState({
      savedWorkspaces: [savedWorkspaceOne, savedWorkspaceTwo],
      activeSavedWorkspaceId: savedWorkspaceOne.id,
      persist: vi.fn(),
    });

    useLayoutStore.getState().removeSavedWorkspace(savedWorkspaceTwo.id);

    expect(useLayoutStore.getState().savedWorkspaces).toEqual([savedWorkspaceOne]);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBe(
      savedWorkspaceOne.id,
    );
  });

  it("在原窗格替换恢复后的会话 ID", () => {
    useLayoutStore.getState().replaceSession("left", "pty-old", "pty-new");
    const tree = useLayoutStore.getState().tree;
    if (tree.type !== "split") throw new Error("测试树必须是 split");
    const left = tree.children[0];
    if (left.type !== "leaf") throw new Error("左侧节点必须是 leaf");

    expect(left.sessionIds).toEqual(["pty-new"]);
    expect(left.activeSessionId).toBe("pty-new");
  });

  it("按窗格记录并清除恢复错误", () => {
    useLayoutStore.getState().setRestoreError("left", "供应商不存在");
    expect(useLayoutStore.getState().restoreErrors).toEqual({
      left: "供应商不存在",
    });

    useLayoutStore.getState().setRestoreError("left", null);
    expect(useLayoutStore.getState().restoreErrors).toEqual({});
  });
});
