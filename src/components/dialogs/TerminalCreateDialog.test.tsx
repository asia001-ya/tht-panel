// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile, Workspace } from "../../api/types";
import {
  TerminalCreateDialog,
} from "./TerminalCreateDialog";

const workspaces: Workspace[] = [
  {
    id: "workspace-1",
    name: "项目一",
    path: "D:\\project-one",
    agent: "claude",
    useGlobalConfig: true,
    sortOrder: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    defaultProviderId: "claude-provider",
  },
];

const providers: ProviderProfile[] = [
  { id: "claude-provider", name: "Claude 渠道", driver: "claude" },
  { id: "codex-provider", name: "Codex 渠道", driver: "codex" },
];

describe("TerminalCreateDialog", () => {
  it("按 AI 类型过滤渠道商并提交 YOLO 选择", async () => {
    const onCreate = vi.fn();
    render(
      <TerminalCreateDialog
        open
        workspaces={workspaces}
        providers={providers}
        initialWorkspaceId="workspace-1"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    expect((screen.getByLabelText("渠道商") as HTMLSelectElement).value)
      .toBe("claude-provider");
    fireEvent.click(screen.getByLabelText("Codex"));
    await waitFor(() => expect((screen.getByLabelText("渠道商") as HTMLSelectElement).value)
      .toBe("codex-provider"));
    fireEvent.click(screen.getByLabelText("YOLO 模式"));
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      kind: "codex",
      providerId: "codex-provider",
      executionMode: "yolo",
    }));
  });
});
