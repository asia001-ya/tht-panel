import { describe, expect, it } from "vitest";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("Tauri 窗口配置", () => {
  it("禁用原生文件拖放以允许 WebView2 接收 HTML5 拖动事件", () => {
    const mainWindow = tauriConfig.app.windows.find(
      (window) => window.label === "main",
    ) as { dragDropEnabled?: boolean } | undefined;

    expect(mainWindow?.dragDropEnabled).toBe(false);
  });
});
