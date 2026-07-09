/**
 * 分屏布局 store：分屏二叉树 + 活动 leaf。
 * 所有树操作均为纯函数式不可变更新；新节点 id 用 crypto.randomUUID()。
 * 运行时 leaf.sessionId 易失（不持久化），持久化只存骨架 {id,locked}。
 */
import { create } from "zustand";
import type {
  PaneNode,
  LeafNode,
  SplitNode,
  PersistedNode,
  PersistedLeaf,
  PersistedSplit,
} from "../api/types";
import { layoutGet, layoutSave } from "../api/commands";

/** 持久化防抖句柄（模块级） */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** layout.json 版本号 */
const LAYOUT_VERSION = 1;

/**
 * 创建一个默认的未锁定空 leaf。
 * @returns 新的 LeafNode，sessionId 为 null
 */
function makeLeaf(): LeafNode {
  return { type: "leaf", id: crypto.randomUUID(), sessionId: null, locked: false };
}

/**
 * 把持久化节点转为运行时节点：leaf.sessionId 一律置 null（会话易失需重新绑定）。
 * @param node 持久化树节点
 * @returns 运行时 PaneNode
 */
function toRuntime(node: PersistedNode): PaneNode {
  if (node.type === "leaf") {
    return { type: "leaf", id: node.id, sessionId: null, locked: node.locked };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    children: [toRuntime(node.children[0]), toRuntime(node.children[1])],
  };
}

/**
 * 把运行时节点转为持久化节点：leaf 仅保留 {id,locked}（丢弃易失的 sessionId）。
 * @param node 运行时 PaneNode
 * @returns 持久化 PersistedNode
 */
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

/**
 * 先序遍历收集所有 leaf 节点。
 * @param node 树根
 * @returns leaf 节点数组（先序）
 */
function preorderLeaves(node: PaneNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return [...preorderLeaves(node.children[0]), ...preorderLeaves(node.children[1])];
}

/**
 * 不可变替换：把树中匹配 id 的 leaf 替换为 replacer 返回的新节点。
 * @param node 当前节点
 * @param leafId 目标 leaf id
 * @param replacer 用命中的旧 leaf 生成新节点
 * @returns 新树
 */
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

/**
 * 不可变移除某 leaf：其父 split 被兄弟节点取代（兄弟提升）。
 * 调用方需保证 leaf 非根（根 leaf 不可关闭）。
 * @param node 当前节点
 * @param leafId 待移除 leaf id
 * @returns 新树
 */
function removeLeaf(node: PaneNode, leafId: string): PaneNode {
  if (node.type === "leaf") return node; // 根 leaf 情形由调用方拦截
  const [a, b] = node.children;
  if (a.type === "leaf" && a.id === leafId) return b;
  if (b.type === "leaf" && b.id === leafId) return a;
  return {
    ...node,
    children: [removeLeaf(a, leafId), removeLeaf(b, leafId)],
  };
}

/** layoutStore 状态与动作定义 */
interface LayoutState {
  tree: PaneNode; // 分屏二叉树根（始终非空）
  activePaneId: string | null; // 当前活动 leaf id
  /** 从后端读取持久化布局，转 runtime；为空则默认单 leaf */
  load: () => Promise<void>;
  /** 防抖 300ms 持久化当前布局骨架 */
  persist: () => void;
  /** 将某 leaf 一分为二（原 leaf + 新 leaf），新 leaf 置为活动 */
  splitPane: (leafId: string, direction: "horizontal" | "vertical") => void;
  /** 关闭某 leaf（兄弟提升）；仅剩根 leaf 时禁止关闭 */
  closePane: (leafId: string) => void;
  /** 切换某 leaf 的锁定状态 */
  toggleLock: (leafId: string) => void;
  /** 设置活动 leaf */
  setActive: (leafId: string) => void;
  /** 设置某 split 的分割比例 */
  setRatio: (splitId: string, ratio: number) => void;
  /** 绑定/解绑某 leaf 的会话 id（不持久化） */
  assignSession: (leafId: string, sessionId: string | null) => void;
  /** 求落点 leaf：优先活动且未锁；否则先序第一个未锁；全锁返回 null */
  findTargetLeaf: () => string | null;
}

/** 分屏布局 store */
export const useLayoutStore = create<LayoutState>((set, get) => ({
  tree: makeLeaf(),
  activePaneId: null,

  /** 从后端读取持久化布局，转 runtime；tree 为空则默认单个未锁 leaf 并置为活动 */
  load: async () => {
    const layout = await layoutGet();
    if (!layout.tree) {
      const leaf = makeLeaf();
      set({ tree: leaf, activePaneId: leaf.id });
      return;
    }
    const tree = toRuntime(layout.tree);
    // 校验持久化的 activePaneId 仍存在，否则回退到先序第一个 leaf
    const leaves = preorderLeaves(tree);
    const active =
      layout.activePaneId && leaves.some((l) => l.id === layout.activePaneId)
        ? layout.activePaneId
        : (leaves[0]?.id ?? null);
    set({ tree, activePaneId: active });
  },

  /** 防抖 300ms 把当前布局骨架持久化到后端 */
  persist: () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const { tree, activePaneId } = get();
      void layoutSave({
        version: LAYOUT_VERSION,
        tree: toPersisted(tree),
        activePaneId,
      });
    }, 300);
  },

  /** 将某 leaf 一分为二：原 leaf 在前、新 leaf 在后，ratio=0.5，新 leaf 置为活动 */
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
  },

  /** 关闭某 leaf（兄弟提升取代父 split）；整棵树仅一个根 leaf 时禁止关闭 */
  closePane: (leafId) => {
    const { tree, activePaneId } = get();
    if (tree.type === "leaf") return; // 根 leaf 不可关闭
    const nextTree = removeLeaf(tree, leafId);
    // 若关闭的是活动 leaf，则把活动切到剩余先序第一个 leaf
    const nextActive =
      activePaneId === leafId ? (preorderLeaves(nextTree)[0]?.id ?? null) : activePaneId;
    set({ tree: nextTree, activePaneId: nextActive });
    get().persist();
  },

  /** 切换某 leaf 的锁定状态 */
  toggleLock: (leafId) => {
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
      ...leaf,
      locked: !leaf.locked,
    }));
    set({ tree });
    get().persist();
  },

  /** 设置活动 leaf 并持久化 */
  setActive: (leafId) => {
    set({ activePaneId: leafId });
    get().persist();
  },

  /** 设置某 split 的分割比例（第一个子节点占比 0~1） */
  setRatio: (splitId, ratio) => {
    const update = (node: PaneNode): PaneNode => {
      if (node.type === "leaf") return node;
      if (node.id === splitId) return { ...node, ratio };
      return { ...node, children: [update(node.children[0]), update(node.children[1])] };
    };
    set({ tree: update(get().tree) });
    get().persist();
  },

  /** 绑定/解绑某 leaf 的会话 id（sessionId 不持久化，故不触发 persist） */
  assignSession: (leafId, sessionId) => {
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({ ...leaf, sessionId }));
    set({ tree });
  },

  /** 求落点 leaf：优先活动且未锁的 leaf；否则先序第一个未锁 leaf；全锁返回 null */
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
}));
