// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import WorkspaceDialog from "./WorkspaceDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../api/commands", () => ({
  configGet: vi.fn(),
  configSet: vi.fn().mockResolvedValue(undefined),
  workspaceList: vi.fn().mockResolvedValue([]),
  workspaceSave: vi.fn().mockResolvedValue(undefined),
  workspaceDelete: vi.fn().mockResolvedValue(undefined),
  managedSessionList: vi.fn().mockResolvedValue([]),
  historyList: vi.fn().mockResolvedValue([]),
}));

afterEach(cleanup);

/** 构造一份不含供应商的全局配置。 */
function emptyProviderConfig(): GlobalConfig {
  return {
    theme: "light",
    shellPath: "powershell.exe",
    fontSize: 14,
    scrollbackBytes: 5 * 1024 * 1024,
    scrollbackLines: 10000,
    notifyOnWaiting: true,
    claudeDefaults: {},
    codexDefaults: {},
    providers: [],
  };
}

beforeEach(() => {
  useSettingsStore.setState({ config: emptyProviderConfig(), loaded: true });
  useUiStore.setState({
    mainView: "panes",
    workspaceDialog: { open: true, editing: undefined },
  });
});

describe("WorkspaceDialog 的供应商快捷入口", () => {
  it("项目供应商为空时，点击快捷入口关闭弹框并切到供应商页", async () => {
    const user = userEvent.setup();
    render(<WorkspaceDialog />);

    await user.click(screen.getByText("前往供应商页添加"));

    const ui = useUiStore.getState();
    expect(ui.mainView).toBe("providers");
    expect(ui.workspaceDialog.open).toBe(false);
  });

  it("已有供应商时不显示该快捷入口", () => {
    useSettingsStore.setState({
      config: {
        ...emptyProviderConfig(),
        providers: [{ id: "p1", name: "中转", driver: "claude" }],
      },
      loaded: true,
    });
    render(<WorkspaceDialog />);

    expect(screen.queryByText("前往供应商页添加")).toBeNull();
  });
});
