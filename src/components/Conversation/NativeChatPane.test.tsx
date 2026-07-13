// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedSession,
  NativePromptRequest,
  ProviderProfile,
  Workspace,
} from "../../api/types";
import { NativeChatPane } from "./NativeChatPane";

afterEach(cleanup);

const providers: ProviderProfile[] = [
  { id: "claude-a", name: "Claude A", driver: "claude" },
  { id: "codex-a", name: "Codex A", driver: "codex" },
];

const project: Workspace = {
  id: "project-1",
  name: "Panel",
  path: "D:\\AI\\panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-12T12:00:00.000Z",
  defaultProviderId: "claude-a",
};

const conversation: ManagedSession = {
  id: "conversation-1",
  workspaceId: project.id,
  name: "新会话",
  kind: "claude",
  mode: "native",
  messages: [],
  createdAt: "2026-07-12T12:00:00.000Z",
  updatedAt: "2026-07-12T12:00:00.000Z",
};

describe("NativeChatPane", () => {
  it("从编辑框直接发送消息并显示 CLI 返回内容", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    const runPrompt = vi.fn(
      async (_request: NativePromptRequest) => "已检查登录流程",
    );
    render(
      <NativeChatPane
        conversation={conversation}
        project={project}
        providers={providers}
        onUpdate={onUpdate}
        runPrompt={runPrompt}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "检查登录流程");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(1));
    expect(runPrompt.mock.calls[0][0].providerId).toBe("claude-a");
    expect(runPrompt.mock.calls[0][0].prompt).toContain("检查登录流程");
    expect(await screen.findByText("已检查登录流程")).toBeTruthy();
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "检查登录流程" }),
          expect.objectContaining({ role: "assistant", content: "已检查登录流程" }),
        ]),
      }),
    );
  });

  it("允许会话从项目默认供应商切换到另一驱动", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    render(
      <NativeChatPane
        conversation={conversation}
        project={project}
        providers={providers}
        onUpdate={onUpdate}
        runPrompt={async () => ""}
      />,
    );

    await user.selectOptions(screen.getByLabelText("供应商"), "codex-a");
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex-a", kind: "codex" }),
    );
  });

  it("请求进行中禁止切换供应商", async () => {
    const user = userEvent.setup();
    let resolvePrompt: (value: string) => void = () => undefined;
    const runPrompt = vi.fn(
      async (_request: NativePromptRequest) =>
        new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    render(
      <NativeChatPane
        conversation={conversation}
        project={project}
        providers={providers}
        onUpdate={async () => undefined}
        runPrompt={runPrompt}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(1));

    expect((screen.getByLabelText("供应商") as HTMLSelectElement).disabled).toBe(true);
    resolvePrompt("完成");
    expect(await screen.findByText("完成")).toBeTruthy();
  });

  it("切换 Tab 时清空旧草稿和生成状态，迟到回复不串到新会话", async () => {
    const user = userEvent.setup();
    let resolvePrompt: (value: string) => void = () => undefined;
    const runPrompt = vi.fn(
      async (_request: NativePromptRequest) =>
        new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const onUpdate = vi.fn(async () => undefined);
    const { rerender } = render(
      <NativeChatPane
        conversation={conversation}
        project={project}
        providers={providers}
        onUpdate={onUpdate}
        runPrompt={runPrompt}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "A 的消息");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(1));

    const conversationB = {
      ...conversation,
      id: "conversation-2",
      name: "B 会话",
      providerId: "codex-a",
    };
    rerender(
      <NativeChatPane
        conversation={conversationB}
        project={project}
        providers={providers}
        onUpdate={onUpdate}
        runPrompt={runPrompt}
      />,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("消息") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toBe("");
    resolvePrompt("A 的迟到回复");
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: conversation.id,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: "A 的迟到回复",
            }),
          ]),
        }),
      ),
    );
    expect(screen.queryByText("A 的迟到回复")).toBeNull();
  });

  it("首次消息保存失败时解除发送锁并显示错误", async () => {
    const user = userEvent.setup();
    render(
      <NativeChatPane
        conversation={conversation}
        project={project}
        providers={providers}
        onUpdate={async () => {
          throw new Error("保存失败");
        }}
        runPrompt={async () => "不会执行"}
      />,
    );

    await user.type(screen.getByLabelText("消息"), "测试失败");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("保存失败")).toBeTruthy();
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).disabled).toBe(false);
  });
});
