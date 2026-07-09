/**
 * 主题应用 hook。订阅 settingsStore 的 theme，主题变化时：
 * 1) 写 document.documentElement.dataset.theme（驱动 styles/theme.css 的 :root[data-theme=...] CSS 变量）
 * 2) 遍历所有活跃终端，同步 xterm 配色（applyTheme，见实施计划 9.4）
 * 通常在根组件 App 里调用一次。
 */
import { useEffect } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { applyTheme, forEachTerm } from "../terminal/xtermManager";

/** 将当前主题应用到 DOM 与所有活跃 xterm 终端 */
export function useTheme(): void {
  const theme = useSettingsStore((s) => s.config?.theme);
  useEffect(() => {
    if (!theme) return; // 配置未加载完成时不动 DOM
    // 驱动整套 CSS 变量切换
    document.documentElement.dataset.theme = theme;
    // 同步终端配色（xterm 5 支持运行时改 options.theme）
    forEachTerm((term) => applyTheme(term, theme));
  }, [theme]);
}
