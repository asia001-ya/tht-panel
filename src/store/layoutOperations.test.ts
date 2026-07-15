import { describe, expect, it } from "vitest";
import type { PaneNode } from "../api/types";
import {
  clonePaneTree,
  createSavedWorkspaceSnapshot,
  renamePane,
  replaceLeafSession,
  swapLeafContents,
} from "./layoutOperations";

const tree: PaneNode = {
  type: "split",
  id: "root",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    {
      type: "leaf",
      id: "left",
      name: "web",
      sessionIds: ["chat:first"],
      activeSessionId: "chat:first",
      locked: false,
    },
    {
      type: "leaf",
      id: "right",
      name: "server",
      sessionIds: ["chat:second", "chat:third"],
      activeSessionId: "chat:third",
      locked: true,
    },
  ],
};

describe("工作区窗口操作", () => {
  it("拖动窗口时交换内容但保留布局位置与锁定状态", () => {
    const swapped = swapLeafContents(tree, "left", "right");
    if (swapped.type !== "split") throw new Error("测试树必须是 split");

    const [left, right] = swapped.children;
    if (left.type !== "leaf" || right.type !== "leaf") {
      throw new Error("测试子节点必须是 leaf");
    }

    expect(left.id).toBe("left");
    expect(left.name).toBe("web");
    expect(left.locked).toBe(false);
    expect(left.sessionIds).toEqual(["chat:second", "chat:third"]);
    expect(left.activeSessionId).toBe("chat:third");
    expect(right.id).toBe("right");
    expect(right.name).toBe("server");
    expect(right.locked).toBe(true);
    expect(right.sessionIds).toEqual(["chat:first"]);
    expect(right.activeSessionId).toBe("chat:first");
  });

  it("非空窗口与空窗口交换时仅交换会话内容", () => {
    const treeWithEmptyLeaf: PaneNode = {
      type: "split",
      id: "empty-root",
      direction: "vertical",
      ratio: 0.35,
      children: [
        {
          type: "leaf",
          id: "occupied",
          sessionIds: ["chat:active", "chat:background"],
          activeSessionId: "chat:active",
          locked: true,
        },
        {
          type: "leaf",
          id: "empty",
          sessionIds: [],
          activeSessionId: null,
          locked: false,
        },
      ],
    };

    const swapped = swapLeafContents(treeWithEmptyLeaf, "occupied", "empty");
    if (swapped.type !== "split") throw new Error("测试树必须是 split");
    const [occupied, empty] = swapped.children;
    if (occupied.type !== "leaf" || empty.type !== "leaf") {
      throw new Error("测试子节点必须是 leaf");
    }

    expect(swapped.id).toBe("empty-root");
    expect(swapped.ratio).toBe(0.35);
    expect(occupied.id).toBe("occupied");
    expect(occupied.locked).toBe(true);
    expect(occupied.sessionIds).toEqual([]);
    expect(occupied.activeSessionId).toBeNull();
    expect(empty.id).toBe("empty");
    expect(empty.locked).toBe(false);
    expect(empty.sessionIds).toEqual(["chat:active", "chat:background"]);
    expect(empty.activeSessionId).toBe("chat:active");
  });

  it("保存工作区时复制布局，后续编辑不会污染快照", () => {
    const sessionRefs = {
      "chat:first": {
        managedSessionId: "managed-1",
        workspaceId: "workspace-1",
        kind: "claude" as const,
        mode: "terminal" as const,
      },
    };
    const snapshot = createSavedWorkspaceSnapshot({
      id: "saved-1",
      name: "开发布局",
      tree,
      activePaneId: "left",
      createdAt: "2026-07-12T12:00:00.000Z",
      sessionRefs,
    });
    const swapped = swapLeafContents(tree, "left", "right");

    expect(snapshot.name).toBe("开发布局");
    expect(snapshot.tree).toEqual(tree);
    expect(snapshot.tree).not.toBe(tree);
    expect(snapshot.tree).not.toEqual(swapped);
    expect(clonePaneTree(snapshot.tree)).toEqual(tree);
    expect(snapshot.sessionRefs).not.toBe(sessionRefs);
    sessionRefs["chat:first"].managedSessionId = "managed-2";
    expect(snapshot.sessionRefs?.["chat:first"]?.managedSessionId).toBe("managed-1");
  });

  it("窗格名称忽略大小写不可重复", () => {
    const result = renamePane(tree, "right", " WEB ");

    expect(result.error).toBe("窗格名称已存在");
    expect(result.tree).toBe(tree);
  });

  it("空名称清除窗格的显式名称", () => {
    const result = renamePane(tree, "left", "   ");
    if (result.tree.type !== "split") throw new Error("测试树必须是 split");
    const left = result.tree.children[0];
    if (left.type !== "leaf") throw new Error("左侧节点必须是 leaf");

    expect(result.error).toBeUndefined();
    expect(left.name).toBeUndefined();
  });

  it("恢复会话时在原位置替换会话 ID 与活动会话", () => {
    const replaced = replaceLeafSession(
      tree,
      "left",
      "chat:first",
      "pty:restored",
    );
    if (replaced.type !== "split") throw new Error("测试树必须是 split");
    const [left, right] = replaced.children;
    if (left.type !== "leaf" || right.type !== "leaf") {
      throw new Error("测试子节点必须是 leaf");
    }

    expect(left.sessionIds).toEqual(["pty:restored"]);
    expect(left.activeSessionId).toBe("pty:restored");
    expect(left.name).toBe("web");
    expect(right).toBe(tree.children[1]);
  });
});
