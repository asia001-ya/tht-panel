import { describe, expect, it } from "vitest";
import type { PaneNode } from "../api/types";
import {
  clonePaneTree,
  createSavedWorkspaceSnapshot,
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
      sessionIds: ["chat:first"],
      activeSessionId: "chat:first",
      locked: false,
    },
    {
      type: "leaf",
      id: "right",
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
    expect(left.locked).toBe(false);
    expect(left.sessionIds).toEqual(["chat:second", "chat:third"]);
    expect(left.activeSessionId).toBe("chat:third");
    expect(right.id).toBe("right");
    expect(right.locked).toBe(true);
    expect(right.sessionIds).toEqual(["chat:first"]);
    expect(right.activeSessionId).toBe("chat:first");
  });

  it("保存工作区时复制布局，后续编辑不会污染快照", () => {
    const snapshot = createSavedWorkspaceSnapshot({
      id: "saved-1",
      name: "开发布局",
      tree,
      activePaneId: "left",
      createdAt: "2026-07-12T12:00:00.000Z",
    });
    const swapped = swapLeafContents(tree, "left", "right");

    expect(snapshot.name).toBe("开发布局");
    expect(snapshot.tree).toEqual(tree);
    expect(snapshot.tree).not.toBe(tree);
    expect(snapshot.tree).not.toEqual(swapped);
    expect(clonePaneTree(snapshot.tree)).toEqual(tree);
  });
});
