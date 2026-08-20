// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

describe("uiStore 主视图与侧栏切换", () => {
  beforeEach(() => {
    useUiStore.setState({
      mainView: "panes",
      sidebarVisible: true,
      workspaceDialog: { open: false, editing: undefined },
      confirm: null,
    });
  });

  it("再次点击当前工作空间视图时折叠侧栏", () => {
    useUiStore.getState().toggleMainView("panes");

    expect(useUiStore.getState()).toMatchObject({
      mainView: "panes",
      sidebarVisible: false,
    });
  });

  it("再次点击当前工作空间视图时重新展开侧栏", () => {
    useUiStore.setState({ sidebarVisible: false });

    useUiStore.getState().toggleMainView("panes");

    expect(useUiStore.getState().sidebarVisible).toBe(true);
  });

  it("切换到其它模块时自动展开侧栏", () => {
    useUiStore.setState({ sidebarVisible: false });

    useUiStore.getState().toggleMainView("providers");

    expect(useUiStore.getState()).toMatchObject({
      mainView: "providers",
      sidebarVisible: true,
    });
  });
});
