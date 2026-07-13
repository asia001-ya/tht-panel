import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "../api/types";
import {
  resolveConversationProvider,
  resolveNewTerminalSelection,
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

  it("项目默认只接受列表中 ID 唯一且 driver 合法的供应商", () => {
    const duplicateProviders = [providers[0], ...providers, providers[0]];
    const invalidDriverProviders = [
      ...providers,
      {
        id: "invalid-driver",
        name: "Invalid Driver",
        driver: "gemini",
      },
    ] as unknown as ProviderProfile[];

    expect(
      resolveProjectProvider(
        { defaultProviderId: "missing" },
        providers,
      ),
    ).toBeNull();
    expect(
      resolveProjectProvider(
        { defaultProviderId: "claude-a" },
        duplicateProviders,
      ),
    ).toBeNull();
    expect(
      resolveProjectProvider(
        { defaultProviderId: "invalid-driver" },
        invalidDriverProviders,
      ),
    ).toBeNull();
  });

  it("允许供应商连接配置为空", () => {
    const emptyConfigProviders: ProviderProfile[] = [
      {
        id: "empty-config",
        name: "Empty Config",
        driver: "codex",
        baseUrl: "",
        apiKey: "",
        model: "",
        extraArgs: [],
      },
    ];

    expect(
      resolveProjectProvider(
        { defaultProviderId: "empty-config" },
        emptyConfigProviders,
      ),
    ).toBe(emptyConfigProviders[0]);
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

  it("会话覆盖无效时回退有效的项目默认供应商", () => {
    const invalidOverrideProviders = [
      ...providers,
      {
        id: "invalid-driver",
        name: "Invalid Driver",
        driver: "gemini",
      },
    ] as unknown as ProviderProfile[];

    expect(
      resolveConversationProvider(
        { providerId: "invalid-driver" },
        { defaultProviderId: "claude-b" },
        invalidOverrideProviders,
      )?.id,
    ).toBe("claude-b");
  });

  it("新终端无有效默认供应商时使用项目 agent", () => {
    expect(
      resolveNewTerminalSelection(
        { agent: "codex", defaultProviderId: "missing" },
        providers,
      ),
    ).toEqual({
      kind: "codex",
      providerId: undefined,
    });
  });

  it("新终端使用有效的项目默认供应商", () => {
    expect(
      resolveNewTerminalSelection(
        { agent: "codex", defaultProviderId: "claude-a" },
        providers,
      ),
    ).toEqual({
      kind: "claude",
      providerId: "claude-a",
    });
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

  it("恢复 Claude 历史但供应商切换为 Codex 时清除会话 ID", () => {
    expect(
      resolveTerminalResumeSelection(
        {
          providerId: "codex-a",
          kind: "claude",
          aiSessionId: "claude-session-1",
        },
        { defaultProviderId: "claude-a" },
        providers,
      ),
    ).toEqual({
      kind: "codex",
      providerId: "codex-a",
      resumeSessionId: undefined,
    });
  });
});
