// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalConfig,
  ManagedSession,
  ProviderProfile,
  Workspace,
} from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { SessionHistoryList } from "./SessionHistoryList";

const commandMocks = vi.hoisted(() => ({
  managedSessionDelete: vi.fn(async () => undefined),
  managedSessionUpdate: vi.fn(async () => undefined),
  ptyKill: vi.fn(async () => undefined),
}));

vi.mock("../../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/commands")>()),
  ...commandMocks,
}));

const providers: ProviderProfile[] = [
  { id: "claude-a", name: "Claude A", driver: "claude" },
  { id: "claude-b", name: "Claude B", driver: "claude" },
  { id: "codex-a", name: "Codex A", driver: "codex" },
];

const workspace: Workspace = {
  id: "project-1",
  name: "Panel",
  path: "D:\\AI\\panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-12T12:00:00.000Z",
  defaultProviderId: "claude-a",
};

const session: ManagedSession = {
  id: "conversation-1",
  workspaceId: workspace.id,
  name: "旧会话",
  kind: "claude",
  ptySessionId: "pty-old",
  aiSessionId: "ai-old",
  createdAt: "2026-07-12T12:00:00.000Z",
  updatedAt: "2026-07-12T12:00:00.000Z",
};

const config: GlobalConfig = {
  theme: "light",
  shellPath: "pwsh.exe",
  fontSize: 13,
  scrollbackBytes: 5 * 1024 * 1024,
  scrollbackLines: 10000,
  notifyOnWaiting: true,
  claudeDefaults: {},
  codexDefaults: {},
  providers,
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ config, loaded: true });
  useSessionStore.setState({
    sessions: {
      "pty-old": {
        sessionId: "pty-old",
        workspaceId: workspace.id,
        kind: "claude",
        cwd: workspace.path,
        title: "Claude",
        state: "running",
        createdAt: session.createdAt,
      },
    },
  });
});

function renderHistory(
  currentSession: ManagedSession,
  currentWorkspace: Workspace = workspace,
) {
  const loadHistory = vi.fn(async () => undefined);
  const onResume = vi.fn();
  useWorkspaceStore.setState({
    workspaces: [currentWorkspace],
    historyCache: { [currentWorkspace.id]: [currentSession] },
    historyLoading: { [currentWorkspace.id]: false },
    loadHistory,
  });
  render(
    <SessionHistoryList ws={currentWorkspace} onResume={onResume} />,
  );
  fireEvent.contextMenu(screen.getByTitle(currentSession.name), {
    clientX: 10,
    clientY: 10,
  });
  return { loadHistory, onResume };
}

describe("SessionHistoryList 供应商切换", () => {
  it("选择当前有效供应商时只保存选择，不重启 PTY", async () => {
    const user = userEvent.setup();
    const { onResume } = renderHistory(session);

    await user.click(screen.getByRole("button", { name: "切换到 Claude A" }));

    await waitFor(() =>
      expect(commandMocks.managedSessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "claude-a",
          ptySessionId: "pty-old",
          aiSessionId: "ai-old",
          kind: "claude",
        }),
      ),
    );
    expect(commandMocks.ptyKill).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("切换到不同驱动时保留旧 PTY ID，并清空不可复用的 AI 会话 ID", async () => {
    const user = userEvent.setup();
    const { onResume } = renderHistory({ ...session, providerId: "claude-a" });

    await user.click(screen.getByRole("button", { name: "切换到 Codex A" }));

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(commandMocks.ptyKill).toHaveBeenCalledWith("pty-old");
    expect(useSessionStore.getState().sessions["pty-old"]).toBeUndefined();
    expect(onResume).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        providerId: "codex-a",
        ptySessionId: "pty-old",
        aiSessionId: undefined,
        kind: "codex",
      }),
    );
  });

  it("切换同驱动供应商时保留 AI 会话 ID", async () => {
    const user = userEvent.setup();
    const { onResume } = renderHistory({ ...session, providerId: "claude-a" });

    await user.click(screen.getByRole("button", { name: "切换到 Claude B" }));

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        providerId: "claude-b",
        ptySessionId: "pty-old",
        aiSessionId: "ai-old",
        kind: "claude",
      }),
    );
  });

  it("跟随项目默认时使用默认供应商的驱动", async () => {
    const user = userEvent.setup();
    const codexWorkspace = { ...workspace, defaultProviderId: "codex-a" };
    const { onResume } = renderHistory(
      { ...session, providerId: "claude-a" },
      codexWorkspace,
    );

    await user.click(screen.getByRole("button", { name: "跟随项目默认" }));

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume).toHaveBeenCalledWith(
      codexWorkspace.id,
      expect.objectContaining({
        providerId: undefined,
        ptySessionId: "pty-old",
        aiSessionId: undefined,
        kind: "codex",
      }),
    );
  });
});
