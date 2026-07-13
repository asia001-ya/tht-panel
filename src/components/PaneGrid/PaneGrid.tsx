/**
 * PaneGrid：递归渲染分屏二叉树（layoutStore.tree）。
 * - SplitNode → react-resizable-panels 的 PanelGroup(direction=node.direction)，
 *   内含两个 Panel（第一个 defaultSize=ratio*100，minSize=10）与中间的 PanelResizeHandle；
 *   拖拽时 onLayout 把新比例写回 layoutStore.setRatio。
 * - LeafNode → PaneLeaf（迷你标题栏 + 终端）。
 * 递归组件用 node.id 作 key，保证 split/close 后 React 正确 reconcile、xterm 实例不被误销毁。
 * 参考实施计划 9.1（分屏渲染）。
 */
import { useState } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import type { PaneNode } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { PaneLeaf } from "./PaneLeaf";

const PANE_DRAG_TYPE = "application/x-tht-pane";

interface PaneGridRenderContext {
  setRatio: (splitId: string, ratio: number) => void;
  dropTargetLeafId: string | null;
  onPaneDragStart: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragOver: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragLeave: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDrop: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragEnd: () => void;
}

/**
 * 递归渲染单个分屏节点。
 * @param node 当前分屏树节点（split 或 leaf）
 * @param context 比例写回与窗格拖放共享状态处理器
 * @returns 该节点对应的 React 元素
 */
function renderNode(
  node: PaneNode,
  context: PaneGridRenderContext,
): React.ReactElement {
  // 叶子节点：直接交给 PaneLeaf 渲染
  if (node.type === "leaf") {
    return (
      <PaneLeaf
        key={node.id}
        leaf={node}
        dropTargetLeafId={context.dropTargetLeafId}
        onPaneDragStart={context.onPaneDragStart}
        onPaneDragOver={context.onPaneDragOver}
        onPaneDragLeave={context.onPaneDragLeave}
        onPaneDrop={context.onPaneDrop}
        onPaneDragEnd={context.onPaneDragEnd}
      />
    );
  }

  // 分割节点：PanelGroup 承载两个子面板 + 中缝拖拽把手
  const [first, second] = node.children;
  return (
    <PanelGroup
      key={node.id}
      direction={node.direction}
      className="pane-group"
      // 拖拽结束/变化时把第一个面板占比（0~100）换算成 0~1 写回 store
      onLayout={(sizes: number[]) => context.setRatio(node.id, sizes[0] / 100)}
    >
      <Panel
        id={`${first.id}-a`}
        order={1}
        defaultSize={node.ratio * 100}
        minSize={10}
        className="pane-panel"
      >
        {renderNode(first, context)}
      </Panel>
      <PanelResizeHandle className="pane-divider" />
      <Panel id={`${second.id}-b`} order={2} minSize={10} className="pane-panel">
        {renderNode(second, context)}
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
  const swapPaneContents = useLayoutStore((s) => s.swapPaneContents);
  const [draggedLeafId, setDraggedLeafId] = useState<string | null>(null);
  const [dropTargetLeafId, setDropTargetLeafId] = useState<string | null>(null);

  /**
   * 清除当前窗格拖放的源与目标状态。
   * @returns 无返回值。
   */
  function clearPaneDragState(): void {
    setDraggedLeafId(null);
    setDropTargetLeafId(null);
  }

  /**
   * 初始化窗格拖动，并写入 WebView 与标准浏览器可读取的数据类型。
   * @param leafId 被拖动的叶子节点 ID。
   * @param event 拖动句柄触发的 dragstart 事件。
   * @returns 无返回值。
   */
  function handlePaneDragStart(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PANE_DRAG_TYPE, leafId);
    event.dataTransfer.setData("text/plain", leafId);
    setDraggedLeafId(leafId);
    setDropTargetLeafId(null);
  }

  /**
   * 接管应用内部窗格拖放，并更新当前目标反馈。
   * @param leafId 当前悬停的叶子节点 ID。
   * @param event 目标窗格触发的 dragover 事件。
   * @returns 无返回值。
   */
  function handlePaneDragOver(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    if (!draggedLeafId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetLeafId(leafId);
  }

  /**
   * 在指针完全离开当前窗格时清除该目标反馈。
   * @param leafId 当前离开的叶子节点 ID。
   * @param event 目标窗格触发的 dragleave 事件。
   * @returns 无返回值。
   */
  function handlePaneDragLeave(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTargetLeafId((currentLeafId) =>
      currentLeafId === leafId ? null : currentLeafId,
    );
  }

  /**
   * 完成窗格拖放，并在源和目标不同时交换内容。
   * @param targetLeafId 放置目标叶子节点 ID。
   * @param event 目标窗格触发的 drop 事件。
   * @returns 无返回值。
   */
  function handlePaneDrop(
    targetLeafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    if (!draggedLeafId) return;
    event.preventDefault();
    if (draggedLeafId !== targetLeafId) {
      swapPaneContents(draggedLeafId, targetLeafId);
    }
    clearPaneDragState();
  }

  /**
   * 处理源句柄结束或取消拖动，统一清除跨叶子反馈。
   * @returns 无返回值。
   */
  function handlePaneDragEnd(): void {
    clearPaneDragState();
  }

  return (
    <div className="pane-grid">
      {renderNode(tree, {
        setRatio,
        dropTargetLeafId,
        onPaneDragStart: handlePaneDragStart,
        onPaneDragOver: handlePaneDragOver,
        onPaneDragLeave: handlePaneDragLeave,
        onPaneDrop: handlePaneDrop,
        onPaneDragEnd: handlePaneDragEnd,
      })}
    </div>
  );
}
