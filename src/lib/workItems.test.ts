import { describe, expect, it } from "vitest";
import type { ManagedSession, PtySessionInfo } from "../api/types";
import {
  workspaceActivationTarget,
  workspaceIdForTab,
} from "./workItems";

const nativeConversation: ManagedSession = {
  id: "conversation-1",
  workspaceId: "project-native",
  name: "原生会话",
  kind: "claude",
  mode: "native",
  createdAt: "2026-07-12T12:00:00.000Z",
  updatedAt: "2026-07-12T12:00:00.000Z",
};

const terminalSession: PtySessionInfo = {
  sessionId: "pty-1",
  workspaceId: "project-terminal",
  kind: "shell",
  cwd: "D:\\AI\\terminal",
  title: "PowerShell",
  state: "running",
  createdAt: "2026-07-12T12:00:00.000Z",
};

describe("工作项项目归属", () => {
  it("从原生会话 Tab 找到项目", () => {
    expect(
      workspaceIdForTab(
        "native:conversation-1",
        {},
        { "project-native": [nativeConversation] },
      ),
    ).toBe("project-native");
  });

  it("从终端 Tab 找到项目", () => {
    expect(
      workspaceIdForTab(
        "pty-1",
        { "pty-1": terminalSession },
        {},
      ),
    ).toBe("project-terminal");
  });
});

describe("项目打开目标", () => {
  it("最近记录是已停止终端时仍选择恢复该记录", () => {
    const stoppedTerminal: ManagedSession = {
      id: "conversation-terminal",
      workspaceId: "project-terminal",
      name: "已停止终端",
      kind: "claude",
      mode: "terminal",
      ptySessionId: "dead-pty",
      createdAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T13:00:00.000Z",
    };

    expect(workspaceActivationTarget([stoppedTerminal], null)).toEqual({
      kind: "managed",
      session: stoppedTerminal,
    });
  });
});
