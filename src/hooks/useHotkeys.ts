/**
 * 全局快捷键 hook。在 window 的 capture 阶段注册 keydown，抢在 xterm 之前处理，
 * 命中的组合调用 preventDefault 防止被终端 textarea 吞掉或触发浏览器默认行为（如缩放）。
 *
 * 支持的快捷键：
 * - Ctrl+1..9        切换工作空间（按 workspaceStore.workspaces 的 sortOrder 排序取第 N 个）
 * - Ctrl+Shift+F     打开搜索浮条
 * - Ctrl+= / Ctrl++  放大字号
 * - Ctrl+- / Ctrl+_  缩小字号
 *
 * 跨组件通知统一用 window CustomEvent，本 hook 派发以下事件：
 * - "app:activate-workspace"  detail: number —— 目标工作空间在 sortOrder 升序列表中的 0 基索引，
 *                             由 App 监听并据同样的排序解析出工作空间后激活。
 * - "app:open-search"         无 detail —— TerminalPane 监听后在活动分屏打开搜索浮条。
 * - "app:refit"               无 detail —— 字号变化后 TerminalPane 监听，执行 FitAddon.fit() +
 *                             ptyResize 重排（注册表只存 Terminal，fit 需在持有 FitAddon 的分屏内做）。
 */
import { useEffect } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { forEachTerm, setFontSize } from "../terminal/xtermManager";

/** 字号可调范围（px），越界钳制 */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 40;

/**
 * 调整全局字号：更新 settingsStore（持久化）+ 同步所有活跃终端 + 派发 app:refit 触发重排。
 * @param delta 字号增量（放大 +1 / 缩小 -1）
 */
function adjustFontSize(delta: number): void {
  const settings = useSettingsStore.getState();
  const current = settings.config?.fontSize;
  if (current === undefined) return; // 配置未加载完成
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + delta));
  if (next === current) return;
  settings.setFontSize(next);
  forEachTerm((term) => setFontSize(term, next));
  // 字号改变后容器尺寸未变、ResizeObserver 不会触发，需主动通知各分屏 fit + resize
  window.dispatchEvent(new CustomEvent("app:refit"));
}

/**
 * 注册全局快捷键，组件卸载时自动移除监听。
 * 通常在根组件 App 里调用一次。
 */
export function useHotkeys(): void {
  useEffect(() => {
    /**
     * keydown 处理器（capture 阶段）。
     * @param e 键盘事件
     */
    function onKeyDown(e: KeyboardEvent): void {
      const ctrl = e.ctrlKey;
      if (!ctrl) return;

      // Ctrl+Shift+F：打开搜索（放在数字判断前，避免与其它组合冲突）
      if (e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("app:open-search"));
        return;
      }

      // Ctrl+1..9：切换工作空间（不含 Shift/Alt）
      if (!e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        // 按 sortOrder 升序排列，取第 index 个；不存在则忽略（不 preventDefault）
        const ordered = [...useWorkspaceStore.getState().workspaces].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        );
        if (index < ordered.length) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent<number>("app:activate-workspace", { detail: index }));
        }
        return;
      }

      // Ctrl+= / Ctrl++（含小键盘 +）：放大字号
      if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") {
        e.preventDefault();
        adjustFontSize(1);
        return;
      }

      // Ctrl+- / Ctrl+_（含小键盘 -）：缩小字号
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") {
        e.preventDefault();
        adjustFontSize(-1);
        return;
      }
    }

    // capture=true：抢在冒泡与 xterm 的 textarea 之前处理
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
