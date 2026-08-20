// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../store/sessionStore";
import { ComposerBar } from "./ComposerBar";

const commandMocks = vi.hoisted(() => ({
  ptyWrite: vi.fn(async () => undefined),
}));

vi.mock("../../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/commands")>()),
  ...commandMocks,
}));

function getComposerInputs(): HTMLTextAreaElement[] {
  return screen.getAllByPlaceholderText(
    "输入内容发送到当前终端…",
  ) as HTMLTextAreaElement[];
}

describe("ComposerBar", () => {
  beforeEach(() => {
    localStorage.clear();
    commandMocks.ptyWrite.mockClear();
    useSessionStore.setState({
      sessions: {
        "pty-left": {
          sessionId: "pty-left",
          workspaceId: "workspace-1",
          kind: "claude",
          cwd: "D:\\workspace\\left",
          title: "左侧会话",
          state: "idle",
          createdAt: "2026-08-21T00:00:00.000Z",
        },
        "pty-right": {
          sessionId: "pty-right",
          workspaceId: "workspace-1",
          kind: "codex",
          cwd: "D:\\workspace\\right",
          title: "右侧会话",
          state: "idle",
          createdAt: "2026-08-21T00:01:00.000Z",
        },
      },
    });
  });

  afterEach(cleanup);

  it("为每个窗格保留独立草稿并发送到各自会话", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ComposerBar leafId="leaf-left" sessionId="pty-left" />
        <ComposerBar leafId="leaf-right" sessionId="pty-right" />
      </>,
    );

    const [leftInput, rightInput] = getComposerInputs();
    await user.type(leftInput, "左侧草稿");
    await user.type(rightInput, "右侧草稿");

    expect(leftInput.value).toBe("左侧草稿");
    expect(rightInput.value).toBe("右侧草稿");

    fireEvent.keyDown(leftInput, { key: "Enter" });
    expect(commandMocks.ptyWrite).toHaveBeenCalledWith(
      "pty-left",
      "\x1b[200~左侧草稿\x1b[201~\r",
    );
    await waitFor(() => expect(leftInput.value).toBe(""));
    expect(rightInput.value).toBe("右侧草稿");

    fireEvent.keyDown(rightInput, { key: "Enter" });
    expect(commandMocks.ptyWrite).toHaveBeenLastCalledWith(
      "pty-right",
      "\x1b[200~右侧草稿\x1b[201~\r",
    );
  });

  it("按窗格分别保存折叠状态", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ComposerBar leafId="leaf-left" sessionId="pty-left" />
        <ComposerBar leafId="leaf-right" sessionId="pty-right" />
      </>,
    );

    const collapseButtons = screen.getAllByTitle("折叠");
    await user.click(collapseButtons[0]);

    expect(localStorage.getItem("tht-composer-collapsed:leaf-left")).toBe("1");
    expect(localStorage.getItem("tht-composer-collapsed:leaf-right")).toBe("0");
    expect(screen.getAllByPlaceholderText("输入内容发送到当前终端…")).toHaveLength(1);
    expect(screen.getByTitle("展开输入框")).toBeTruthy();
  });
});
