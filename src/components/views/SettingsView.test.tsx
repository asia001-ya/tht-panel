// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { SettingsView } from "./SettingsView";
import { ProviderView } from "./ProviderView";

// 设置改动会走 configSet 持久化，测试中桩掉 Tauri IPC。
vi.mock("../../api/commands", () => ({
  configGet: vi.fn(),
  configSet: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

/** 构造一份完整的全局配置。 */
function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
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
    ...overrides,
  };
}

beforeEach(() => {
  useSettingsStore.setState({ config: makeConfig(), loaded: true });
  useUiStore.setState({ mainView: "settings" });
});

describe("SettingsView", () => {
  it("展示当前配置并可修改字号", async () => {
    render(<SettingsView />);

    const fontSize = screen.getByLabelText("字号") as HTMLInputElement;
    expect(fontSize.value).toBe("14");

    // 受控 number 输入逐字符输入会与既有值拼接，直接派发一次完整值的 change。
    fireEvent.change(fontSize, { target: { value: "18" } });

    expect(useSettingsStore.getState().config?.fontSize).toBe(18);
  });

  it("切换主题写入配置", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByLabelText("深色"));

    expect(useSettingsStore.getState().config?.theme).toBe("dark");
  });

  it("配置未加载时显示占位而非崩溃", () => {
    useSettingsStore.setState({ config: null, loaded: false });
    render(<SettingsView />);

    expect(screen.getByText("正在加载配置…")).toBeTruthy();
  });
});

describe("ProviderView", () => {
  it("复用 ProviderManager 展示空态", () => {
    render(<ProviderView />);

    expect(
      screen.getByText("未添加供应商，将使用系统 Claude/Codex 配置"),
    ).toBeTruthy();
  });

  it("新增的供应商写回全局配置", async () => {
    const user = userEvent.setup();
    render(<ProviderView />);

    await user.click(screen.getByLabelText("添加供应商"));
    await user.type(screen.getByLabelText("供应商名称"), "我的中转");
    await user.click(screen.getByLabelText("保存供应商"));

    const providers = useSettingsStore.getState().config?.providers ?? [];
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("我的中转");
  });
});
