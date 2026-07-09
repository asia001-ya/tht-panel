/**
 * xterm 终端的创建、addon 装配、主题热切换与字号调整工具。
 * 维护一个模块级注册表（Set<Terminal>），供全局主题/字号切换时遍历所有活跃终端。
 * 参考实施计划 9.2（xterm 生命周期）/ 9.4（主题）与风险 4（中文）/ 5（WebGL 上限）。
 *
 * 注意：本模块只负责“创建 + 注册”，不负责销毁。TerminalPane 卸载时应自行
 * 调用 term.dispose() 前先 unregisterTerm(term) 把它移出注册表。
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { xtermThemeFor } from "./themes";

/** 全局活跃终端注册表：createTerm 加入、unregisterTerm 移除，供全局主题/字号切换遍历 */
const g_termRegistry = new Set<Terminal>();

/** createTerm 的返回：终端实例 + 常用 addon 句柄（fit 用于自适应尺寸，search 用于搜索浮条） */
export interface CreateTermResult {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

/**
 * 创建一个已装配好 addon 的 xterm 终端。
 * @param opts.fontSize 初始字号（px）
 * @param opts.scrollbackLines xterm 前端回滚行数
 * @param opts.theme 初始主题 light|dark（取 ./themes 的 xtermThemeFor 配色）
 * @returns { term, fit, search } 终端实例与 FitAddon/SearchAddon 句柄
 */
export function createTerm(opts: {
  fontSize: number;
  scrollbackLines: number;
  theme: "light" | "dark";
}): CreateTermResult {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, "Microsoft YaHei Mono", monospace',
    fontSize: opts.fontSize,
    scrollback: opts.scrollbackLines,
    theme: xtermThemeFor(opts.theme),
    cursorBlink: false,
    cursorStyle: "bar",
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(unicode11);
  // 启用 Unicode 11 宽度表，修正中文 / emoji 在 TUI 中的错位（风险 4）
  term.unicode.activeVersion = "11";

  registerTerm(term);
  return { term, fit, search };
}

/**
 * 尝试为终端加载 WebGL 渲染器以提升性能。
 * 全程 try/catch：WebGL2 不可用时静默失败，回退 xterm 默认 DOM/canvas 渲染；
 * 运行时 GPU 上下文丢失（onContextLoss，风险 5）时 dispose 该 addon 降级，避免白屏。
 * @param term 目标终端
 */
export function tryLoadWebgl(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    // 上下文丢失（如 GPU 重置 / context 数超上限）时销毁 addon，自动降级 DOM 渲染
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch {
    // 静默：保持默认渲染，不影响功能
  }
}

/**
 * 运行时热切换终端配色（xterm 5 支持直接改 options.theme）。
 * @param term 目标终端
 * @param theme 目标主题 light|dark
 */
export function applyTheme(term: Terminal, theme: "light" | "dark"): void {
  term.options.theme = xtermThemeFor(theme);
}

/**
 * 运行时调整终端字号。调用方通常在其后触发 FitAddon.fit() 重排（见 useHotkeys）。
 * @param term 目标终端
 * @param n 新字号（px）
 */
export function setFontSize(term: Terminal, n: number): void {
  term.options.fontSize = n;
}

/**
 * 将终端加入全局注册表。createTerm 内部已调用，一般无需手动调用。
 * @param term 目标终端
 */
export function registerTerm(term: Terminal): void {
  g_termRegistry.add(term);
}

/**
 * 将终端移出全局注册表。TerminalPane 在 term.dispose() 前调用，防止对已销毁终端操作。
 * @param term 目标终端
 */
export function unregisterTerm(term: Terminal): void {
  g_termRegistry.delete(term);
}

/**
 * 遍历所有已注册的活跃终端，用于全局主题 / 字号切换。
 * @param cb 对每个终端执行的回调
 */
export function forEachTerm(cb: (term: Terminal) => void): void {
  g_termRegistry.forEach(cb);
}
