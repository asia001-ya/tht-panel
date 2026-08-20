/**
 * xterm 终端浅色/深色两套配色（ITheme）。
 * 16 色 ANSI 使用 Windows Terminal 默认 Campbell 调色板，背景与 styles/theme.css 同源：
 * darkXterm.background 必须等于 theme.css --term-bg(dark) = #212121，
 * lightXterm.background 必须等于 --term-bg(light) = #ffffff。改一处同步改另一处。
 */
import type { ITheme } from "@xterm/xterm";

const CAMPBELL_ANSI: ITheme = {
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

export const lightXterm: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1a1a18",
  cursorAccent: "#ffffff",
  selectionBackground: "#d3e3fd",
  ...CAMPBELL_ANSI,
};

export const darkXterm: ITheme = {
  background: "#212121",
  foreground: "#ececec",
  cursor: "#ececec",
  cursorAccent: "#212121",
  selectionBackground: "#3a3d41",
  ...CAMPBELL_ANSI,
};

/** 按主题取对应 xterm 配色 */
export function xtermThemeFor(
  theme: "light" | "dark",
  terminalOpacity = 1,
): ITheme {
  const base = theme === "dark" ? darkXterm : lightXterm;
  if (terminalOpacity >= 0.999) return base;
  // 透明度由终端宿主的单一背景层承载，避免 xterm 多层 canvas/DOM 重复叠色。
  return { ...base, background: "rgba(0, 0, 0, 0)" };
}
