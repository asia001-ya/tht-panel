// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";
import { copyClipboardText, resolveClipboardPayload } from "../lib/clipboard";
import { beginPaneHtmlDrag, endPaneHtmlDrag } from "../lib/paneDrag";

const terminalMock = vi.hoisted(() => ({
  textarea: null as HTMLTextAreaElement | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  cols: 80,
  rows: 24,
  open: vi.fn((container: HTMLElement) => {
    const textarea = document.createElement("textarea");
    terminalMock.textarea = textarea;
    container.appendChild(textarea);
  }),
  attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
    terminalMock.keyHandler = handler;
  }),
  focus: vi.fn(),
  paste: vi.fn(),
  getSelection: vi.fn(() => ""),
  clearSelection: vi.fn(),
  selectAll: vi.fn(),
  reset: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("./xtermManager", () => ({
  createTerm: vi.fn(() => ({
    term: terminalMock,
    fit: {
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
      fit: vi.fn(),
    },
    search: {},
  })),
  tryLoadWebgl: vi.fn(),
  unregisterTerm: vi.fn(),
}));

vi.mock("./SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../App", () => ({ pendingSessions: new Set<string>() }));
vi.mock("../store/settingsStore", () => ({
  DEFAULT_WALLPAPER: { enabled: false, terminalOpacity: 1 },
  useSettingsStore: { getState: () => ({ config: null }) },
}));
vi.mock("../api/commands", () => ({
  ptyAttach: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  ptyDetach: vi.fn(),
}));
vi.mock("../lib/clipboard", () => ({
  copyClipboardText: vi.fn(async () => undefined),
  resolveClipboardPayload: vi.fn(async () => ({ kind: "text", text: "pasted value" })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  terminalMock.textarea = null;
  terminalMock.keyHandler = null;
  terminalMock.getSelection.mockReturnValue("");
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function createInternalPaneTransfer(
  types = ["application/x-tht-pane", "text/plain"],
): DataTransfer {
  return {
    types,
    getData: vi.fn((type: string) =>
      type === "application/x-tht-pane" ? "leaf-left" : ""),
    files: [],
    items: [],
  } as unknown as DataTransfer;
}

describe("TerminalPane clipboard", () => {
  it("内部窗格拖动不会被终端文件拖放监听器吞掉", () => {
    const view = render(<TerminalPane sessionId={null} />);
    const host = view.container.querySelector<HTMLElement>(".term-host-inner");
    if (!host) throw new Error("测试终端必须包含输入容器");
    const dataTransfer = createInternalPaneTransfer([]);
    beginPaneHtmlDrag(dataTransfer);

    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
    host.dispatchEvent(dragOver);
    expect(dragOver.defaultPrevented).toBe(false);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    host.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(resolveClipboardPayload).not.toHaveBeenCalled();
    endPaneHtmlDrag(dataTransfer);
  });

  it("Ctrl+C 复制选区，无选区时保留 SIGINT", async () => {
    render(<TerminalPane sessionId={null} />);
    await waitFor(() => expect(terminalMock.keyHandler).not.toBeNull());

    terminalMock.getSelection.mockReturnValue("selected output");
    const copyEvent = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
    expect(terminalMock.keyHandler?.(copyEvent)).toBe(false);
    await waitFor(() => expect(copyClipboardText).toHaveBeenCalledWith("selected output"));

    terminalMock.getSelection.mockReturnValue("");
    const interruptEvent = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    expect(terminalMock.keyHandler?.(interruptEvent)).toBe(true);
  });

  it("Ctrl+V 和原生 paste 事件都通过 xterm paste 写入", async () => {
    render(<TerminalPane sessionId={null} />);
    await waitFor(() => expect(terminalMock.keyHandler).not.toBeNull());

    const shortcut = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, cancelable: true });
    expect(terminalMock.keyHandler?.(shortcut)).toBe(false);
    await waitFor(() => expect(terminalMock.paste).toHaveBeenCalledWith("pasted value"));

    terminalMock.paste.mockClear();
    fireEvent.paste(terminalMock.textarea!, {
      clipboardData: { getData: vi.fn(() => "event value"), items: [], files: [] },
    });
    // 快捷键紧接着产生的 paste 事件会被去重。
    expect(terminalMock.paste).not.toHaveBeenCalled();

    await new Promise((resolve) => window.setTimeout(resolve, 260));
    fireEvent.paste(terminalMock.textarea!, {
      clipboardData: { getData: vi.fn(() => "event value"), items: [], files: [] },
    });
    await waitFor(() => expect(terminalMock.paste).toHaveBeenCalledWith("pasted value"));
  });

  it("右键菜单提供复制、粘贴和全选", async () => {
    const user = userEvent.setup();
    const view = render(<TerminalPane sessionId={null} />);
    terminalMock.getSelection.mockReturnValue("menu selection");

    fireEvent.contextMenu(view.container.querySelector(".term-host-inner")!, {
      clientX: 20,
      clientY: 30,
    });
    await user.click(screen.getByRole("menuitem", { name: "复制" }));
    await waitFor(() => expect(copyClipboardText).toHaveBeenCalledWith("menu selection"));

    fireEvent.contextMenu(view.container.querySelector(".term-host-inner")!);
    await user.click(screen.getByRole("menuitem", { name: "粘贴" }));
    await waitFor(() => expect(resolveClipboardPayload).toHaveBeenCalled());

    fireEvent.contextMenu(view.container.querySelector(".term-host-inner")!);
    await user.click(screen.getByRole("menuitem", { name: "全选" }));
    expect(terminalMock.selectAll).toHaveBeenCalled();
  });
});
