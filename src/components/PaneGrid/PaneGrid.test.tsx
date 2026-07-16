// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeafNode, PaneNode } from "../../api/types";
import { preorderLeaves, useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useTaskStore } from "../../store/taskStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { PaneGrid } from "./PaneGrid";

const PANE_DRAG_TYPE = "application/x-tht-pane";
const TEXT_DRAG_TYPE = "text/plain";

vi.mock("react-resizable-panels", () => ({
  /**
   * 模拟分隔容器，并通过测试按钮触发布局比例回调。
   * @param props 子节点、样式类名、分隔方向与布局回调。
   * @returns 可触发布局变化的测试容器。
   */
  PanelGroup: function MockPanelGroup({
    children,
    className,
    direction,
    onLayout,
  }: {
    children: ReactNode;
    className?: string;
    direction: "horizontal" | "vertical";
    onLayout?: (sizes: number[]) => void;
  }): React.ReactElement {
    return (
      <div className={className} data-direction={direction} data-testid="panel-group">
        <button
          data-testid="trigger-layout"
          type="button"
          onClick={() => onLayout?.([35, 65])}
        />
        {children}
      </div>
    );
  },
  /**
   * 模拟面板并暴露最小尺寸，供测试验证约束。
   * @param props 子节点、样式类名与最小尺寸。
   * @returns 暴露面板约束的测试节点。
   */
  Panel: function MockPanel({
    children,
    className,
    minSize,
  }: {
    children: ReactNode;
    className?: string;
    minSize?: number;
  }): React.ReactElement {
    return (
      <div className={className} data-min-size={minSize} data-testid="panel">
        {children}
      </div>
    );
  },
  /**
   * 模拟分隔线渲染。
   * @param props 分隔线样式类名。
   * @returns 分隔线测试节点。
   */
  PanelResizeHandle: function MockPanelResizeHandle({
    className,
  }: {
    className?: string;
  }): React.ReactElement {
    return <div className={className} data-testid="panel-resize-handle" />;
  },
}));

vi.mock("../../terminal/TerminalPane", () => ({
  /**
   * 在测试中替代真实终端实例。
   * @returns 空渲染结果。
   */
  TerminalPane: function MockTerminalPane(): null {
    return null;
  },
}));

vi.mock("../Conversation/NativeChatPane", () => ({
  /**
   * 在测试中替代原生会话实例。
   * @returns 空渲染结果。
   */
  NativeChatPaneHost: function MockNativeChatPaneHost(): null {
    return null;
  },
}));

const originalSetRatio = useLayoutStore.getState().setRatio;
const originalSwapPaneContents = useLayoutStore.getState().swapPaneContents;

/**
 * 创建每个用例独立的双叶布局。
 * @param leftName 左侧窗格显式名称。
 * @param rightName 右侧窗格显式名称。
 * @returns 包含左右两个叶子的分屏树。
 */
function createTestTree(leftName?: string, rightName?: string): PaneNode {
  return {
    type: "split",
    id: "split-root",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      {
        type: "leaf",
        id: "leaf-left",
        name: leftName,
        sessionIds: ["pty-left-1", "pty-left-2"],
        activeSessionId: "pty-left-1",
        locked: false,
      },
      {
        type: "leaf",
        id: "leaf-right",
        name: rightName,
        sessionIds: [],
        activeSessionId: null,
        locked: true,
      },
    ],
  };
}

/**
 * 创建可读写的 DataTransfer 测试替身，并允许固定暴露的 types 为空。
 * @param types 浏览器对外暴露的数据类型列表。
 * @returns 可用于原生拖放事件的 DataTransfer 对象。
 */
function createDataTransfer(types: string[] = []): DataTransfer {
  const values = new Map<string, string>();
  const setData = vi.fn((format: string, value: string): void => {
    values.set(format, value);
  });
  const getData = vi.fn((format: string): string => values.get(format) ?? "");

  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    types,
    setData,
    getData,
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

/**
 * 创建携带 DataTransfer 的可取消拖放事件。
 * @param type 拖放事件类型。
 * @param dataTransfer 事件携带的数据传输对象。
 * @param relatedTarget 离开事件的新目标。
 * @returns 可交给 Testing Library 派发的原生事件。
 */
function createDragEvent(
  type: string,
  dataTransfer: DataTransfer,
  relatedTarget: EventTarget | null = null,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  return event;
}

interface RenderedPaneGrid {
  sourceHandle: HTMLElement;
  sourceLeaf: HTMLElement;
  targetLeaf: HTMLElement;
}

interface CloseCallbacks {
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
  onClosePane: (leaf: LeafNode) => Promise<void>;
}

/**
 * 创建关闭 Tab 与窗格的异步回调替身。
 * @returns 可传给 PaneGrid 并用于断言调用参数的回调集合。
 */
function createCloseCallbacks(): CloseCallbacks {
  return {
    onCloseTab: vi.fn(async () => undefined),
    onClosePane: vi.fn(async () => undefined),
  };
}

/**
 * 读取指定窗格当前的显式名称。
 * @param leafId 目标窗格 ID。
 * @returns 显式名称；未命名时返回 undefined。
 */
function getPaneName(leafId: string): string | undefined {
  return preorderLeaves(useLayoutStore.getState().tree).find(
    (leaf) => leaf.id === leafId,
  )?.name;
}

/**
 * 渲染真实布局 store 驱动的 PaneGrid，并返回拖放所需节点。
 * @param callbacks 关闭 Tab 与窗格的异步回调。
 * @returns 源拖动句柄、源叶子和目标叶子。
 */
function renderPaneGrid(
  callbacks: CloseCallbacks = createCloseCallbacks(),
  closingSessionIds: ReadonlySet<string> = new Set<string>(),
  closingPaneIds: ReadonlySet<string> = new Set<string>(),
): RenderedPaneGrid {
  render(
    <PaneGrid
      onCloseTab={callbacks.onCloseTab}
      onClosePane={callbacks.onClosePane}
      closingSessionIds={closingSessionIds}
      closingPaneIds={closingPaneIds}
    />,
  );
  const leaves = Array.from(document.querySelectorAll<HTMLElement>(".pane-leaf"));
  const handles = screen.getAllByTitle("拖动到其他窗口交换位置");
  if (leaves.length !== 2 || handles.length !== 2) {
    throw new Error("测试布局必须渲染两个叶子窗格");
  }
  return {
    sourceHandle: handles[0],
    sourceLeaf: leaves[0],
    targetLeaf: leaves[1],
  };
}

/**
 * 从左侧句柄开始拖动并悬停到右侧窗格。
 * @param dataTransfer 贯穿拖放生命周期的数据传输对象。
 * @returns 已派发的 dragover 原生事件。
 */
function dragFromSourceToTarget(dataTransfer: DataTransfer): Event {
  const { sourceHandle, targetLeaf } = renderPaneGrid();
  fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
  const dragOverEvent = createDragEvent("dragover", dataTransfer);
  fireEvent(targetLeaf, dragOverEvent);
  return dragOverEvent;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  useLayoutStore.setState({
    tree: createTestTree(),
    activePaneId: "leaf-left",
    savedWorkspaces: [],
    persist: vi.fn(),
    setRatio: originalSetRatio,
    swapPaneContents: originalSwapPaneContents,
  });
  useSessionStore.setState({
    sessions: {
      "pty-left-1": {
        sessionId: "pty-left-1",
        workspaceId: "workspace-panel",
        kind: "shell",
        cwd: "D:\\AI\\panel",
        title: "左侧会话",
        state: "idle",
        createdAt: "2026-07-15T00:00:00.000Z",
      },
      "pty-left-2": {
        sessionId: "pty-left-2",
        workspaceId: null,
        kind: "shell",
        cwd: "D:\\AI\\panel",
        title: "备用会话",
        state: "idle",
        createdAt: "2026-07-15T00:01:00.000Z",
      },
    },
  });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "workspace-panel",
        name: "Panel",
        path: "D:\\AI\\panel",
        agent: "codex",
        useGlobalConfig: true,
        sortOrder: 0,
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    historyCache: {},
  });
  useTaskStore.setState({
    tasks: [],
    loading: false,
    error: null,
    drawerPaneId: null,
  });
});

describe("PaneGrid 窗格名称", () => {
  it("无显式名称时依次回退到活动会话项目名和未命名", () => {
    renderPaneGrid();

    expect(screen.getByText("Panel")).toBeTruthy();
    expect(screen.getByText("未命名")).toBeTruthy();
  });

  it("显式名称优先显示且名称节点位于操作区锁定按钮左侧", () => {
    useLayoutStore.setState({ tree: createTestTree("前端窗格") });
    renderPaneGrid();

    const name = screen.getByText("前端窗格");
    const actions = name.closest(".pane-actions");
    const lockButton = screen.getByTitle("未锁定：点击锁定");
    expect(actions).not.toBeNull();
    expect(actions?.contains(lockButton)).toBe(true);
    expect(
      name.compareDocumentPosition(lockButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("双击名称后按 Enter 保存新名称", () => {
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("Panel"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "server" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(getPaneName("leaf-left")).toBe("server");
    expect(screen.queryByRole("textbox", { name: "窗格名称" })).toBeNull();
  });

  it("名称控件可用 Enter 和 F2 进入编辑", () => {
    renderPaneGrid();

    const nameButton = screen.getByRole("button", { name: "Panel" });
    nameButton.focus();
    fireEvent.keyDown(nameButton, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "窗格名称" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "窗格名称" }), {
      key: "Escape",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Panel" }), {
      key: "F2",
    });
    expect(screen.getByRole("textbox", { name: "窗格名称" })).toBeTruthy();
  });

  it("单击名称仍激活所属窗格但不进入编辑", () => {
    renderPaneGrid();

    fireEvent.click(screen.getByRole("button", { name: "未命名" }));

    expect(useLayoutStore.getState().activePaneId).toBe("leaf-right");
    expect(screen.queryByRole("textbox", { name: "窗格名称" })).toBeNull();
  });

  it("按 Escape 取消名称修改", () => {
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("Panel"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "server" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(getPaneName("leaf-left")).toBeUndefined();
    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("输入框失焦时保存名称", () => {
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("Panel"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "server" } });
    fireEvent.blur(input);

    expect(getPaneName("leaf-left")).toBe("server");
  });

  it("IME 组合输入期间忽略 Enter 和 Escape", () => {
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("Panel"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "服务器" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(screen.getByRole("textbox", { name: "窗格名称" })).toBe(input);
    expect(getPaneName("leaf-left")).toBeUndefined();
  });

  it("展示态与编辑态共用稳定名称容器", () => {
    renderPaneGrid();

    const displaySlot = screen.getByText("Panel").closest(".pane-name-slot");
    expect(displaySlot).not.toBeNull();
    fireEvent.doubleClick(screen.getByText("Panel"));

    expect(
      screen.getByRole("textbox", { name: "窗格名称" }).closest(".pane-name-slot"),
    ).toBe(displaySlot);
  });

  it("空名称调用 store 清除显式名并回退项目名", () => {
    useLayoutStore.setState({ tree: createTestTree("前端窗格") });
    const renamePane = vi.spyOn(useLayoutStore.getState(), "renamePane");
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("前端窗格"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renamePane).toHaveBeenCalledWith("leaf-left", "   ");
    expect(getPaneName("leaf-left")).toBeUndefined();
    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("忽略大小写的重复名称原位报错并保持编辑", () => {
    useLayoutStore.setState({ tree: createTestTree("前端窗格", "Server") });
    renderPaneGrid();

    fireEvent.doubleClick(screen.getByText("前端窗格"));
    const input = screen.getByRole("textbox", { name: "窗格名称" });
    fireEvent.change(input, { target: { value: "server" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("窗格名称已存在");
    expect(screen.getByRole("textbox", { name: "窗格名称" })).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(getPaneName("leaf-left")).toBe("前端窗格");
  });
});

describe("PaneGrid 任务入口", () => {
  it("显示当前 Pane 待处理数量并打开对应任务抽屉", () => {
    useTaskStore.setState({
      tasks: [{
        id: "task-1",
        sourcePaneId: "leaf-right",
        targetPaneId: "leaf-left",
        sourcePaneName: "server",
        targetPaneName: "web",
        title: "同步接口",
        request: "增加 /users 接口",
        status: "queued",
        createdAt: "2026-07-15T00:00:00Z",
        updatedAt: "2026-07-15T00:00:00Z",
      }],
    });
    renderPaneGrid();

    const leftLeaf = document.querySelectorAll<HTMLElement>(".pane-leaf")[0];
    const taskButton = leftLeaf.querySelector<HTMLButtonElement>(".pane-task-button");
    expect(taskButton).not.toBeNull();
    expect(taskButton?.querySelector(".pane-task-badge")?.textContent).toBe("1");
    fireEvent.click(taskButton as HTMLButtonElement);
    expect(useTaskStore.getState().drawerPaneId).toBe("leaf-left");
  });

  it("不统计 Pane ID 相同但属于其他保存工作区的任务", () => {
    useLayoutStore.setState({ activeSavedWorkspaceId: "saved-current" });
    useTaskStore.setState({
      tasks: [{
        id: "task-old",
        savedWorkspaceId: "saved-old",
        sourcePaneId: "leaf-right",
        targetPaneId: "leaf-left",
        sourcePaneName: "server",
        targetPaneName: "web",
        title: "旧工作区任务",
        request: "不应显示",
        status: "queued",
        createdAt: "2026-07-15T00:00:00Z",
        updatedAt: "2026-07-15T00:00:00Z",
      }],
    });

    renderPaneGrid();

    const leftLeaf = document.querySelectorAll<HTMLElement>(".pane-leaf")[0];
    expect(leftLeaf.querySelector(".pane-task-badge")).toBeNull();
  });
});

describe("PaneGrid 关闭委托", () => {
  it("关闭中的 Tab 禁用关闭入口并忽略左键和中键重复关闭", () => {
    const callbacks = createCloseCallbacks();
    renderPaneGrid(callbacks, new Set(["pty-left-1"]));

    const closeIcons = document.querySelectorAll<HTMLElement>(".pane-tab-close");
    const tabs = document.querySelectorAll<HTMLElement>(".pane-tab");
    expect(closeIcons[0].getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(closeIcons[0]);
    fireEvent(tabs[0], new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(callbacks.onCloseTab).not.toHaveBeenCalled();
  });

  it("关闭中的窗格禁用关闭按钮并忽略重复关闭", () => {
    const callbacks = createCloseCallbacks();
    renderPaneGrid(callbacks, new Set(), new Set(["leaf-left"]));

    const closePaneButton = screen.getAllByTitle("关闭此分屏")[0];
    expect((closePaneButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closePaneButton);

    expect(callbacks.onClosePane).not.toHaveBeenCalled();
  });

  it("点击 Tab 关闭图标时只调用关闭回调且不直接修改布局", () => {
    const callbacks = createCloseCallbacks();
    const originalTree = useLayoutStore.getState().tree;
    renderPaneGrid(callbacks);

    const closeIcons = document.querySelectorAll<HTMLElement>(".pane-tab-close");
    fireEvent.click(closeIcons[0]);

    expect(callbacks.onCloseTab).toHaveBeenCalledOnce();
    expect(callbacks.onCloseTab).toHaveBeenCalledWith("leaf-left", "pty-left-1");
    expect(useLayoutStore.getState().tree).toBe(originalTree);
  });

  it("中键点击 Tab 时只调用关闭回调且不直接修改布局", () => {
    const callbacks = createCloseCallbacks();
    const originalTree = useLayoutStore.getState().tree;
    renderPaneGrid(callbacks);

    const tabs = document.querySelectorAll<HTMLElement>(".pane-tab");
    fireEvent(tabs[1], new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(callbacks.onCloseTab).toHaveBeenCalledOnce();
    expect(callbacks.onCloseTab).toHaveBeenCalledWith("leaf-left", "pty-left-2");
    expect(useLayoutStore.getState().tree).toBe(originalTree);
  });

  it("点击关闭窗格时只传递叶子快照且不直接修改布局", () => {
    const callbacks = createCloseCallbacks();
    const originalTree = useLayoutStore.getState().tree;
    const originalLeaf = preorderLeaves(originalTree).find(
      (item) => item.id === "leaf-left",
    );
    if (!originalLeaf) throw new Error("测试布局必须包含左侧窗格");
    renderPaneGrid(callbacks);

    fireEvent.click(screen.getAllByTitle("关闭此分屏")[0]);

    expect(callbacks.onClosePane).toHaveBeenCalledOnce();
    expect(callbacks.onClosePane).toHaveBeenCalledWith(originalLeaf);
    expect(useLayoutStore.getState().tree).toBe(originalTree);
  });
});

describe("PaneGrid 窗格拖放", () => {
  it("WebView 不暴露 types 时仍接管合法窗格拖放并写入兼容数据", () => {
    const dataTransfer = createDataTransfer([]);
    const { sourceHandle, targetLeaf } = renderPaneGrid();

    fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(dataTransfer.setData).toHaveBeenCalledWith(PANE_DRAG_TYPE, "leaf-left");

    const dragOverEvent = createDragEvent("dragover", dataTransfer);
    const preventDefault = vi.spyOn(dragOverEvent, "preventDefault");
    fireEvent(targetLeaf, dragOverEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe("move");
    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(true);
    expect(dataTransfer.setData).toHaveBeenCalledWith(TEXT_DRAG_TYPE, "leaf-left");
  });

  it("没有共享窗格源时不接管外部拖放", () => {
    const dataTransfer = createDataTransfer([PANE_DRAG_TYPE]);
    dataTransfer.setData(PANE_DRAG_TYPE, "external-pane");
    const { targetLeaf } = renderPaneGrid();
    const dragOverEvent = createDragEvent("dragover", dataTransfer);
    const preventDefault = vi.spyOn(dragOverEvent, "preventDefault");

    fireEvent(targetLeaf, dragOverEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(false);
  });

  it("离开当前目标窗格时清除该目标反馈", () => {
    const dataTransfer = createDataTransfer([PANE_DRAG_TYPE]);
    dragFromSourceToTarget(dataTransfer);
    const targetLeaf = document.querySelectorAll<HTMLElement>(".pane-leaf")[1];
    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(true);

    fireEvent(
      targetLeaf,
      createDragEvent("dragleave", dataTransfer, document.body),
    );

    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(false);
  });

  it("源句柄 dragend 取消拖放时跨叶子清除目标反馈", () => {
    const dataTransfer = createDataTransfer([PANE_DRAG_TYPE]);
    const { sourceHandle, targetLeaf } = renderPaneGrid();
    fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
    fireEvent(targetLeaf, createDragEvent("dragover", dataTransfer));
    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(true);

    fireEvent(sourceHandle, createDragEvent("dragend", dataTransfer));

    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(false);
  });

  it("drop 后清除目标反馈和共享拖动源", () => {
    const dataTransfer = createDataTransfer([PANE_DRAG_TYPE]);
    const { sourceHandle, sourceLeaf, targetLeaf } = renderPaneGrid();
    fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
    fireEvent(targetLeaf, createDragEvent("dragover", dataTransfer));

    fireEvent(targetLeaf, createDragEvent("drop", dataTransfer));

    expect(targetLeaf.classList.contains("pane-drop-target")).toBe(false);
    const dragOverAfterDrop = createDragEvent("dragover", dataTransfer);
    const preventDefault = vi.spyOn(dragOverAfterDrop, "preventDefault");
    fireEvent(sourceLeaf, dragOverAfterDrop);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sourceLeaf.classList.contains("pane-drop-target")).toBe(false);
  });

  it("拖回源窗格时不调用内容交换", () => {
    const swapPaneContents = vi.spyOn(
      useLayoutStore.getState(),
      "swapPaneContents",
    );
    const dataTransfer = createDataTransfer([]);
    const { sourceHandle, sourceLeaf } = renderPaneGrid();
    fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
    fireEvent(sourceLeaf, createDragEvent("dragover", dataTransfer));

    fireEvent(sourceLeaf, createDragEvent("drop", dataTransfer));

    expect(swapPaneContents).not.toHaveBeenCalled();
  });

  it("拖到另一窗格时调用 store 交换源和目标内容", () => {
    const swapPaneContents = vi.spyOn(
      useLayoutStore.getState(),
      "swapPaneContents",
    );
    const dataTransfer = createDataTransfer([]);
    const { sourceHandle, targetLeaf } = renderPaneGrid();
    fireEvent(sourceHandle, createDragEvent("dragstart", dataTransfer));
    fireEvent(targetLeaf, createDragEvent("dragover", dataTransfer));

    fireEvent(targetLeaf, createDragEvent("drop", dataTransfer));

    expect(swapPaneContents).toHaveBeenCalledOnce();
    expect(swapPaneContents).toHaveBeenCalledWith("leaf-left", "leaf-right");
  });
});

describe("PaneGrid 分隔比例", () => {
  it("把面板百分比换算为 store 比例并为两侧保留最小尺寸", () => {
    renderPaneGrid();

    fireEvent.click(screen.getByTestId("trigger-layout"));

    const tree = useLayoutStore.getState().tree;
    expect(tree.type).toBe("split");
    if (tree.type !== "split") throw new Error("测试根节点必须是 split");
    expect(tree.ratio).toBe(0.35);
    expect(
      screen.getAllByTestId("panel").map((panel) => panel.dataset.minSize),
    ).toEqual(["10", "10"]);
  });
});

describe("PaneGrid 恢复错误占位", () => {
  it("窗格存在恢复错误时显示占位并可手动清除", () => {
    useLayoutStore.setState({
      restoreErrors: { "leaf-left": "供应商不存在：p-1" },
    });
    renderPaneGrid();

    expect(screen.getByRole("alert").textContent).toContain("供应商不存在：p-1");

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    expect(useLayoutStore.getState().restoreErrors["leaf-left"]).toBeUndefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
