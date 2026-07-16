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

import {
  registerActiveWorkspaceRefsProvider,
  setActiveWorkspaceSyncSuspended,
  useLayoutStore,
} from "./layoutStore";

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

describe("激活工作区自动同步", () => {
  it("persist 到期时把当前布局与会话引用写回激活工作区", () => {
    const sessionRefs: Record<string, SavedSessionRef> = {
      "pty-1": {
        workspaceId: "workspace-1",
        kind: "claude",
        mode: "terminal",
      },
    };
    registerActiveWorkspaceRefsProvider(() => sessionRefs);
    try {
      const saved = useLayoutStore.getState().saveCurrentWorkspace("自动同步");
      if (!saved) throw new Error("应创建保存工作区");
      useLayoutStore.getState().openSessionInLeaf("right", "pty-1");
      vi.advanceTimersByTime(300);

      const updated = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!updated || updated.tree.type !== "split") throw new Error("快照应为分屏");
      const right = updated.tree.children[1];
      if (right.type !== "leaf") throw new Error("右侧节点必须是 leaf");
      expect(right.sessionIds).toEqual(["pty-1"]);
      expect(updated.sessionRefs).toEqual(sessionRefs);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
    }
  });

  it("无激活工作区时 Tab 操作不写回任何快照", () => {
    registerActiveWorkspaceRefsProvider(() => ({}));
    try {
      const saved = useLayoutStore.getState().saveCurrentWorkspace("非激活");
      if (!saved) throw new Error("应创建保存工作区");
      useLayoutStore.setState({ activeSavedWorkspaceId: null });
      useLayoutStore.getState().openSessionInLeaf("right", "pty-1");
      vi.advanceTimersByTime(300);

      const kept = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!kept || kept.tree.type !== "split") throw new Error("快照应为分屏");
      const right = kept.tree.children[1];
      if (right.type !== "leaf") throw new Error("右侧节点必须是 leaf");
      expect(right.sessionIds).toEqual([]);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
    }
  });

  it("应用重启后的空骨架树不覆盖激活工作区快照", async () => {
    registerActiveWorkspaceRefsProvider(() => ({}));
    try {
      const richSnapshot: SavedWorkspaceLayout = {
        id: "saved-rich",
        name: "有会话的工作区",
        tree: {
          type: "leaf",
          id: "leaf-rich",
          sessionIds: ["pty-1"],
          activeSessionId: "pty-1",
          locked: false,
        },
        activePaneId: "leaf-rich",
        createdAt: "2026-07-16T08:00:00.000Z",
        sessionRefs: {
          "pty-1": {
            managedSessionId: "managed-1",
            workspaceId: "workspace-1",
            kind: "claude",
            mode: "terminal",
          },
        },
      };
      // 模拟重启：持久化布局只有骨架（sessionIds 清空），激活工作区仍指向富快照
      commandMocks.layoutGet.mockResolvedValue({
        version: 1,
        tree: { type: "leaf", id: "leaf-rich", locked: false },
        activePaneId: "leaf-rich",
        activeSavedWorkspaceId: "saved-rich",
        savedWorkspaces: [richSnapshot],
      } satisfies PersistedLayout);
      await useLayoutStore.getState().load();

      // 重启后的第一次 persist（任何布局操作都会触发）
      useLayoutStore.getState().persist();
      vi.advanceTimersByTime(300);

      const kept = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === "saved-rich");
      if (!kept || kept.tree.type !== "leaf") throw new Error("快照应为单叶");
      expect(kept.tree.sessionIds).toEqual(["pty-1"]);
      expect(kept.sessionRefs).toEqual(richSnapshot.sessionRefs);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
    }
  });

  it("暂停写回期间 persist 不修改激活工作区快照", () => {
    registerActiveWorkspaceRefsProvider(() => ({}));
    try {
      const saved = useLayoutStore.getState().saveCurrentWorkspace("恢复中");
      if (!saved) throw new Error("应创建保存工作区");
      vi.advanceTimersByTime(300);

      setActiveWorkspaceSyncSuspended(true);
      useLayoutStore.getState().openSessionInLeaf("right", "pty-restoring");
      useLayoutStore.getState().persist();
      vi.advanceTimersByTime(300);

      const duringSuspend = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!duringSuspend || duringSuspend.tree.type !== "split") {
        throw new Error("快照应为分屏");
      }
      const right = duringSuspend.tree.children[1];
      if (right.type !== "leaf") throw new Error("右侧节点必须是 leaf");
      expect(right.sessionIds).toEqual([]);

      setActiveWorkspaceSyncSuspended(false);
      useLayoutStore.getState().persist();
      vi.advanceTimersByTime(300);

      const afterResume = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!afterResume || afterResume.tree.type !== "split") {
        throw new Error("快照应为分屏");
      }
      const rightAfter = afterResume.tree.children[1];
      if (rightAfter.type !== "leaf") throw new Error("右侧节点必须是 leaf");
      expect(rightAfter.sessionIds).toEqual(["pty-restoring"]);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
    }
  });
});
