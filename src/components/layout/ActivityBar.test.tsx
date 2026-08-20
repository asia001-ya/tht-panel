// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../store/uiStore";
import { ActivityBar } from "./ActivityBar";

describe("ActivityBar", () => {
  beforeEach(() => {
    useUiStore.setState({ mainView: "panes", sidebarVisible: true });
  });

  afterEach(cleanup);

  it("再次点击当前模块时折叠和展开侧栏", async () => {
    const user = userEvent.setup();
    render(<ActivityBar />);

    await user.click(screen.getByRole("button", { name: "工作空间" }));
    expect(useUiStore.getState().sidebarVisible).toBe(false);

    await user.click(screen.getByRole("button", { name: "工作空间" }));
    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("切换模块时显示侧栏", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ mainView: "panes", sidebarVisible: false });
    render(<ActivityBar />);

    await user.click(screen.getByRole("button", { name: "供应商" }));
    expect(useUiStore.getState()).toMatchObject({
      mainView: "providers",
      sidebarVisible: true,
    });
  });
});
