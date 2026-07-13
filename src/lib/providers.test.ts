import { describe, expect, it } from "vitest";
import {
  resolveConversationProvider,
  resolveProjectProvider,
  resolveTerminalResumeSelection,
} from "./providers";

const providers = [
  {
    id: "claude-a",
    name: "Claude A",
    driver: "claude" as const,
    baseUrl: "https://a.example.com",
  },
  {
    id: "claude-b",
    name: "Claude B",
    driver: "claude" as const,
    baseUrl: "https://b.example.com",
  },
  {
    id: "codex-a",
    name: "Codex A",
    driver: "codex" as const,
    baseUrl: "https://codex.example.com",
  },
];

describe("供应商选择", () => {
  it("按项目默认供应商 ID 区分同一模型的多套配置", () => {
    const provider = resolveProjectProvider(
      { defaultProviderId: "claude-b" },
      providers,
    );

    expect(provider?.id).toBe("claude-b");
    expect(provider?.baseUrl).toBe("https://b.example.com");
  });

  it("会话覆盖项目默认供应商并允许跨驱动切换", () => {
    const provider = resolveConversationProvider(
      { providerId: "codex-a" },
      { defaultProviderId: "claude-a" },
      providers,
    );

    expect(provider?.id).toBe("codex-a");
    expect(provider?.driver).toBe("codex");
  });

  it("会话未覆盖或引用失效时回退项目默认供应商", () => {
    expect(
      resolveConversationProvider(
        {},
        { defaultProviderId: "claude-a" },
        providers,
      )?.id,
    ).toBe("claude-a");

    expect(
      resolveConversationProvider(
        { providerId: "missing" },
        { defaultProviderId: "claude-b" },
        providers,
      )?.id,
    ).toBe("claude-b");
  });

  it("恢复终端时把失效覆盖替换为有效的项目默认供应商 ID", () => {
    expect(
      resolveTerminalResumeSelection(
        {
          providerId: "missing",
          kind: "claude",
          aiSessionId: "ai-session-1",
        },
        { defaultProviderId: "claude-b" },
        providers,
      ),
    ).toEqual({
      kind: "claude",
      providerId: "claude-b",
      resumeSessionId: "ai-session-1",
    });
  });
});
