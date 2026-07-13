import type { LeafNode, PaneNode, SavedWorkspaceLayout } from "../api/types";

export function clonePaneTree(tree: PaneNode): PaneNode {
  return structuredClone(tree);
}

export function createSavedWorkspaceSnapshot(
  snapshot: SavedWorkspaceLayout,
): SavedWorkspaceLayout {
  return { ...snapshot, tree: clonePaneTree(snapshot.tree) };
}

function findLeaf(tree: PaneNode, leafId: string): LeafNode | null {
  if (tree.type === "leaf") return tree.id === leafId ? tree : null;
  return findLeaf(tree.children[0], leafId) ?? findLeaf(tree.children[1], leafId);
}

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
