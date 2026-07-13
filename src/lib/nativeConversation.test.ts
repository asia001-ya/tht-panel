import { describe, expect, it } from "vitest";
import {
  buildConversationPrompt,
  nativeConversationTabId,
  parseNativeConversationTabId,
} from "./nativeConversation";

describe("原生会话", () => {
  it("使用稳定会话 ID 生成和解析工作区 Tab ID", () => {
    const tabId = nativeConversationTabId("conversation-1");
    expect(tabId).toBe("native:conversation-1");
    expect(parseNativeConversationTabId(tabId)).toBe("conversation-1");
    expect(parseNativeConversationTabId("pty-1")).toBeNull();
  });

  it("把应用内消息整理为可跨供应商继续的对话提示", () => {
    const prompt = buildConversationPrompt([
      {
        id: "m1",
        role: "user",
        content: "检查登录流程",
        createdAt: "2026-07-12T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "请提供代码位置",
        createdAt: "2026-07-12T12:00:01.000Z",
      },
      {
        id: "m3",
        role: "user",
        content: "src/auth",
        createdAt: "2026-07-12T12:00:02.000Z",
      },
    ]);

    expect(prompt).toContain("用户：检查登录流程");
    expect(prompt).toContain("助手：请提供代码位置");
    expect(prompt).toContain("用户：src/auth");
  });
});
