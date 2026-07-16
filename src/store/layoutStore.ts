/**
 * 分屏布局 store：分屏二叉树 + 活动 leaf + 窗格内 Tab。
 * 所有树操作均为纯函数式不可变更新；新节点 id 用 crypto.randomUUID()。
 * 运行时 leaf.sessionIds/activeSessionId 易失（不持久化），持久化只存骨架 {id,name?,locked}。
 */
import { create } from "zustand";
import type {
  PaneNode,
  LeafNode,
  SplitNode,
  PersistedNode,
  PersistedLeaf,
  PersistedSplit,
  SavedSessionRef,
  SavedWorkspaceLayout,
} from "../api/types";
import { layoutGet, layoutSave } from "../api/commands";
import {
  clonePaneTree,
  createSavedWorkspaceSnapshot,
  renamePane as renamePaneInTree,
  replaceLeafSession,
  swapLeafContents,
} from "./layoutOperations";

let persistTimer: ReturnType<typeof setTimeout> | null = null;

let activeWorkspaceRefsProvider: (() => Record<string, SavedSessionRef>) | null = null;

/** 恢复编排等多步操作期间置 true，避免把半成品状态写回激活工作区。 */
let activeWorkspaceSyncSuspended = false;

/**
 * 运行时树是否已被会话级操作触碰。load() 产出的骨架树 sessionIds 恒为空，
 * 在触碰前写回会把激活工作区的会话引用抹成空，因此作为写回的前置条件。
 */
let sessionTreeTouched = false;

/**
 * 注册激活工作区写回时的会话引用提供者。
 * @param provider 构建当前稳定会话引用的函数；null 表示注销。
 * @returns 无返回值。
 */
export function registerActiveWorkspaceRefsProvider(
  provider: (() => Record<string, SavedSessionRef>) | null,
): void {
  activeWorkspaceRefsProvider = provider;
}

/**
 * 暂停或恢复激活工作区的自动写回。
 * @param suspended true 表示暂停写回（恢复编排执行中），false 表示恢复。
 * @returns 无返回值。
 */
export function setActiveWorkspaceSyncSuspended(suspended: boolean): void {
  activeWorkspaceSyncSuspended = suspended;
}

const LAYOUT_VERSION = 1;

/**
 * 创建一个空的运行时叶子窗格。
 * @returns 带唯一 ID 的未锁定空窗格。
 */
function makeLeaf(): LeafNode {
  return { type: "leaf", id: crypto.randomUUID(), sessionIds: [], activeSessionId: null, locked: false };
}

/**
 * 把持久化布局骨架转换为运行时窗格树。
 * @param node 待转换的持久化节点。
 * @returns 会话列表为空且保留名称、锁定状态的运行时节点。
 */
function toRuntime(node: PersistedNode): PaneNode {
  if (node.type === "leaf") {
    return {
      type: "leaf",
      id: node.id,
      name: node.name,
      sessionIds: [],
      activeSessionId: null,
      locked: node.locked,
    };
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
 * 把运行时窗格树转换为不包含易失会话 ID 的持久化骨架。
 * @param node 待转换的运行时节点。
 * @returns 保留名称、锁定状态和分屏结构的持久化节点。
 */
function toPersisted(node: PaneNode): PersistedNode {
  if (node.type === "leaf") {
    const leaf: PersistedLeaf = {
      type: "leaf",
      id: node.id,
      name: node.name,
      locked: node.locked,
    };
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
 * 先序遍历收集所有叶子窗格。
 * @param node 待遍历的窗格树。
 * @returns 按布局顺序排列的叶子窗格。
 */
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
  restoreErrors: Record<string, string>;
  activeSavedWorkspaceId: string | null;
  /** 从后端加载持久化布局；无参数，无返回值。 */
  load: () => Promise<void>;
  /** 延迟保存当前布局；无参数，无返回值。 */
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
  /**
   * 重命名窗格。
   * @param leafId 目标窗格 ID。
   * @param name 用户输入的名称。
   * @returns 重复名称错误文案，成功时返回 null。
   */
  renamePane: (leafId: string, name: string) => string | null;
  /**
   * 在指定窗格内原位替换恢复后的会话 ID。
   * @param leafId 目标窗格 ID。
   * @param oldId 快照中的旧会话 ID。
   * @param newId 恢复后的新会话 ID。
   * @returns 无返回值。
   */
  replaceSession: (leafId: string, oldId: string, newId: string) => void;
  /**
   * 记录或清除指定窗格的会话恢复错误。
   * @param leafId 目标窗格 ID。
   * @param message 错误文案；null 表示清除。
   * @returns 无返回值。
   */
  setRestoreError: (leafId: string, message: string | null) => void;
  /**
   * 保存当前工作区。
   * @param name 保存工作区名称。
   * @param sessionRefs 快照 Tab 对应的稳定会话引用。
   * @returns 空名称返回 null，否则返回新快照。
   */
  saveCurrentWorkspace: (
    name: string,
    sessionRefs?: Record<string, SavedSessionRef>,
  ) => SavedWorkspaceLayout | null;
  /**
   * 恢复指定工作区。
   * @param savedWorkspaceId 保存工作区 ID。
   * @returns 不存在时返回 null，否则返回对应快照。
   */
  restoreSavedWorkspace: (savedWorkspaceId: string) => SavedWorkspaceLayout | null;
  /**
   * 删除指定的保存工作区。
   * @param savedWorkspaceId 待删除的保存工作区 ID。
   * @returns 无返回值。
   */
  removeSavedWorkspace: (savedWorkspaceId: string) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  tree: makeLeaf(),
  activePaneId: null,
  savedWorkspaces: [],
  restoreErrors: {},
  activeSavedWorkspaceId: null,

  /** 从后端加载布局；无参数，返回加载完成的 Promise。 */
  load: async () => {
    const layout = await layoutGet();
    // 加载产出的是骨架树，在首次会话级操作前不得写回激活工作区
    sessionTreeTouched = false;
    const savedWorkspaces = layout.savedWorkspaces ?? [];
    const activeSavedWorkspaceId = savedWorkspaces.some(
      (item) => item.id === layout.activeSavedWorkspaceId,
    )
      ? (layout.activeSavedWorkspaceId ?? null)
      : null;
    if (!layout.tree) {
      const leaf = makeLeaf();
      set({
        tree: leaf,
        activePaneId: leaf.id,
        savedWorkspaces,
        restoreErrors: {},
        activeSavedWorkspaceId,
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
      savedWorkspaces,
      restoreErrors: {},
      activeSavedWorkspaceId,
    });
  },

  /** 延迟持久化当前布局；无参数，无返回值。 */
  persist: () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const { tree, activePaneId, activeSavedWorkspaceId, savedWorkspaces } = get();
      let nextSavedWorkspaces = savedWorkspaces;
      // 激活工作区随最新布局与会话引用自动写回（活文档语义）；
      // 骨架树未触碰或恢复编排执行中时跳过，防止覆盖快照内容
      const refsProvider = activeWorkspaceRefsProvider;
      if (
        activeSavedWorkspaceId
        && refsProvider
        && sessionTreeTouched
        && !activeWorkspaceSyncSuspended
      ) {
        nextSavedWorkspaces = savedWorkspaces.map((item) =>
          item.id === activeSavedWorkspaceId
            ? createSavedWorkspaceSnapshot({
                ...item,
                tree,
                activePaneId,
                sessionRefs: refsProvider(),
              })
            : item,
        );
        set({ savedWorkspaces: nextSavedWorkspaces });
      }
      void layoutSave({
        version: LAYOUT_VERSION,
        tree: toPersisted(tree),
        activePaneId,
        activeSavedWorkspaceId: activeSavedWorkspaceId ?? undefined,
        savedWorkspaces: nextSavedWorkspaces,
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
      sessionTreeTouched = true;
      set({ tree });
      if (get().activeSavedWorkspaceId) get().persist();
      return;
    }
    // 追加新 Tab 并激活
    const tree = replaceLeaf(get().tree, leafId, (leaf) => ({
      ...leaf,
      sessionIds: [...leaf.sessionIds, sessionId],
      activeSessionId: sessionId,
    }));
    sessionTreeTouched = true;
    set({ tree });
    if (get().activeSavedWorkspaceId) get().persist();
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
    sessionTreeTouched = true;
    set({ tree });
    if (get().activeSavedWorkspaceId) get().persist();
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
    sessionTreeTouched = true;
    set({ tree });
    if (get().activeSavedWorkspaceId) get().persist();
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

  /** 重命名窗格；参数为窗格 ID 与名称，返回错误文案或 null。 */
  renamePane: (leafId, name) => {
    const currentTree = get().tree;
    const result = renamePaneInTree(currentTree, leafId, name);
    if (result.error) return result.error;
    if (result.tree !== currentTree) {
      set({ tree: result.tree });
      get().persist();
    }
    return null;
  },

  /** 原位替换会话 ID；参数为窗格 ID、旧 ID 与新 ID，无返回值。 */
  replaceSession: (leafId, oldId, newId) => {
    const currentTree = get().tree;
    const tree = replaceLeafSession(currentTree, leafId, oldId, newId);
    if (tree !== currentTree) {
      sessionTreeTouched = true;
      set({ tree });
      if (get().activeSavedWorkspaceId) get().persist();
    }
  },

  /** 设置恢复错误；参数为窗格 ID 与可空错误文案，无返回值。 */
  setRestoreError: (leafId, message) => {
    set((state) => {
      const restoreErrors = { ...state.restoreErrors };
      if (message === null) {
        delete restoreErrors[leafId];
      } else {
        restoreErrors[leafId] = message;
      }
      return { restoreErrors };
    });
  },

  /** 保存当前工作区；参数为名称和可选会话引用，返回新快照或 null。 */
  saveCurrentWorkspace: (name, sessionRefs) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const { tree, activePaneId, savedWorkspaces } = get();
    const snapshot = createSavedWorkspaceSnapshot({
      id: crypto.randomUUID(),
      name: trimmed,
      tree,
      activePaneId,
      createdAt: new Date().toISOString(),
      sessionRefs,
    });
    set({
      savedWorkspaces: [...savedWorkspaces, snapshot],
      activeSavedWorkspaceId: snapshot.id,
    });
    get().persist();
    return snapshot;
  },

  /** 恢复保存工作区；参数为快照 ID，返回对应快照或 null。 */
  restoreSavedWorkspace: (savedWorkspaceId) => {
    const saved = get().savedWorkspaces.find((item) => item.id === savedWorkspaceId);
    if (!saved) return null;
    // 恢复出的树携带快照会话内容，属于会话级变更
    sessionTreeTouched = true;
    set({
      tree: clonePaneTree(saved.tree),
      activePaneId: saved.activePaneId,
      activeSavedWorkspaceId: saved.id,
      restoreErrors: {},
    });
    get().persist();
    return saved;
  },

  /** 删除保存工作区；参数为快照 ID，删除活动快照时同步清空引用。 */
  removeSavedWorkspace: (savedWorkspaceId) => {
    set((state) => ({
      savedWorkspaces: state.savedWorkspaces.filter(
        (item) => item.id !== savedWorkspaceId,
      ),
      activeSavedWorkspaceId:
        state.activeSavedWorkspaceId === savedWorkspaceId
          ? null
          : state.activeSavedWorkspaceId,
    }));
    get().persist();
  },
}));
