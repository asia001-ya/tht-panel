/**
 * xterm 终端的浅色/深色两套配色（ITheme）。
 * 采用 Catppuccin 配色，与 styles/theme.css 同源：
 * darkXterm.background 必须等于 theme.css 的 --term-bg(dark)，
 * lightXterm.background 必须等于 --term-bg(light)。改一处同步改另一处。
 */
import type { ITheme } from "@xterm/xterm";

// Catppuccin Mocha（深色）
export const darkXterm: ITheme = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b70",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

// Catppuccin Latte（浅色）——暗色 ANSI 已提高对比度，保证浅底可读
export const lightXterm: ITheme = {
  background: "#eff1f5",
  foreground: "#4c4f69",
  cursor: "#dc8a78",
  cursorAccent: "#eff1f5",
  selectionBackground: "#acb0be",
  black: "#5c5f77",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  magenta: "#ea76cb",
  cyan: "#179299",
  white: "#acb0be",
  brightBlack: "#6c6f85",
  brightRed: "#d20f39",
  brightGreen: "#40a02b",
  brightYellow: "#df8e1d",
  brightBlue: "#1e66f5",
  brightMagenta: "#ea76cb",
  brightCyan: "#179299",
  brightWhite: "#4c4f69",
};

/** 按主题取对应 xterm 配色 */
export function xtermThemeFor(theme: "light" | "dark"): ITheme {
  return theme === "dark" ? darkXterm : lightXterm;
}
