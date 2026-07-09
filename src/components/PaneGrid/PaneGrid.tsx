/**
 * PaneGrid：递归渲染分屏二叉树（layoutStore.tree）。
 * - SplitNode → react-resizable-panels 的 PanelGroup(direction=node.direction)，
 *   内含两个 Panel（第一个 defaultSize=ratio*100，minSize=10）与中间的 PanelResizeHandle；
 *   拖拽时 onLayout 把新比例写回 layoutStore.setRatio。
 * - LeafNode → PaneLeaf（迷你标题栏 + 终端）。
 * 递归组件用 node.id 作 key，保证 split/close 后 React 正确 reconcile、xterm 实例不被误销毁。
 * 参考实施计划 9.1（分屏渲染）。
 */
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import type { PaneNode } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { PaneLeaf } from "./PaneLeaf";

/**
 * 递归渲染单个分屏节点。
 * @param node 当前分屏树节点（split 或 leaf）
 * @param setRatio 写回 split 比例的动作（拖拽 onLayout 时调用）
 * @returns 该节点对应的 React 元素
 */
function renderNode(
  node: PaneNode,
  setRatio: (splitId: string, ratio: number) => void,
): React.ReactElement {
  // 叶子节点：直接交给 PaneLeaf 渲染
  if (node.type === "leaf") {
    return <PaneLeaf key={node.id} leaf={node} />;
  }

  // 分割节点：PanelGroup 承载两个子面板 + 中缝拖拽把手
  const [first, second] = node.children;
  return (
    <PanelGroup
      key={node.id}
      direction={node.direction}
      className="pane-group"
      // 拖拽结束/变化时把第一个面板占比（0~100）换算成 0~1 写回 store
      onLayout={(sizes: number[]) => setRatio(node.id, sizes[0] / 100)}
    >
      <Panel
        id={`${first.id}-a`}
        order={1}
        defaultSize={node.ratio * 100}
        minSize={10}
        className="pane-panel"
      >
        {renderNode(first, setRatio)}
      </Panel>
      <PanelResizeHandle className="pane-divider" />
      <Panel id={`${second.id}-b`} order={2} minSize={10} className="pane-panel">
        {renderNode(second, setRatio)}
      </Panel>
    </PanelGroup>
  );
}

/**
 * 分屏网格根组件：从 layoutStore 读取整棵树并递归渲染。
 * @returns 分屏区域的 React 元素
 */
export function PaneGrid(): React.ReactElement {
  // 仅订阅需要的字段，避免无关 store 变更触发重渲染
  const tree = useLayoutStore((s) => s.tree);
  const setRatio = useLayoutStore((s) => s.setRatio);

  return <div className="pane-grid">{renderNode(tree, setRatio)}</div>;
}
