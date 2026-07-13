// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig, ProviderProfile, Workspace } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import SettingsDialog from "./SettingsDialog";
import WorkspaceDialog from "./WorkspaceDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const provider: ProviderProfile = {
  id: "claude-a",
  name: "Claude A",
  driver: "claude",
  baseUrl: "https://claude.example.com",
};

const workspace: Workspace = {
  id: "workspace-1",
  name: "Panel",
  path: "D:\\AI\\panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-13T08:00:00.000Z",
};

/**
 * 构造设置对话框测试所需的完整配置。
 * @param providers 要写入配置的供应商列表。
 * @returns 可直接放入 settings store 的全局配置。
 */
function createConfig(providers: ProviderProfile[]): GlobalConfig {
  return {
    theme: "dark",
    shellPath: "powershell.exe",
    fontSize: 14,
    scrollbackBytes: 5 * 1024 * 1024,
    scrollbackLines: 10000,
    notifyOnWaiting: true,
    claudeDefaults: {},
    codexDefaults: {},
    providers,
  };
}

afterEach(cleanup);

beforeEach(() => {
  useSettingsStore.setState({ config: createConfig([provider]), loaded: true });
  useUiStore.setState({
    settingsOpen: false,
    settingsSection: "general",
    workspaceDialog: { open: false, editing: undefined },
  } as Partial<ReturnType<typeof useUiStore.getState>>);
  useWorkspaceStore.setState({
    workspaces: [workspace],
    save: vi.fn(async () => undefined),
  });
});

describe("SettingsDialog", () => {
  it("默认显示常规页，并可切换到供应商管理", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openSettings();
    render(<SettingsDialog />);

    expect(screen.getByLabelText("Shell 路径")).toBeTruthy();
    expect(screen.queryByText("Claude A")).toBeNull();

    await user.click(screen.getByRole("button", { name: "供应商管理" }));

    expect(screen.getByText("Claude A")).toBeTruthy();
    expect(screen.queryByLabelText("Shell 路径")).toBeNull();
  });

  it("可直达空供应商页并说明使用系统配置", () => {
    useSettingsStore.setState({ config: createConfig([]), loaded: true });
    const openProviders = useUiStore.getState().openSettings as (
      section?: "general" | "providers",
    ) => void;
    openProviders("providers");
    render(<SettingsDialog />);

    expect(screen.getByText("未添加供应商，将使用系统 Claude/Codex 配置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加供应商" })).toBeTruthy();
  });

  it("项目空供应商快捷入口直接打开供应商管理", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ config: createConfig([]), loaded: true });
    useUiStore.setState({ workspaceDialog: { open: true, editing: undefined } });
    render(<WorkspaceDialog />);

    await user.click(screen.getByRole("button", { name: "前往设置添加供应商" }));

    expect(useUiStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsSection: "providers",
      workspaceDialog: { open: false, editing: undefined },
    });
  });
});
