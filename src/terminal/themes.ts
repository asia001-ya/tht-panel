/**
 * xterm 终端浅色/深色两套配色（ITheme）。
 * GitHub Light/Dark 系 ANSI，与 styles/theme.css 同源：
 * darkXterm.background 必须等于 theme.css --term-bg(dark) = #212121，
 * lightXterm.background 必须等于 --term-bg(light) = #ffffff。改一处同步改另一处。
 */
import type { ITheme } from "@xterm/xterm";

export const lightXterm: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1a1a18",
  cursorAccent: "#ffffff",
  selectionBackground: "#d3e3fd",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#bf8700",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#24292f",
};

export const darkXterm: ITheme = {
  background: "#212121",
  foreground: "#ececec",
  cursor: "#ececec",
  cursorAccent: "#212121",
  selectionBackground: "#3a3d41",
  black: "#4a4a4a",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/** 按主题取对应 xterm 配色 */
export function xtermThemeFor(theme: "light" | "dark"): ITheme {
  return theme === "dark" ? darkXterm : lightXterm;
}
