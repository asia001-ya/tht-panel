import type { LeafNode, PaneNode, SavedWorkspaceLayout } from "../api/types";

/**
 * 深拷贝窗格树，隔离运行时布局与保存快照。
 * @param tree 待复制的窗格树。
 * @returns 与原树内容一致且引用独立的新树。
 */
export function clonePaneTree(tree: PaneNode): PaneNode {
  return structuredClone(tree);
}

/**
 * 深拷贝保存工作区，避免后续布局或会话引用变化污染快照。
 * @param snapshot 待保存的工作区快照。
 * @returns 与输入内容一致且引用独立的新快照。
 */
export function createSavedWorkspaceSnapshot(
  snapshot: SavedWorkspaceLayout,
): SavedWorkspaceLayout {
  return structuredClone(snapshot);
}

/**
 * 按 ID 查找叶子窗格。
 * @param tree 待查找的窗格树。
 * @param leafId 目标叶子窗格 ID。
 * @returns 找到的叶子窗格；不存在时返回 null。
 */
function findLeaf(tree: PaneNode, leafId: string): LeafNode | null {
  if (tree.type === "leaf") return tree.id === leafId ? tree : null;
  return findLeaf(tree.children[0], leafId) ?? findLeaf(tree.children[1], leafId);
}

/**
 * 不可变更新指定叶子窗格，并复用未变化的树分支。
 * @param tree 待修改的窗格树。
 * @param leafId 目标叶子窗格 ID。
 * @param replacer 生成目标叶子新值的函数。
 * @returns 更新后的窗格树；目标或内容未变化时返回原树。
 */
function updateLeaf(
  tree: PaneNode,
  leafId: string,
  replacer: (leaf: LeafNode) => LeafNode,
): PaneNode {
  if (tree.type === "leaf") {
    return tree.id === leafId ? replacer(tree) : tree;
  }
  const children: [PaneNode, PaneNode] = [
    updateLeaf(tree.children[0], leafId, replacer),
    updateLeaf(tree.children[1], leafId, replacer),
  ];
  if (children[0] === tree.children[0] && children[1] === tree.children[1]) {
    return tree;
  }
  return { ...tree, children };
}

/**
 * 修改叶子窗格名称，并确保当前布局内名称忽略大小写后唯一。
 * @param tree 待修改的窗格树。
 * @param leafId 目标叶子窗格 ID。
 * @param requestedName 用户请求的名称；空白名称用于清除显式名称。
 * @returns 更新后的树；名称重复时同时返回错误信息。
 */
export function renamePane(
  tree: PaneNode,
  leafId: string,
  requestedName: string,
): { tree: PaneNode; error?: string } {
  const name = requestedName.trim();
  const target = findLeaf(tree, leafId);
  if (!target) return { tree };

  const normalizedName = name || undefined;
  if (target.name === normalizedName) return { tree };

  const lowerCaseName = name.toLowerCase();
  const duplicate = name
    ? preorderLeafNodes(tree).some(
        (leaf) =>
          leaf.id !== leafId && leaf.name?.toLowerCase() === lowerCaseName,
      )
    : false;
  if (duplicate) return { tree, error: "窗格名称已存在" };

  return {
    tree: updateLeaf(tree, leafId, (leaf) => ({
      ...leaf,
      name: normalizedName,
    })),
  };
}

/**
 * 先序收集树中的叶子窗格，供名称唯一性检查使用。
 * @param tree 待遍历的窗格树。
 * @returns 按布局顺序排列的叶子窗格。
 */
function preorderLeafNodes(tree: PaneNode): LeafNode[] {
  if (tree.type === "leaf") return [tree];
  return [
    ...preorderLeafNodes(tree.children[0]),
    ...preorderLeafNodes(tree.children[1]),
  ];
}

/**
 * 在指定窗格中原位替换会话 ID，并同步活动会话 ID。
 * @param tree 待修改的窗格树。
 * @param leafId 目标叶子窗格 ID。
 * @param oldSessionId 快照中的旧会话 ID。
 * @param newSessionId 恢复后的新会话 ID。
 * @returns 替换后的窗格树；目标不存在时返回原树。
 */
export function replaceLeafSession(
  tree: PaneNode,
  leafId: string,
  oldSessionId: string,
  newSessionId: string,
): PaneNode {
  if (oldSessionId === newSessionId) return tree;

  return updateLeaf(tree, leafId, (leaf) => {
    if (!leaf.sessionIds.includes(oldSessionId)) return leaf;
    return {
      ...leaf,
      sessionIds: leaf.sessionIds.map((id) =>
        id === oldSessionId ? newSessionId : id,
      ),
      activeSessionId:
        leaf.activeSessionId === oldSessionId
          ? newSessionId
          : leaf.activeSessionId,
    };
  });
}

/**
 * 交换两个叶子窗格的 Tab 内容，保留各自 ID、名称和锁定状态。
 * @param tree 待修改的窗格树。
 * @param sourceLeafId 来源叶子窗格 ID。
 * @param targetLeafId 目标叶子窗格 ID。
 * @returns 交换内容后的窗格树；目标无效时返回原树。
 */
export function swapLeafContents(
  tree: PaneNode,
  sourceLeafId: string,
  targetLeafId: string,
): PaneNode {
  if (sourceLeafId === targetLeafId) return tree;
  const source = findLeaf(tree, sourceLeafId);
  const target = findLeaf(tree, targetLeafId);
  if (!source || !target) return tree;

  const update = (node: PaneNode): PaneNode => {
    if (node.type === "split") {
      return { ...node, children: [update(node.children[0]), update(node.children[1])] };
    }
    if (node.id === sourceLeafId) {
      return {
        ...node,
        sessionIds: [...target.sessionIds],
        activeSessionId: target.activeSessionId,
      };
    }
    if (node.id === targetLeafId) {
      return {
        ...node,
        sessionIds: [...source.sessionIds],
        activeSessionId: source.activeSessionId,
      };
    }
    return node;
  };

  return update(tree);
}
