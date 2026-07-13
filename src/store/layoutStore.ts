/**
 * 分屏布局 store：分屏二叉树 + 活动 leaf + 窗格内 Tab。
 * 所有树操作均为纯函数式不可变更新；新节点 id 用 crypto.randomUUID()。
 * 运行时 leaf.sessionIds/activeSessionId 易失（不持久化），持久化只存骨架 {id,locked}。
 */
import { create } from "zustand";
import type {
  PaneNode,
  LeafNode,
  SplitNode,
  PersistedNode,
  PersistedLeaf,
  PersistedSplit,
  SavedWorkspaceLayout,
} from "../api/types";
import { layoutGet, layoutSave } from "../api/commands";
import {
  clonePaneTree,
  createSavedWorkspaceSnapshot,
  swapLeafContents,
} from "./layoutOperations";

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const LAYOUT_VERSION = 1;

function makeLeaf(): LeafNode {
  return { type: "leaf", id: crypto.randomUUID(), sessionIds: [], activeSessionId: null, locked: false };
}

function toRuntime(node: PersistedNode): PaneNode {
  if (node.type === "leaf") {
    return { type: "leaf", id: node.id, sessionIds: [], activeSessionId: null, locked: node.locked };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    children: [toRuntime(node.children[0]), toRuntime(node.children[1])],
  };
}

function toPersisted(node: PaneNode): PersistedNode {
  if (node.type === "leaf") {
    const leaf: PersistedLeaf = { type: "leaf", id: node.id, locked: node.locked };
    return leaf;
  }
  const split: PersistedSplit = {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    children: [toPersisted(node.children[0]), toPersisted(node.children[1])],
  };
  return split;
}

/** 先序遍历收集所有 leaf 节点 */
export function preorderLeaves(node: PaneNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return [...preorderLeaves(node.children[0]), ...preorderLeaves(node.children[1])];
}

function replaceLeaf(
  node: PaneNode,
  leafId: string,
  replacer: (leaf: LeafNode) => PaneNode,
): PaneNode {
  if (node.type === "leaf") {
    return node.id === leafId ? replacer(node) : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], leafId, replacer),
      replaceLeaf(node.children[1], leafId, replacer),
    ],
  };
}

function removeLeaf(node: PaneNode, leafId: string): PaneNode {
  if (node.type === "leaf") return node;
  const [a, b] = node.children;
  if (a.type === "leaf" && a.id === leafId) return b;
  if (b.type === "leaf" && b.id === leafId) return a;
  return {
    ...node,
    children: [removeLeaf(a, leafId), removeLeaf(b, leafId)],
  };
}

interface LayoutState {
  tree: PaneNode;
  activePaneId: string | null;
  savedWorkspaces: SavedWorkspaceLayout[];
  load: () => Promise<void>;
  persist: () => void;
  splitPane: (leafId: string, direction: "horizontal" | "vertical") => string;
  closePane: (leafId: string) => void;
  toggleLock: (leafId: string) => void;
  setActive: (leafId: string) => void;
  setRatio: (splitId: string, ratio: number) => void;
  /** 在指定 leaf 中打开会话 Tab（追加或激活已有） */
  openSessionInLeaf: (leafId: string, sessionId: string) => void;
  /** 切换某 leaf 的激活 Tab */
  activateTab: (leafId: string, sessionId: string) => void;
  /** 关闭某 leaf 的某个 Tab（不杀 PTY） */
  closeTab: (leafId: string, sessionId: string) => void;
  /** 查找某会话所在的 leaf id（全树遍历） */
  findLeafBySession: (sessionId: string) => string | null;
  /** 求落点 leaf：优先活动且未锁；否则先序第一个未锁；全锁返回 null */
  findTargetLeaf: () => string | null;
  swapPaneContents: (sourceLeafId: string, targetLeafId: string) => void;
  saveCurrentWorkspace: (name: string) => void;
  restoreSavedWorkspace: (savedWorkspaceId: string) => void;
  removeSavedWorkspace: (savedWorkspaceId: string) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  tree: makeLeaf(),
  activePaneId: null,
  savedWorkspaces: [],

  load: async () => {
    const layout = await layoutGet();
    if (!layout.tree) {
      const leaf = makeLeaf();
      set({
        tree: leaf,
        activePaneId: leaf.id,
        savedWorkspaces: layout.savedWorkspaces ?? [],
      });
      return;
    }
    const tree = toRuntime(layout.tree);
    const leaves = preorderLeaves(tree);
    const active =
      layout.activePaneId && leaves.some((l) => l.id === layout.activePaneId)
        ? layout.activePaneId
        : (leaves[0]?.id ?? null);
    set({
      tree,
      activePaneId: active,
      savedWorkspaces: layout.savedWorkspaces ?? [],
    });
  },

  persist: () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const { tree, activePaneId, savedWorkspaces } = get();
      void layoutSave({
        version: LAYOUT_VERSION,
        tree: toPersisted(tree),
        activePaneId,
        savedWorkspaces,
      });
    }, 300);
  },

  splitPane: (leafId, direction) => {
    const newLeaf = makeLeaf();
    const tree = replaceLeaf(get().tree, leafId, (leaf) => {
      const split: SplitNode = {
        type: "split",
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        children: [leaf, newLeaf],
      };
      return split;
    });
    set({ tree, activePaneId: newLeaf.id });
    get().persist();
    return newLeaf.id;
  },

  closePane: (leafId) => {
    const { tree, activePaneId } = get();
    if (tree.type === "leaf") return;
    const nextTree = removeLeaf(tree, leafId);
    const nextActive =
      activePaneId === leafId ? (preorderLeaves(nextTree)[0]?.id ?? null) : activePaneId;
    set({ tree: nextTree, activePaneId: nextActive });
    get().persist();
  },

  toggleLock: (leafId) => {
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
      ...leaf,
      locked: !leaf.locked,
    }));
    set({ tree });
    get().persist();
  },

  setActive: (leafId) => {
    set({ activePaneId: leafId });
    get().persist();
  },

  setRatio: (splitId, ratio) => {
    const update = (node: PaneNode): PaneNode => {
      if (node.type === "leaf") return node;
      if (node.id === splitId) return { ...node, ratio };
      return { ...node, children: [update(node.children[0]), update(node.children[1])] };
    };
    set({ tree: update(get().tree) });
    get().persist();
  },

  openSessionInLeaf: (leafId, sessionId) => {
    const leaves = preorderLeaves(get().tree);
    // 该会话已在其他 leaf → 不操作（调用方应先用 findLeafBySession 判断并 setActive）
    const existing = leaves.find((l) => l.sessionIds.includes(sessionId));
    if (existing && existing.id !== leafId) return;
    // 已在本 leaf → 仅激活该 Tab
    const target = leaves.find((l) => l.id === leafId);
    if (!target) return;
    if (target.sessionIds.includes(sessionId)) {
      if (target.activeSessionId === sessionId) return;
      const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
        ...leaf,
        activeSessionId: sessionId,
      }));
      set({ tree });
      return;
    }
    // 追加新 Tab 并激活
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
      ...leaf,
      sessionIds: [...leaf.sessionIds, sessionId],
      activeSessionId: sessionId,
    }));
    set({ tree });
  },

  activateTab: (leafId, sessionId) => {
    const leaves = preorderLeaves(get().tree);
    const target = leaves.find((l) => l.id === leafId);
    if (!target || !target.sessionIds.includes(sessionId)) return;
    if (target.activeSessionId === sessionId) return;
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
      ...leaf,
      activeSessionId: sessionId,
    }));
    set({ tree });
  },

  closeTab: (leafId, sessionId) => {
    const tree = replaceLeaf(get().tree, leafId, (leaf) => {
      const idx = leaf.sessionIds.indexOf(sessionId);
      if (idx === -1) return leaf;
      const rest = leaf.sessionIds.filter((s) => s !== sessionId);
      const nextActive =
        leaf.activeSessionId !== sessionId
          ? leaf.activeSessionId
          : (rest[idx] ?? rest[idx - 1] ?? null);
      return { ...leaf, sessionIds: rest, activeSessionId: nextActive };
    });
    set({ tree });
  },

  findLeafBySession: (sessionId) => {
    const leaves = preorderLeaves(get().tree);
    return leaves.find((l) => l.sessionIds.includes(sessionId))?.id ?? null;
  },

  findTargetLeaf: () => {
    const { tree, activePaneId } = get();
    const leaves = preorderLeaves(tree);
    if (activePaneId) {
      const active = leaves.find((l) => l.id === activePaneId);
      if (active && !active.locked) return active.id;
    }
    const firstUnlocked = leaves.find((l) => !l.locked);
    return firstUnlocked ? firstUnlocked.id : null;
  },

  swapPaneContents: (sourceLeafId, targetLeafId) => {
    const tree = swapLeafContents(get().tree, sourceLeafId, targetLeafId);
    set({ tree, activePaneId: targetLeafId });
    get().persist();
  },

  saveCurrentWorkspace: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { tree, activePaneId, savedWorkspaces } = get();
    const snapshot = createSavedWorkspaceSnapshot({
      id: crypto.randomUUID(),
      name: trimmed,
      tree,
      activePaneId,
      createdAt: new Date().toISOString(),
    });
    set({ savedWorkspaces: [...savedWorkspaces, snapshot] });
    get().persist();
  },

  restoreSavedWorkspace: (savedWorkspaceId) => {
    const saved = get().savedWorkspaces.find((item) => item.id === savedWorkspaceId);
    if (!saved) return;
    set({ tree: clonePaneTree(saved.tree), activePaneId: saved.activePaneId });
    get().persist();
  },

  removeSavedWorkspace: (savedWorkspaceId) => {
    set((state) => ({
      savedWorkspaces: state.savedWorkspaces.filter(
        (item) => item.id !== savedWorkspaceId,
      ),
    }));
    get().persist();
  },
}));
