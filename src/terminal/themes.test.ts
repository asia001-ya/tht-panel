import { expect, test } from "vitest";

import { darkXterm, lightXterm } from "./themes";

const CAMPBELL_ANSI = {
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

/** 验证浅色和深色终端都使用 Windows Terminal 的 Campbell ANSI 调色板。 */
test("终端主题使用 Campbell 16 色 ANSI 调色板", () => {
  expect(lightXterm).toMatchObject(CAMPBELL_ANSI);
  expect(darkXterm).toMatchObject(CAMPBELL_ANSI);
});
