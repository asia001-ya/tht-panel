/**
 * PaneGrid：递归渲染分屏二叉树（layoutStore.tree）。
 * - SplitNode → react-resizable-panels 的 PanelGroup(direction=node.direction)，
 *   内含两个 Panel（第一个 defaultSize=ratio*100，minSize=10）与中间的 PanelResizeHandle；
 *   拖拽时 onLayout 把新比例写回 layoutStore.setRatio。
 * - LeafNode → PaneLeaf（迷你标题栏 + 终端）。
 * 递归组件用 node.id 作 key，保证 split/close 后 React 正确 reconcile、xterm 实例不被误销毁。
 * 参考实施计划 9.1（分屏渲染）。
 */
import { useEffect, useRef, useState } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import type { LeafNode, PaneNode } from "../../api/types";
import {
  PANE_DRAG_TYPE,
  beginPaneHtmlDrag,
  endPaneHtmlDrag,
} from "../../lib/paneDrag";
import { useLayoutStore } from "../../store/layoutStore";
import { PaneLeaf } from "./PaneLeaf";

const PANE_DRAG_THRESHOLD = 6;
const PANE_LEAF_SELECTOR = "[data-pane-leaf-id]";

interface PaneGridRenderContext {
  setRatio: (splitId: string, ratio: number) => void;
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
  onClosePane: (leaf: LeafNode) => Promise<void>;
  closingSessionIds: ReadonlySet<string>;
  closingPaneIds: ReadonlySet<string>;
  dropTargetLeafId: string | null;
  onPanePointerDown: (
    leafId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
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
  onPaneDragEnd: (event: React.DragEvent<HTMLElement>) => void;
  draggedLeafId: string | null;
  onCreateTerminal?: (workspaceId?: string) => void;
}

function resolvePaneLeafId(
  ownerDocument: Document,
  clientX: number,
  clientY: number,
): string | null {
  if (typeof ownerDocument.elementFromPoint !== "function") return null;
  const element = ownerDocument.elementFromPoint(clientX, clientY);
  return element?.closest<HTMLElement>(PANE_LEAF_SELECTOR)?.dataset.paneLeafId ?? null;
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
        onCloseTab={context.onCloseTab}
        onClosePane={context.onClosePane}
        closingSessionIds={context.closingSessionIds}
        closingPaneIds={context.closingPaneIds}
        draggedLeafId={context.draggedLeafId}
        dropTargetLeafId={context.dropTargetLeafId}
        onPanePointerDown={context.onPanePointerDown}
        onPaneDragStart={context.onPaneDragStart}
        onPaneDragOver={context.onPaneDragOver}
        onPaneDragLeave={context.onPaneDragLeave}
        onPaneDrop={context.onPaneDrop}
        onPaneDragEnd={context.onPaneDragEnd}
        onCreateTerminal={context.onCreateTerminal}
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

interface PaneGridProps {
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
  onClosePane: (leaf: LeafNode) => Promise<void>;
  closingSessionIds: ReadonlySet<string>;
  closingPaneIds: ReadonlySet<string>;
  onCreateTerminal?: (workspaceId?: string) => void;
}

/**
 * 分屏网格根组件：从 layoutStore 读取整棵树并递归渲染。
 * @param props 由应用层提供的关闭 Tab 与关闭窗格生命周期回调。
 * @returns 分屏区域的 React 元素
 */
export function PaneGrid({
  onCloseTab,
  onClosePane,
  closingSessionIds,
  closingPaneIds,
  onCreateTerminal,
}: PaneGridProps): React.ReactElement {
  // 仅订阅需要的字段，避免无关 store 变更触发重渲染
  const tree = useLayoutStore((s) => s.tree);
  const setRatio = useLayoutStore((s) => s.setRatio);
  const swapPaneContents = useLayoutStore((s) => s.swapPaneContents);
  const [draggedLeafId, setDraggedLeafId] = useState<string | null>(null);
  const [dropTargetLeafId, setDropTargetLeafId] = useState<string | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const htmlDraggedLeafRef = useRef<string | null>(null);

  useEffect(() => () => pointerCleanupRef.current?.(), []);

  /**
   * 清除当前窗格拖放的源与目标状态。
   * @returns 无返回值。
   */
  function clearPaneDragState(): void {
    htmlDraggedLeafRef.current = null;
    setDraggedLeafId(null);
    setDropTargetLeafId(null);
  }

  function handlePaneDragStart(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    pointerCleanupRef.current?.();
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PANE_DRAG_TYPE, leafId);
    event.dataTransfer.setData("text/plain", leafId);
    beginPaneHtmlDrag(event.dataTransfer);
    htmlDraggedLeafRef.current = leafId;
    setDraggedLeafId(leafId);
    setDropTargetLeafId(null);
  }

  function handlePaneDragOver(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    if (!htmlDraggedLeafRef.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetLeafId(
      htmlDraggedLeafRef.current === leafId ? null : leafId,
    );
  }

  function handlePaneDragLeave(
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTargetLeafId((currentLeafId) =>
      currentLeafId === leafId ? null : currentLeafId,
    );
  }

  function handlePaneDrop(
    targetLeafId: string,
    event: React.DragEvent<HTMLElement>,
  ): void {
    const sourceLeafId = htmlDraggedLeafRef.current;
    if (!sourceLeafId) return;
    event.preventDefault();
    endPaneHtmlDrag(event.dataTransfer);
    if (sourceLeafId !== targetLeafId) {
      swapPaneContents(sourceLeafId, targetLeafId);
    }
    clearPaneDragState();
  }

  function handlePaneDragEnd(event: React.DragEvent<HTMLElement>): void {
    endPaneHtmlDrag(event.dataTransfer);
    clearPaneDragState();
  }

  /**
   * 通过 Pointer Events 启动窗格拖动，避开 xterm 对原生 drag/drop 的拦截。
   * @param leafId 被拖动的叶子节点 ID。
   * @param event 标题栏拖动区触发的指针事件。
   * @returns 无返回值。
   */
  function handlePanePointerDown(
    leafId: string,
    event: React.PointerEvent<HTMLElement>,
  ): void {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, input, textarea, select, a, [data-pane-drag-ignore]")
    ) {
      return;
    }

    pointerCleanupRef.current?.();
    const captureTarget = event.currentTarget;
    const ownerDocument = captureTarget.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const oldUserSelect = ownerDocument.body.style.userSelect;
    const oldCursor = ownerDocument.body.style.cursor;
    let dragging = false;
    let targetLeafId: string | null = null;
    let suppressClickListener: ((clickEvent: MouseEvent) => void) | null = null;

    const armClickSuppression = (): void => {
      if (suppressClickListener) return;
      suppressClickListener = (clickEvent: MouseEvent): void => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        if (suppressClickListener) {
          captureTarget.removeEventListener("click", suppressClickListener, true);
          suppressClickListener = null;
        }
      };
      captureTarget.addEventListener("click", suppressClickListener, true);
    };

    const updateDropTarget = (clientX: number, clientY: number): void => {
      const candidate = resolvePaneLeafId(ownerDocument, clientX, clientY);
      const next = candidate && candidate !== leafId ? candidate : null;
      if (next === targetLeafId) return;
      targetLeafId = next;
      setDropTargetLeafId(next);
    };

    const cleanup = (): void => {
      ownerDocument.removeEventListener("pointermove", onPointerMove, true);
      ownerDocument.removeEventListener("pointerup", onPointerUp, true);
      ownerDocument.removeEventListener("pointercancel", onPointerCancel, true);
      ownerWindow?.removeEventListener("blur", onWindowBlur);
      ownerDocument.body.style.userSelect = oldUserSelect;
      ownerDocument.body.style.cursor = oldCursor;
      if (suppressClickListener) {
        const listener = suppressClickListener;
        ownerWindow?.setTimeout(() => {
          captureTarget.removeEventListener("click", listener, true);
          if (suppressClickListener === listener) suppressClickListener = null;
        }, 0);
      }
      try {
        if (captureTarget.hasPointerCapture?.(pointerId)) {
          captureTarget.releasePointerCapture(pointerId);
        }
      } catch {
        // 窗格卸载时浏览器会自动释放捕获。
      }
      pointerCleanupRef.current = null;
      clearPaneDragState();
    };

    const finish = (pointerEvent: PointerEvent, canceled: boolean): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (dragging) {
        pointerEvent.preventDefault();
        if (!canceled && targetLeafId) swapPaneContents(leafId, targetLeafId);
      }
      cleanup();
    };

    function onPointerMove(pointerEvent: PointerEvent): void {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!dragging) {
        const distance = Math.hypot(
          pointerEvent.clientX - startX,
          pointerEvent.clientY - startY,
        );
        if (distance < PANE_DRAG_THRESHOLD) return;
        dragging = true;
        armClickSuppression();
        setDraggedLeafId(leafId);
        ownerDocument.body.style.userSelect = "none";
        ownerDocument.body.style.cursor = "grabbing";
      }
      pointerEvent.preventDefault();
      updateDropTarget(pointerEvent.clientX, pointerEvent.clientY);
    }

    function onPointerUp(pointerEvent: PointerEvent): void {
      finish(pointerEvent, false);
    }

    function onPointerCancel(pointerEvent: PointerEvent): void {
      finish(pointerEvent, true);
    }

    function onWindowBlur(): void {
      cleanup();
    }

    try {
      captureTarget.setPointerCapture?.(pointerId);
    } catch {
      // 测试环境或旧 WebView 可能不支持指针捕获。
    }
    ownerDocument.addEventListener("pointermove", onPointerMove, true);
    ownerDocument.addEventListener("pointerup", onPointerUp, true);
    ownerDocument.addEventListener("pointercancel", onPointerCancel, true);
    ownerWindow?.addEventListener("blur", onWindowBlur);
    pointerCleanupRef.current = cleanup;
    event.preventDefault();
  }

  return (
    <div className={`pane-grid${draggedLeafId ? " pane-grid-dragging" : ""}`}>
      {renderNode(tree, {
        setRatio,
        onCloseTab,
        onClosePane,
        closingSessionIds,
        closingPaneIds,
        dropTargetLeafId,
        onPanePointerDown: handlePanePointerDown,
        onPaneDragStart: handlePaneDragStart,
        onPaneDragOver: handlePaneDragOver,
        onPaneDragLeave: handlePaneDragLeave,
        onPaneDrop: handlePaneDrop,
        onPaneDragEnd: handlePaneDragEnd,
        draggedLeafId,
        onCreateTerminal,
      })}
    </div>
  );
}
